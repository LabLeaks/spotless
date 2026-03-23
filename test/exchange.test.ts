import { test, expect, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb, initSchema } from "../src/db.ts";
import {
  summarizeToolResult,
  generateLevel1,
  finalizeExchange,
  reconstructExchange,
  listExchanges,
  getExchangeLevel,
  hasLevel1,
  detectExchangeBoundaries,
} from "../src/exchange.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

function tempDb(): { db: Database; path: string } {
  const path = join(tmpdir(), `spotless-exchange-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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

function insertBoundary(db: Database, group: number) {
  db.run(
    "INSERT INTO raw_events (timestamp, message_group, role, content_type, content, is_subagent, metadata, consolidated) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
    [Date.now(), group, "user", "text", "<session-boundary />", 0, null],
  );
}

const cleanup: string[] = [];

afterEach(() => {
  for (const p of cleanup) {
    try { unlinkSync(p); } catch {}
    try { unlinkSync(p + "-wal"); } catch {}
    try { unlinkSync(p + "-shm"); } catch {}
  }
  cleanup.length = 0;
});

// --- summarizeToolResult ---

describe("summarizeToolResult", () => {
  test("Read tool summary includes path, line count, and language", () => {
    const result = summarizeToolResult(
      "Read",
      { file_path: "src/proxy.ts" },
      "line1\nline2\nline3\n",
    );
    expect(result).toBe("[Read src/proxy.ts — 4 lines, TypeScript]");
  });

  test("Edit tool summary shows char counts", () => {
    const result = summarizeToolResult(
      "Edit",
      { file_path: "src/db.ts", old_string: "hello", new_string: "world!" },
      "ok",
    );
    expect(result).toBe("[Edit src/db.ts — replaced 5→6 chars]");
  });

  test("Write tool summary shows line count", () => {
    const result = summarizeToolResult(
      "Write",
      { file_path: "test.py", content: "a\nb\nc" },
      "ok",
    );
    expect(result).toBe("[Write test.py — 3 lines]");
  });

  test("Grep tool summary shows match count", () => {
    const result = summarizeToolResult(
      "Grep",
      { pattern: "cache_control" },
      "src/proxy.ts:630\nsrc/proxy.ts:634\nsrc/history.ts:10\n",
    );
    expect(result).toBe("[Grep 'cache_control' — 3 matches]");
  });

  test("Glob tool summary shows file count", () => {
    const result = summarizeToolResult(
      "Glob",
      { pattern: "**/*.ts" },
      "src/proxy.ts\nsrc/db.ts\n",
    );
    expect(result).toBe("[Glob '**/*.ts' — 2 files]");
  });

  test("Bash tool summary shows command and line count", () => {
    const result = summarizeToolResult(
      "Bash",
      { command: "git status" },
      "On branch master\nnothing to commit\n",
    );
    expect(result).toBe("[Bash 'git status' — 3 lines output]");
  });

  test("Agent tool summary shows description", () => {
    const result = summarizeToolResult(
      "Agent",
      { description: "explore codebase" },
      "done",
    );
    expect(result).toBe("[Agent 'explore codebase' — completed]");
  });

  test("unknown tool truncates result", () => {
    const longContent = "x".repeat(500);
    const result = summarizeToolResult("CustomTool", {}, longContent);
    expect(result).toContain("[CustomTool —");
    expect(result).toContain("[...500 chars]");
  });

  test("Read with unknown extension omits language", () => {
    const result = summarizeToolResult(
      "Read",
      { file_path: "Makefile" },
      "all:\n\techo hi\n",
    );
    expect(result).toBe("[Read Makefile — 3 lines]");
  });
});

// --- generateLevel1 ---

describe("generateLevel1", () => {
  test("generates summary for simple text exchange", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    insertEvent(db, 1, "user", "text", "What is Spotless?");
    insertEvent(db, 2, "assistant", "text", "Spotless is a persistent memory system.");

    const result = generateLevel1(db, 1, 2);
    expect(result).not.toBeNull();
    expect(result!.userText).toBe("What is Spotless?");
    expect(result!.assistantText).toBe("Spotless is a persistent memory system.");
    expect(result!.tokens).toBeGreaterThan(0);

    db.close();
  });

  test("replaces tool_result with structural summary", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const toolId = "toolu_abc123";

    // User asks
    insertEvent(db, 1, "user", "text", "Read the proxy");
    // Assistant calls Read tool
    insertEvent(db, 2, "assistant", "tool_use", JSON.stringify({ file_path: "src/proxy.ts" }), 0, { tool_name: "Read", tool_id: toolId });
    // Tool result
    insertEvent(db, 3, "user", "tool_result", "line1\nline2\nline3\n", 0, { tool_use_id: toolId });
    // Assistant responds
    insertEvent(db, 4, "assistant", "text", "The proxy handles requests.");

    const result = generateLevel1(db, 1, 4);
    expect(result).not.toBeNull();
    expect(result!.userText).toBe("Read the proxy");
    expect(result!.assistantText).toContain("[Read src/proxy.ts");
    expect(result!.assistantText).toContain("The proxy handles requests.");
    // Should NOT contain raw tool result content
    expect(result!.assistantText).not.toContain("line1\nline2\nline3");

    db.close();
  });

  test("handles multiple tool calls in one exchange", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    insertEvent(db, 1, "user", "text", "Check the code");
    // First tool: Read
    insertEvent(db, 2, "assistant", "tool_use", JSON.stringify({ file_path: "a.ts" }), 0, { tool_name: "Read", tool_id: "t1" });
    insertEvent(db, 3, "user", "tool_result", "contents of a\n", 0, { tool_use_id: "t1" });
    // Second tool: Grep
    insertEvent(db, 4, "assistant", "tool_use", JSON.stringify({ pattern: "foo" }), 0, { tool_name: "Grep", tool_id: "t2" });
    insertEvent(db, 5, "user", "tool_result", "a.ts:10:foo\nb.ts:20:foo\n", 0, { tool_use_id: "t2" });
    // Final response
    insertEvent(db, 6, "assistant", "text", "Found it.");

    const result = generateLevel1(db, 1, 6);
    expect(result).not.toBeNull();
    expect(result!.assistantText).toContain("[Read a.ts");
    expect(result!.assistantText).toContain("[Grep 'foo'");
    expect(result!.assistantText).toContain("Found it.");

    db.close();
  });

  test("excludes subagent events", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    insertEvent(db, 1, "user", "text", "Hello");
    insertEvent(db, 2, "assistant", "text", "Hi", 1); // subagent
    insertEvent(db, 3, "assistant", "text", "Main response");

    const result = generateLevel1(db, 1, 3);
    expect(result).not.toBeNull();
    expect(result!.assistantText).toBe("Main response");
    expect(result!.assistantText).not.toContain("Hi");

    db.close();
  });

  test("excludes thinking blocks", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    insertEvent(db, 1, "user", "text", "Think about this");
    insertEvent(db, 2, "assistant", "thinking", "internal reasoning...");
    insertEvent(db, 3, "assistant", "text", "Here's my answer.");

    const result = generateLevel1(db, 1, 3);
    expect(result).not.toBeNull();
    expect(result!.assistantText).toBe("Here's my answer.");
    expect(result!.assistantText).not.toContain("internal reasoning");

    db.close();
  });

  test("excludes system reminders", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    insertEvent(db, 1, "user", "text", "Question");
    insertEvent(db, 1, "user", "text", "<system-reminder>some reminder</system-reminder>");
    insertEvent(db, 2, "assistant", "text", "Answer");

    const result = generateLevel1(db, 1, 2);
    expect(result).not.toBeNull();
    expect(result!.userText).toBe("Question");
    expect(result!.userText).not.toContain("system-reminder");

    db.close();
  });

  test("returns null for empty group range", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const result = generateLevel1(db, 100, 200);
    expect(result).toBeNull();

    db.close();
  });

  test("handles unmatched tool_result gracefully", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    insertEvent(db, 1, "user", "text", "Do something");
    // tool_result without matching tool_use
    insertEvent(db, 2, "user", "tool_result", "orphaned result content", 0, { tool_use_id: "missing_id" });
    insertEvent(db, 3, "assistant", "text", "Done");

    const result = generateLevel1(db, 1, 3);
    expect(result).not.toBeNull();
    expect(result!.assistantText).toContain("[tool result");
    expect(result!.assistantText).toContain("Done");

    db.close();
  });
});

// --- finalizeExchange ---

describe("finalizeExchange", () => {
  test("stores Level 1 in exchange_levels table", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    insertEvent(db, 1, "user", "text", "Hello");
    insertEvent(db, 2, "assistant", "text", "Hi there");

    const stored = finalizeExchange(db, 1, 2, 0);
    expect(stored).toBe(true);

    const level = getExchangeLevel(db, 1, 2, 1);
    expect(level).not.toBeNull();
    expect(level!.sessionId).toBe(0);
    expect(level!.tokens).toBeGreaterThan(0);

    const parsed = JSON.parse(level!.content);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].role).toBe("user");
    expect(parsed[1].role).toBe("assistant");

    db.close();
  });

  test("returns false for invalid range", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const stored = finalizeExchange(db, 10, 5, 0);
    expect(stored).toBe(false);

    db.close();
  });

  test("is idempotent (INSERT OR REPLACE)", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    insertEvent(db, 1, "user", "text", "Hello");
    insertEvent(db, 2, "assistant", "text", "Hi");

    finalizeExchange(db, 1, 2, 0);
    finalizeExchange(db, 1, 2, 0);

    const exchanges = listExchanges(db);
    expect(exchanges).toHaveLength(1);

    db.close();
  });
});

// --- reconstructExchange ---

describe("reconstructExchange", () => {
  test("reconstructs simple text exchange", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    insertEvent(db, 1, "user", "text", "Hello");
    insertEvent(db, 2, "assistant", "text", "Hi there");

    const messages = reconstructExchange(db, 1, 2);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toBe("Hello");
    expect(messages[1]!.role).toBe("assistant");
    expect(messages[1]!.content).toBe("Hi there");

    db.close();
  });

  test("reconstructs exchange with tool_use/tool_result pairs", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const toolId = "toolu_xyz";

    insertEvent(db, 1, "user", "text", "Read file");
    insertEvent(db, 2, "assistant", "tool_use", JSON.stringify({ file_path: "a.ts" }), 0, { tool_name: "Read", tool_id: toolId });
    insertEvent(db, 3, "user", "tool_result", "file contents", 0, { tool_use_id: toolId });
    insertEvent(db, 4, "assistant", "text", "I read the file.");

    const messages = reconstructExchange(db, 1, 4);
    expect(messages).toHaveLength(4);
    expect(messages[0]!.role).toBe("user");
    expect(messages[1]!.role).toBe("assistant");
    expect(messages[2]!.role).toBe("user");
    expect(messages[3]!.role).toBe("assistant");

    // tool_use block present
    const assistantBlocks = messages[1]!.content as any[];
    expect(assistantBlocks.some((b: any) => b.type === "tool_use")).toBe(true);

    // tool_result block present
    const userBlocks = messages[2]!.content as any[];
    expect(userBlocks.some((b: any) => b.type === "tool_result")).toBe(true);

    db.close();
  });

  test("skips orphaned tool_result", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    insertEvent(db, 1, "user", "text", "Hello");
    insertEvent(db, 2, "user", "tool_result", "orphan", 0, { tool_use_id: "missing" });
    insertEvent(db, 3, "assistant", "text", "Response");

    const messages = reconstructExchange(db, 1, 3);
    // The orphaned tool_result should be skipped
    const allContent = messages.map(m =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    ).join(" ");
    expect(allContent).not.toContain("orphan");
    expect(allContent).toContain("Hello");
    expect(allContent).toContain("Response");

    db.close();
  });

  test("returns empty array for non-existent range", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const messages = reconstructExchange(db, 100, 200);
    expect(messages).toHaveLength(0);

    db.close();
  });

  test("excludes subagent events", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    insertEvent(db, 1, "user", "text", "Hello");
    insertEvent(db, 2, "assistant", "text", "subagent response", 1);
    insertEvent(db, 3, "assistant", "text", "main response");

    const messages = reconstructExchange(db, 1, 3);
    const allContent = messages.map(m =>
      typeof m.content === "string" ? m.content : ""
    ).join(" ");
    expect(allContent).toContain("main response");
    expect(allContent).not.toContain("subagent response");

    db.close();
  });
});

// --- hasLevel1 ---

describe("hasLevel1", () => {
  test("returns false when no Level 1 exists", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    expect(hasLevel1(db, 1, 2)).toBe(false);

    db.close();
  });

  test("returns true after finalization", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    insertEvent(db, 1, "user", "text", "Hello");
    insertEvent(db, 2, "assistant", "text", "Hi");
    finalizeExchange(db, 1, 2, 0);

    expect(hasLevel1(db, 1, 2)).toBe(true);

    db.close();
  });
});

// --- detectExchangeBoundaries ---

describe("detectExchangeBoundaries", () => {
  test("detects boundaries for a simple conversation", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    // Exchange 1: groups 1-2
    insertEvent(db, 1, "user", "text", "Hello");
    insertEvent(db, 2, "assistant", "text", "Hi");
    // Exchange 2: groups 3-4
    insertEvent(db, 3, "user", "text", "How are you?");
    insertEvent(db, 4, "assistant", "text", "Good");

    const exchanges = detectExchangeBoundaries(db);
    expect(exchanges).toHaveLength(2);
    expect(exchanges[0]).toEqual({ startGroup: 1, endGroup: 2, sessionId: 0 });
    expect(exchanges[1]).toEqual({ startGroup: 3, endGroup: 4, sessionId: 0 });

    db.close();
  });

  test("handles tool loops within an exchange", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const toolId = "toolu_1";

    // Exchange 1: user + tool loop + response (groups 1-6)
    insertEvent(db, 1, "user", "text", "Read the file");
    insertEvent(db, 2, "assistant", "tool_use", JSON.stringify({ file_path: "a.ts" }), 0, { tool_name: "Read", tool_id: toolId });
    insertEvent(db, 3, "user", "tool_result", "file contents", 0, { tool_use_id: toolId });
    insertEvent(db, 4, "assistant", "text", "Done");
    // Exchange 2: groups 5-6
    insertEvent(db, 5, "user", "text", "Thanks");
    insertEvent(db, 6, "assistant", "text", "You're welcome");

    const exchanges = detectExchangeBoundaries(db);
    expect(exchanges).toHaveLength(2);
    // First exchange includes the tool loop
    expect(exchanges[0]).toEqual({ startGroup: 1, endGroup: 4, sessionId: 0 });
    expect(exchanges[1]).toEqual({ startGroup: 5, endGroup: 6, sessionId: 0 });

    db.close();
  });

  test("assigns correct session IDs across boundaries", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    // Session 0
    insertEvent(db, 1, "user", "text", "First session message");
    insertEvent(db, 2, "assistant", "text", "Response");
    // Session boundary
    insertBoundary(db, 3);
    // Session 1
    insertEvent(db, 4, "user", "text", "Second session message");
    insertEvent(db, 5, "assistant", "text", "Response 2");

    const exchanges = detectExchangeBoundaries(db);
    expect(exchanges).toHaveLength(2);
    expect(exchanges[0]!.sessionId).toBe(0);
    expect(exchanges[1]!.sessionId).toBe(1);

    db.close();
  });

  test("returns empty for no human turns", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    // Only assistant messages (shouldn't happen but handle gracefully)
    insertEvent(db, 1, "assistant", "text", "Hello");

    const exchanges = detectExchangeBoundaries(db);
    expect(exchanges).toHaveLength(0);

    db.close();
  });

  test("excludes tool_result-only user groups from being exchange starts", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    // Exchange 1: human turn + tool loop
    insertEvent(db, 1, "user", "text", "Do something");
    insertEvent(db, 2, "assistant", "tool_use", JSON.stringify({}), 0, { tool_name: "Read", tool_id: "t1" });
    // Group 3 is user tool_result only — NOT a new exchange
    insertEvent(db, 3, "user", "tool_result", "result", 0, { tool_use_id: "t1" });
    insertEvent(db, 4, "assistant", "text", "Done");

    const exchanges = detectExchangeBoundaries(db);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]).toEqual({ startGroup: 1, endGroup: 4, sessionId: 0 });

    db.close();
  });
});

// --- listExchanges ---

describe("listExchanges", () => {
  test("lists exchanges in order", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    insertEvent(db, 1, "user", "text", "First");
    insertEvent(db, 2, "assistant", "text", "Response 1");
    finalizeExchange(db, 1, 2, 0);

    insertEvent(db, 3, "user", "text", "Second");
    insertEvent(db, 4, "assistant", "text", "Response 2");
    finalizeExchange(db, 3, 4, 0);

    const exchanges = listExchanges(db);
    expect(exchanges).toHaveLength(2);
    expect(exchanges[0]!.startGroup).toBe(1);
    expect(exchanges[1]!.startGroup).toBe(3);

    db.close();
  });
});

// --- Level 1 token estimation accuracy ---

describe("Level 1 token estimation", () => {
  test("token estimate is within 20% of naive estimate", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    insertEvent(db, 1, "user", "text", "Explain the architecture of the proxy module in detail.");
    insertEvent(db, 2, "assistant", "text", "The proxy module consists of several key components that work together to intercept and modify API requests.");

    const result = generateLevel1(db, 1, 2);
    expect(result).not.toBeNull();

    // Manual estimate: chars / 4
    const expectedTokens = Math.ceil(
      (result!.userText.length + result!.assistantText.length) / 4
    ) + 8;
    const ratio = result!.tokens / expectedTokens;
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(1.2);

    db.close();
  });
});
