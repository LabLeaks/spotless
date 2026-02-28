import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb, initSchema } from "../src/db.ts";
import { buildMemorySuffix, injectMemorySuffix } from "../src/memory-suffix.ts";
import type { Message } from "../src/types.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

function tempDb(): { db: Database; path: string } {
  const path = join(tmpdir(), `spotless-suffix-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = openDb(path);
  initSchema(db);
  return { db, path };
}

function insertMemory(db: Database, content: string, salience: number, createdAt?: number): number {
  const now = createdAt ?? Date.now();
  db.run(
    "INSERT INTO memories (content, salience, created_at, last_accessed, access_count) VALUES (?, ?, ?, ?, ?)",
    [content, salience, now, now, 0],
  );
  return (db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id;
}

describe("buildMemorySuffix", () => {
  let db: Database;
  let dbPath: string;

  beforeEach(() => {
    ({ db, path: dbPath } = tempDb());
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(dbPath); } catch {}
  });

  test("null IDs returns empty string", () => {
    expect(buildMemorySuffix(db, null)).toBe("");
  });

  test("empty IDs returns empty string", () => {
    expect(buildMemorySuffix(db, [])).toBe("");
  });

  test("nonexistent IDs returns empty string", () => {
    expect(buildMemorySuffix(db, [999, 1000])).toBe("");
  });

  test("renders memories in chronological order", () => {
    const id1 = insertMemory(db, "first fact", 0.5, 1000);
    const id2 = insertMemory(db, "second fact", 0.5, 2000);
    const result = buildMemorySuffix(db, [id2, id1]); // passed out of order
    expect(result).toContain("<relevant knowledge>");
    expect(result).toContain("</relevant knowledge>");
    const firstIdx = result.indexOf("first fact");
    const secondIdx = result.indexOf("second fact");
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  test("budget truncation stops adding memories", () => {
    const id1 = insertMemory(db, "A".repeat(100), 0.5, 1000);
    const id2 = insertMemory(db, "B".repeat(100), 0.5, 2000);
    // Very small budget — should only fit one
    const result = buildMemorySuffix(db, [id1, id2], 40);
    expect(result).toContain("A".repeat(100));
    expect(result).not.toContain("B".repeat(100));
  });

  test("wraps in relevant knowledge tags", () => {
    const id = insertMemory(db, "test fact", 0.5);
    const result = buildMemorySuffix(db, [id]);
    expect(result.startsWith("<relevant knowledge>")).toBe(true);
    expect(result).toContain("</relevant knowledge>");
    expect(result.endsWith("\n\n")).toBe(true);
  });
});

describe("injectMemorySuffix", () => {
  test("empty suffix returns original message", () => {
    const msg: Message = { role: "user", content: "hello" };
    const result = injectMemorySuffix(msg, "");
    expect(result).toBe(msg);
  });

  test("string content: prepends suffix", () => {
    const msg: Message = { role: "user", content: "hello" };
    const result = injectMemorySuffix(msg, "PREFIX ");
    expect(result.content).toBe("PREFIX hello");
    expect(result.role).toBe("user");
  });

  test("does not mutate original message", () => {
    const msg: Message = { role: "user", content: "hello" };
    injectMemorySuffix(msg, "PREFIX ");
    expect(msg.content).toBe("hello");
  });

  test("array content: prepends to first text block", () => {
    const msg: Message = {
      role: "user",
      content: [
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ],
    };
    const result = injectMemorySuffix(msg, "PREFIX ");
    expect(Array.isArray(result.content)).toBe(true);
    const blocks = result.content as { type: string; text?: string }[];
    expect(blocks[0]!.text).toBe("PREFIX hello");
    expect(blocks[1]!.text).toBe("world"); // unchanged
  });

  test("array content with no text block: inserts new text block", () => {
    const msg: Message = {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "x", content: "result" },
      ],
    };
    const result = injectMemorySuffix(msg, "PREFIX ");
    const blocks = result.content as { type: string; text?: string }[];
    expect(blocks[0]!.type).toBe("text");
    expect(blocks[0]!.text).toBe("PREFIX ");
  });

  test("does not mutate original array content", () => {
    const msg: Message = {
      role: "user",
      content: [{ type: "text", text: "hello" }],
    };
    injectMemorySuffix(msg, "PREFIX ");
    const blocks = msg.content as { type: string; text?: string }[];
    expect(blocks[0]!.text).toBe("hello");
  });
});
