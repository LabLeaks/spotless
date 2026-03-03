import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb, initSchema } from "../src/db.ts";
import { buildMemorySuffix, buildIdentitySuffix, computeTier2Allocation, injectMemorySuffix } from "../src/memory-suffix.ts";
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

describe("computeTier2Allocation", () => {
  test("both fit within budget — each gets exactly what it needs", () => {
    const result = computeTier2Allocation(2000, 3000, 12000, 2000, 2000);
    expect(result.identityBudget).toBe(2000);
    expect(result.memoryBudget).toBe(3000);
  });

  test("identity overflows — capped at total minus memory floor", () => {
    const result = computeTier2Allocation(11000, 5000, 12000, 2000, 2000);
    expect(result.identityBudget).toBe(10000); // 12000 - 2000 floor
    expect(result.memoryBudget).toBe(2000);    // floor
  });

  test("memory overflows — capped at total minus identity floor", () => {
    const result = computeTier2Allocation(3000, 11000, 12000, 2000, 2000);
    expect(result.identityBudget).toBe(2000);  // floor
    expect(result.memoryBudget).toBe(10000);   // 12000 - 2000 floor
  });

  test("both overflow massively — identity overflows first, memory gets floor", () => {
    // Both > totalBudget - otherFloor, identity overflow check fires first
    const result = computeTier2Allocation(15000, 15000, 12000, 2000, 2000);
    expect(result.identityBudget).toBe(10000);
    expect(result.memoryBudget).toBe(2000);
  });

  test("both moderately large, equal — proportional 50/50 split", () => {
    // 7000 + 7000 = 14000 > 12000, neither exceeds 10000 → proportional
    const result = computeTier2Allocation(7000, 7000, 12000, 2000, 2000);
    expect(result.identityBudget).toBe(6000);
    expect(result.memoryBudget).toBe(6000);
  });

  test("middle case: both moderately large, sum exceeds budget — proportional scaling", () => {
    // 6000 + 8000 = 14000 > 12000, but neither overflows past the other's floor
    // Proportional: identity = 6000/14000 * 12000 ≈ 5143, memory = 6857
    const result = computeTier2Allocation(6000, 8000, 12000, 2000, 2000);
    expect(result.identityBudget + result.memoryBudget).toBe(12000);
    expect(result.identityBudget).toBeGreaterThan(2000); // NOT crushed to floor
    expect(result.memoryBudget).toBeGreaterThan(2000);
    // Proportional: identity should get ~43% of budget
    expect(result.identityBudget).toBeCloseTo(5143, -2);
    expect(result.memoryBudget).toBeCloseTo(6857, -2);
  });

  test("zero identity needed — memory gets full budget", () => {
    const result = computeTier2Allocation(0, 10000, 12000, 2000, 2000);
    expect(result.identityBudget).toBe(0);
    expect(result.memoryBudget).toBe(10000);
  });

  test("zero memory needed — identity gets full budget", () => {
    const result = computeTier2Allocation(10000, 0, 12000, 2000, 2000);
    expect(result.identityBudget).toBe(10000);
    expect(result.memoryBudget).toBe(0);
  });

  test("both zero — both get zero", () => {
    const result = computeTier2Allocation(0, 0, 12000, 2000, 2000);
    expect(result.identityBudget).toBe(0);
    expect(result.memoryBudget).toBe(0);
  });

  test("uses default values when not specified", () => {
    const result = computeTier2Allocation(3000, 4000);
    expect(result.identityBudget).toBe(3000);
    expect(result.memoryBudget).toBe(4000);
  });

  test("sliding: few identity facts, many world-facts — identity gets floor, memory expands", () => {
    // 500 + 15000 = 15500 > 12000, memory overflows → identity floor (2000), memory = 12000 - 2000 = 10000
    const result = computeTier2Allocation(500, 15000, 12000, 2000, 2000);
    expect(result.identityBudget).toBe(2000);
    expect(result.memoryBudget).toBe(10000);
  });

  test("sliding: few identity facts that fit with world-facts", () => {
    // 500 + 8000 = 8500 <= 12000 → both fit exactly
    const result = computeTier2Allocation(500, 8000, 12000, 2000, 2000);
    expect(result.identityBudget).toBe(500);
    expect(result.memoryBudget).toBe(8000);
  });

  test("sliding: many identity facts, few world-facts — identity expands", () => {
    const result = computeTier2Allocation(8000, 500, 12000, 2000, 2000);
    expect(result.identityBudget).toBe(8000);
    expect(result.memoryBudget).toBe(500);
  });
});

describe("buildIdentitySuffix", () => {
  let db: Database;
  let dbPath: string;

  beforeEach(() => {
    ({ db, path: dbPath } = tempDb());
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(dbPath); } catch {}
  });

  test("no IDs returns name-only identity tag", () => {
    const result = buildIdentitySuffix(db, "nova", null, 4000);
    expect(result).toContain("<your identity>");
    expect(result).toContain("I am nova.");
    expect(result).toContain("</your identity>");
  });

  test("empty IDs returns name-only identity tag", () => {
    const result = buildIdentitySuffix(db, "nova", [], 4000);
    expect(result).toContain("I am nova.");
  });

  test("renders identity facts as bullet list", () => {
    const id1 = insertMemory(db, "I value clean minimal code", 0.85, 1000);
    const id2 = insertMemory(db, "I believe in testing first", 0.80, 2000);
    const result = buildIdentitySuffix(db, "nova", [id1, id2], 4000);
    expect(result).toContain("I am nova.");
    expect(result).toContain("- I value clean minimal code");
    expect(result).toContain("- I believe in testing first");
  });

  test("orders facts newest first (created_at DESC)", () => {
    const id1 = insertMemory(db, "first fact", 0.8, 1000);
    const id2 = insertMemory(db, "second fact", 0.8, 2000);
    const result = buildIdentitySuffix(db, "nova", [id1, id2], 4000);
    const firstIdx = result.indexOf("second fact");
    const secondIdx = result.indexOf("first fact");
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  test("budget truncation stops adding facts", () => {
    const id1 = insertMemory(db, "A".repeat(200), 0.8, 1000);
    const id2 = insertMemory(db, "B".repeat(200), 0.8, 2000);
    // Very small budget — should only fit one fact
    const result = buildIdentitySuffix(db, "nova", [id1, id2], 60);
    expect(result).toContain("I am nova.");
    // At most one fact line due to budget
    const factLines = result.split("\n").filter(l => l.startsWith("- "));
    expect(factLines.length).toBeLessThanOrEqual(1);
  });

  test("excludes archived memories", () => {
    const id1 = insertMemory(db, "active fact", 0.8);
    const id2 = insertMemory(db, "archived fact", 0.8);
    db.run("UPDATE memories SET archived_at = ? WHERE id = ?", [Date.now(), id2]);
    const result = buildIdentitySuffix(db, "nova", [id1, id2], 4000);
    expect(result).toContain("active fact");
    expect(result).not.toContain("archived fact");
  });

  test("wraps in your identity tags", () => {
    const result = buildIdentitySuffix(db, "nova", null, 4000);
    expect(result.startsWith("<your identity>")).toBe(true);
    expect(result).toContain("</your identity>");
    expect(result.endsWith("\n\n")).toBe(true);
  });
});
