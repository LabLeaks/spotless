import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb, initSchema } from "../src/db.ts";
import { parseMemoryIds, extractProjectIdentity, sortByCreatedAt } from "../src/selector.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

function tempDb(): { db: Database; path: string } {
  const path = join(tmpdir(), `spotless-selector-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = openDb(path);
  initSchema(db);
  return { db, path };
}

describe("parseMemoryIds", () => {
  test("clean JSON object", () => {
    const ids = parseMemoryIds('{"memory_ids": [3, 17, 42]}');
    expect(ids).toEqual([3, 17, 42]);
  });

  test("fenced JSON", () => {
    const ids = parseMemoryIds('```json\n{"memory_ids": [1, 2, 3]}\n```');
    expect(ids).toEqual([1, 2, 3]);
  });

  test("JSON embedded in prose", () => {
    const ids = parseMemoryIds('Based on the analysis, I recommend:\n{"memory_ids": [5, 10]}\nThese are the most relevant.');
    expect(ids).toEqual([5, 10]);
  });

  test("empty memory_ids array returns empty", () => {
    const ids = parseMemoryIds('{"memory_ids": []}');
    expect(ids).toEqual([]);
  });

  test("non-integer values are filtered out", () => {
    const ids = parseMemoryIds('{"memory_ids": [1, "two", 3, null]}');
    expect(ids).toEqual([1, 3]);
  });

  test("garbage input returns empty", () => {
    expect(parseMemoryIds("totally invalid")).toEqual([]);
    expect(parseMemoryIds("")).toEqual([]);
  });

  test("missing memory_ids key returns empty", () => {
    expect(parseMemoryIds('{"other_key": [1, 2]}')).toEqual([]);
  });
});

describe("extractProjectIdentity", () => {
  test("extracts from CC system prompt", () => {
    const result = extractProjectIdentity(
      "You are Claude Code.\n - Primary working directory: /home/user/my-project\n - Platform: darwin"
    );
    expect(result).toBe("/home/user/my-project");
  });

  test("returns null when no working directory found", () => {
    const result = extractProjectIdentity("You are a helpful assistant.");
    expect(result).toBeNull();
  });
});

describe("sortByCreatedAt", () => {
  let db: Database;
  let dbPath: string;

  beforeEach(() => {
    ({ db, path: dbPath } = tempDb());
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(dbPath); } catch {}
  });

  test("empty input returns empty", () => {
    expect(sortByCreatedAt(db, [])).toEqual([]);
  });

  test("sorts by created_at ascending", () => {
    db.run("INSERT INTO memories (content, salience, created_at, last_accessed) VALUES (?, ?, ?, ?)", ["c", 0.5, 3000, 3000]);
    const id3 = (db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id;
    db.run("INSERT INTO memories (content, salience, created_at, last_accessed) VALUES (?, ?, ?, ?)", ["a", 0.5, 1000, 1000]);
    const id1 = (db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id;
    db.run("INSERT INTO memories (content, salience, created_at, last_accessed) VALUES (?, ?, ?, ?)", ["b", 0.5, 2000, 2000]);
    const id2 = (db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id;

    const sorted = sortByCreatedAt(db, [id3, id1, id2]);
    expect(sorted).toEqual([id1, id2, id3]);
  });

  test("filters out nonexistent IDs", () => {
    db.run("INSERT INTO memories (content, salience, created_at, last_accessed) VALUES (?, ?, ?, ?)", ["a", 0.5, 1000, 1000]);
    const id = (db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id;
    const sorted = sortByCreatedAt(db, [id, 9999]);
    expect(sorted).toEqual([id]);
  });
});
