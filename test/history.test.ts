import { test, expect, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb, initSchema } from "../src/db.ts";
import { buildHistory } from "../src/history.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

function tempDb(): { db: Database; path: string } {
  const path = join(tmpdir(), `spotless-history-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = openDb(path);
  initSchema(db);
  return { db, path };
}

function insertEvent(
  db: Database,
  group: number,
  role: string,
  contentType: string,
  content: string,
  isSubagent = 0,
  metadata: Record<string, string> | null = null,
) {
  db.run(
    "INSERT INTO raw_events (timestamp, message_group, role, content_type, content, is_subagent, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [Date.now(), group, role, contentType, content, isSubagent, metadata ? JSON.stringify(metadata) : null],
  );
}

describe("history trace: tool pairing", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const p of cleanup) {
      try { unlinkSync(p); } catch {}
      try { unlinkSync(p + "-wal"); } catch {}
      try { unlinkSync(p + "-shm"); } catch {}
    }
    cleanup.length = 0;
  });

  test("orphaned tool_result is skipped (no preceding tool_use)", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    // Group 1: normal user message
    insertEvent(db, 1, "user", "text", "hello");
    // Group 2: normal assistant response
    insertEvent(db, 2, "assistant", "text", "hi there");
    // Group 3: orphaned tool_result (tool_use was in a different session or subagent)
    insertEvent(db, 3, "user", "tool_result", "some tool output", 0, { tool_use_id: "toolu_orphaned" });
    // Group 4: normal user message after the orphan
    insertEvent(db, 4, "user", "text", "continue please");
    // Group 5: normal assistant response
    insertEvent(db, 5, "assistant", "text", "sure, continuing");

    const { messages: trace } = buildHistory(db, 100_000);

    // The orphaned tool_result should be excluded
    const allContent = trace.map(m => {
      if (typeof m.content === "string") return m.content;
      return m.content.map(b => "text" in b ? b.text : b.type).join(" ");
    }).join(" ");

    expect(allContent).not.toContain("some tool output");
    expect(allContent).toContain("hello");
    expect(allContent).toContain("continue please");

    db.close();
  });

  test("valid tool_use/tool_result pair is preserved", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const toolId = "toolu_valid123";

    // Group 1: user asks something
    insertEvent(db, 1, "user", "text", "do something");
    // Group 2: assistant uses a tool
    insertEvent(db, 2, "assistant", "tool_use", '{"action":"test"}', 0, { tool_name: "TestTool", tool_id: toolId });
    // Group 3: tool result
    insertEvent(db, 3, "user", "tool_result", "tool succeeded", 0, { tool_use_id: toolId });
    // Group 4: assistant responds
    insertEvent(db, 4, "assistant", "text", "the tool worked");

    const { messages: trace } = buildHistory(db, 100_000);

    const allContent = trace.map(m => {
      if (typeof m.content === "string") return m.content;
      return m.content.map(b => {
        if ("text" in b) return b.text;
        if (b.type === "tool_use") return "tool_use:" + (b as any).name;
        if (b.type === "tool_result") return "tool_result:" + ((b as any).content ?? "");
        return b.type;
      }).join(" ");
    }).join(" | ");

    expect(allContent).toContain("tool_use:TestTool");
    expect(allContent).toContain("tool succeeded");
    expect(allContent).toContain("the tool worked");

    db.close();
  });

  test("tool_use from old session + tool_result from new session are both skipped", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const toolId = "toolu_cross_session";

    // Old session: tool_use without result (session interrupted)
    insertEvent(db, 1, "user", "text", "old question");
    insertEvent(db, 2, "assistant", "tool_use", '{}', 0, { tool_name: "OldTool", tool_id: toolId });
    // Session boundary (no content rows in this group)
    db.run(
      "INSERT INTO raw_events (timestamp, message_group, role, content_type, content, is_subagent) VALUES (?, ?, ?, ?, ?, ?)",
      [Date.now(), 3, "user", "text", "<session-boundary />", 0],
    );
    // New session: orphaned tool_result
    insertEvent(db, 4, "user", "tool_result", "stale result", 0, { tool_use_id: toolId });
    // New session: normal conversation
    insertEvent(db, 5, "user", "text", "new question");
    insertEvent(db, 6, "assistant", "text", "new answer");

    const { messages: trace } = buildHistory(db, 100_000);

    const allContent = trace.map(m => {
      if (typeof m.content === "string") return m.content;
      return m.content.map(b => "text" in b ? b.text : b.type).join(" ");
    }).join(" ");

    // Neither the orphaned tool_use nor the orphaned tool_result should appear
    expect(allContent).not.toContain("OldTool");
    expect(allContent).not.toContain("stale result");
    // Normal content should be present
    expect(allContent).toContain("new question");
    expect(allContent).toContain("new answer");

    db.close();
  });

  test("session boundary between tool_use and tool_result does not inject divider into tool_result", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const toolId = "toolu_boundary_test";

    // Group 1: user message
    insertEvent(db, 1, "user", "text", "check something");
    // Group 2: assistant uses tool
    insertEvent(db, 2, "assistant", "tool_use", '{"cmd":"ls"}', 0, { tool_name: "Bash", tool_id: toolId });
    // Group 3: session boundary (from subagent sessions leaking into main)
    db.run(
      "INSERT INTO raw_events (timestamp, message_group, role, content_type, content, is_subagent) VALUES (?, ?, ?, ?, ?, ?)",
      [Date.now(), 3, "user", "text", "<session-boundary />", 0],
    );
    // Group 4: tool result (same tool_id, valid pair)
    insertEvent(db, 4, "user", "tool_result", "file1.txt\nfile2.txt", 0, { tool_use_id: toolId });
    // Group 5: assistant responds
    insertEvent(db, 5, "assistant", "text", "I found the files");
    // Group 6: user follows up
    insertEvent(db, 6, "user", "text", "thanks for checking");
    // Group 7: assistant responds
    insertEvent(db, 7, "assistant", "text", "you're welcome");

    const { messages: trace } = buildHistory(db, 100_000);

    // The tool_result message should NOT have "--- new session ---" text mixed in
    for (const msg of trace) {
      if (typeof msg.content !== "string") {
        const hasToolResult = msg.content.some(b => b.type === "tool_result");
        const hasText = msg.content.some(b => b.type === "text");
        if (hasToolResult && hasText) {
          // If there's text alongside tool_result, it should NOT be a session divider
          const textBlocks = msg.content.filter(b => b.type === "text" && "text" in b);
          for (const tb of textBlocks) {
            expect((tb as any).text).not.toContain("--- new session ---");
          }
        }
      }
    }

    // The session divider should appear on the next text-only user message instead
    const allContent = trace.map(m => {
      if (typeof m.content === "string") return m.content;
      return m.content.map(b => "text" in b ? (b as any).text : b.type).join(" ");
    }).join(" | ");

    expect(allContent).toContain("I found the files");
    expect(allContent).toContain("thanks for checking");

    db.close();
  });

  test("agent name appears in preamble", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    insertEvent(db, 1, "user", "text", "hello");
    insertEvent(db, 2, "assistant", "text", "hi");

    const { messages: trace } = buildHistory(db, 100_000, "nova");

    // Preamble should mention the agent name
    const preamble = trace[0];
    expect(typeof preamble?.content).toBe("string");
    expect(preamble?.content as string).toContain("nova");

    // Assistant acknowledgment should too
    const ack = trace[1];
    expect(typeof ack?.content).toBe("string");
    expect(ack?.content as string).toContain("nova");

    db.close();
  });
});

describe("history trace: trimmedCount", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const p of cleanup) {
      try { unlinkSync(p); } catch {}
      try { unlinkSync(p + "-wal"); } catch {}
      try { unlinkSync(p + "-shm"); } catch {}
    }
    cleanup.length = 0;
  });

  test("reports trimmed count when budget forces trimming", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    // Insert 20 message pairs (40 messages total) with substantial content
    for (let i = 1; i <= 20; i++) {
      const group = i * 2 - 1;
      insertEvent(db, group, "user", "text", `User message ${i} with some padding text to consume tokens: ${"x".repeat(200)}`);
      insertEvent(db, group + 1, "assistant", "text", `Assistant response ${i} with padding: ${"y".repeat(200)}`);
    }

    // Use a tiny budget that can't fit all messages
    const { messages, trimmedCount } = buildHistory(db, 1000);

    expect(trimmedCount).toBeGreaterThan(0);
    // Should still have some messages (not all trimmed)
    expect(messages.length).toBeGreaterThan(0);
    // Trimmed + remaining should account for all messages (preamble adds 2)
    expect(messages.length).toBeLessThan(42); // 40 content + 2 preamble

    db.close();
  });

  test("reports zero trimmedCount when all messages fit", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    insertEvent(db, 1, "user", "text", "hello");
    insertEvent(db, 2, "assistant", "text", "hi");

    const { messages, trimmedCount } = buildHistory(db, 100_000);

    expect(trimmedCount).toBe(0);
    // Preamble (2) + content (2) = 4 messages
    expect(messages.length).toBe(4);

    db.close();
  });

  test("empty database returns zero trimmedCount", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const { messages, trimmedCount } = buildHistory(db, 100_000);

    expect(trimmedCount).toBe(0);
    expect(messages.length).toBe(0);

    db.close();
  });

  test("duplicate tool_use_id pairs are deduplicated", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const toolId = "toolu_duplicate_test";

    // Group 1: user asks something
    insertEvent(db, 1, "user", "text", "read the file");

    // Group 2: assistant calls a tool
    insertEvent(db, 2, "assistant", "tool_use", '{"path": "foo.txt"}', 0, { tool_id: toolId, tool_name: "Read" });

    // Group 3: user provides tool_result
    insertEvent(db, 3, "user", "tool_result", "file contents here", 0, { tool_use_id: toolId });

    // Group 4: assistant responds
    insertEvent(db, 4, "assistant", "text", "I see the file");

    // Groups 5-6: DUPLICATE — same tool_use_id archived again (from retried request)
    insertEvent(db, 5, "assistant", "tool_use", '{"path": "foo.txt"}', 0, { tool_id: toolId, tool_name: "Read" });
    insertEvent(db, 6, "user", "tool_result", "file contents here", 0, { tool_use_id: toolId });

    // Group 7: assistant responds again
    insertEvent(db, 7, "assistant", "text", "still the same file");

    const { messages: trace } = buildHistory(db, 100_000);

    // Count tool_result blocks — should be exactly 1 (duplicate pair skipped)
    let toolResultCount = 0;
    for (const msg of trace) {
      if (typeof msg.content !== "string") {
        toolResultCount += msg.content.filter(b => b.type === "tool_result").length;
      }
    }
    expect(toolResultCount).toBe(1);

    // The text content from both assistants should still be present
    const textContent = trace
      .filter(m => typeof m.content === "string")
      .map(m => m.content as string)
      .join(" ");
    expect(textContent).toContain("I see the file");

    db.close();
  });

  test("trimming does not orphan tool_result at front of trace", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    // Create a tool_use/tool_result pair early in the trace
    insertEvent(db, 1, "user", "text", "read a file");
    insertEvent(db, 2, "assistant", "tool_use", '{"path": "big.txt"}', 0, { tool_id: "toolu_early", tool_name: "Read" });
    insertEvent(db, 3, "user", "tool_result", "x".repeat(500), 0, { tool_use_id: "toolu_early" });
    insertEvent(db, 4, "assistant", "text", "got it");

    // Add many more messages so the tool pair gets trimmed from front
    for (let i = 5; i <= 30; i += 2) {
      insertEvent(db, i, "user", "text", `msg ${i} ${"z".repeat(200)}`);
      insertEvent(db, i + 1, "assistant", "text", `reply ${i} ${"w".repeat(200)}`);
    }

    // Use a budget that trims the early tool pair
    const { messages: trace } = buildHistory(db, 2000);

    // The first content message (after preamble) must not be an orphaned tool_result
    // Find first non-preamble user message
    for (const msg of trace) {
      if (msg.role === "user" && typeof msg.content !== "string") {
        const hasToolResult = msg.content.some(b => b.type === "tool_result");
        if (hasToolResult) {
          // This tool_result must have a matching tool_use in the preceding assistant
          const idx = trace.indexOf(msg);
          expect(idx).toBeGreaterThan(0);
          const prev = trace[idx - 1]!;
          expect(prev.role).toBe("assistant");
        }
      }
    }

    db.close();
  });
});
