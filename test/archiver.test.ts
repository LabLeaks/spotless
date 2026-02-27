import { test, expect, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb, initSchema } from "../src/db.ts";
import { archiveUserMessage, archiveAssistantResponse, StreamTap } from "../src/archiver.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import type { Message } from "../src/types.ts";

function tempDb(): { db: Database; path: string } {
  const path = join(tmpdir(), `spotless-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = openDb(path);
  initSchema(db);
  return { db, path };
}

describe("archiveUserMessage", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const p of cleanup) {
      try { unlinkSync(p); } catch {}
      try { unlinkSync(p + "-wal"); } catch {}
      try { unlinkSync(p + "-shm"); } catch {}
    }
    cleanup.length = 0;
  });

  test("archives a simple text message", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const msg: Message = { role: "user", content: "Hello world" };
    archiveUserMessage(db, msg, 1, false);

    const rows = db.query("SELECT * FROM raw_events").all() as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.role).toBe("user");
    expect(rows[0]!.content_type).toBe("text");
    expect(rows[0]!.content).toBe("Hello world");
    expect(rows[0]!.message_group).toBe(1);
    expect(rows[0]!.is_subagent).toBe(0);

    db.close();
  });

  test("archives tool_result content blocks", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const msg: Message = {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_01", content: "file contents here" },
      ],
    };
    archiveUserMessage(db, msg, 2, false);

    const rows = db.query("SELECT * FROM raw_events").all() as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.content_type).toBe("tool_result");
    expect(rows[0]!.content).toBe("file contents here");
    expect(JSON.parse(rows[0]!.metadata as string)).toEqual({ tool_use_id: "toolu_01" });

    db.close();
  });

  test("archives subagent content with flag", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const msg: Message = { role: "user", content: "Research this topic" };
    archiveUserMessage(db, msg, 3, true);

    const rows = db.query("SELECT * FROM raw_events").all() as Array<Record<string, unknown>>;
    expect(rows[0]!.is_subagent).toBe(1);

    db.close();
  });
});

describe("archiveAssistantResponse", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const p of cleanup) {
      try { unlinkSync(p); } catch {}
      try { unlinkSync(p + "-wal"); } catch {}
      try { unlinkSync(p + "-shm"); } catch {}
    }
    cleanup.length = 0;
  });

  test("archives multiple content blocks", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    archiveAssistantResponse(
      db,
      [
        { type: "thinking", content: "Let me think..." },
        { type: "text", content: "Here's my answer" },
        { type: "tool_use", content: '{"path":"foo.ts"}', metadata: { tool_name: "Read", tool_id: "toolu_01" } },
      ],
      4,
      false,
    );

    const rows = db.query("SELECT * FROM raw_events ORDER BY id").all() as Array<Record<string, unknown>>;
    expect(rows.length).toBe(3);
    expect(rows[0]!.content_type).toBe("thinking");
    expect(rows[1]!.content_type).toBe("text");
    expect(rows[2]!.content_type).toBe("tool_use");

    // All share the same message_group
    expect(rows[0]!.message_group).toBe(4);
    expect(rows[1]!.message_group).toBe(4);
    expect(rows[2]!.message_group).toBe(4);

    // All are assistant role
    expect(rows[0]!.role).toBe("assistant");

    db.close();
  });
});

describe("StreamTap", () => {
  test("captures text content from SSE events", () => {
    const tap = new StreamTap();

    tap.processSSEEvent({ type: "content_block_start", index: 0, content_block: { type: "text" } });
    tap.processSSEEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } });
    tap.processSSEEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } });
    tap.processSSEEvent({ type: "content_block_stop", index: 0 });

    const blocks = tap.getBlocks();
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.type).toBe("text");
    expect(blocks[0]!.content).toBe("Hello world");
  });

  test("captures tool_use with metadata", () => {
    const tap = new StreamTap();

    tap.processSSEEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_01", name: "Read" },
    });
    tap.processSSEEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"path":' },
    });
    tap.processSSEEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '"foo.ts"}' },
    });
    tap.processSSEEvent({ type: "content_block_stop", index: 0 });

    const blocks = tap.getBlocks();
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.type).toBe("tool_use");
    expect(blocks[0]!.content).toBe('{"path":"foo.ts"}');
    expect(blocks[0]!.metadata).toEqual({ tool_name: "Read", tool_id: "toolu_01" });
  });

  test("captures stop_reason from message_delta", () => {
    const tap = new StreamTap();

    tap.processSSEEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } });
    expect(tap.stopReason).toBe("end_turn");
  });

  test("captures thinking blocks", () => {
    const tap = new StreamTap();

    tap.processSSEEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking" } });
    tap.processSSEEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } });
    tap.processSSEEvent({ type: "content_block_stop", index: 0 });

    const blocks = tap.getBlocks();
    expect(blocks[0]!.type).toBe("thinking");
    expect(blocks[0]!.content).toBe("hmm");
  });

  test("handles multiple content blocks in sequence", () => {
    const tap = new StreamTap();

    // Block 0: thinking
    tap.processSSEEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking" } });
    tap.processSSEEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reasoning" } });
    tap.processSSEEvent({ type: "content_block_stop", index: 0 });

    // Block 1: text
    tap.processSSEEvent({ type: "content_block_start", index: 1, content_block: { type: "text" } });
    tap.processSSEEvent({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } });
    tap.processSSEEvent({ type: "content_block_stop", index: 1 });

    // Block 2: tool_use
    tap.processSSEEvent({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "t1", name: "Bash" } });
    tap.processSSEEvent({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"cmd":"ls"}' } });
    tap.processSSEEvent({ type: "content_block_stop", index: 2 });

    const blocks = tap.getBlocks();
    expect(blocks.length).toBe(3);
    expect(blocks[0]!.type).toBe("thinking");
    expect(blocks[1]!.type).toBe("text");
    expect(blocks[2]!.type).toBe("tool_use");
  });
});
