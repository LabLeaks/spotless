import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb, initSchema } from "../src/db.ts";
import {
  recall,
  traverseGraph,
  scoreMemory,
  getIdentityNodes,
  touchMemories,
  logRetrieval,
} from "../src/recall.ts";
import { createMemory, createAssociation } from "../src/digest-tools.ts";
import type { Memory } from "../src/types.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

function tempDb(): { db: Database; path: string } {
  const path = join(tmpdir(), `spotless-recall-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = openDb(path);
  initSchema(db);
  return { db, path };
}

function insertMemory(db: Database, content: string, salience: number, accessCount = 0): number {
  const now = Date.now();
  db.run(
    "INSERT INTO memories (content, salience, created_at, last_accessed, access_count) VALUES (?, ?, ?, ?, ?)",
    [content, salience, now, now, accessCount],
  );
  return (db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id;
}

describe("scoreMemory", () => {
  test("recently created/accessed memory scores higher", () => {
    const now = Date.now();
    const recent: Memory = { id: 1, content: "a", salience: 0.5, created_at: now, last_accessed: now, access_count: 0, type: "episodic", archived_at: null };
    const old: Memory = { id: 2, content: "b", salience: 0.5, created_at: now - 24 * 60 * 60 * 1000, last_accessed: now - 24 * 60 * 60 * 1000, access_count: 0, type: "episodic", archived_at: null };
    expect(scoreMemory(recent, now)).toBeGreaterThan(scoreMemory(old, now));
  });

  test("higher salience scores higher", () => {
    const now = Date.now();
    const high: Memory = { id: 1, content: "a", salience: 0.9, created_at: now, last_accessed: now, access_count: 0, type: "episodic", archived_at: null };
    const low: Memory = { id: 2, content: "b", salience: 0.1, created_at: now, last_accessed: now, access_count: 0, type: "episodic", archived_at: null };
    expect(scoreMemory(high, now)).toBeGreaterThan(scoreMemory(low, now));
  });

  test("uses MAX of created_at and last_accessed for recency", () => {
    const now = Date.now();
    const m: Memory = { id: 1, content: "a", salience: 0.5, created_at: now - 48 * 60 * 60 * 1000, last_accessed: now, access_count: 5, type: "episodic", archived_at: null };
    // last_accessed is now, so recency should be ~1.0
    const score = scoreMemory(m, now);
    expect(score).toBeGreaterThan(1.4); // recency ~1.0 + salience 0.5
  });
});

describe("recall", () => {
  let db: Database;
  let dbPath: string;

  beforeEach(() => {
    ({ db, path: dbPath } = tempDb());
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(dbPath); } catch {}
  });

  test("empty DB returns empty", () => {
    const result = recall(db, "hello");
    expect(result).toEqual([]);
  });

  test("empty cue returns empty", () => {
    insertMemory(db, "test content", 0.5);
    const result = recall(db, "");
    expect(result).toEqual([]);
  });

  test("single-char cue returns empty", () => {
    insertMemory(db, "test content", 0.5);
    const result = recall(db, "x");
    expect(result).toEqual([]);
  });

  test("FTS5 match returns matching memory", () => {
    insertMemory(db, "TypeScript is great", 0.5);
    insertMemory(db, "Python is also good", 0.5);
    const result = recall(db, "TypeScript project");
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.some(m => m.content.includes("TypeScript"))).toBe(true);
  });

  test("graph traversal follows associations", () => {
    const id1 = insertMemory(db, "authentication system", 0.7);
    const id2 = insertMemory(db, "JWT token setup", 0.6);
    const id3 = insertMemory(db, "unrelated topic", 0.5);
    createAssociation(db, id1, id2, 0.8);
    // id3 has no association

    const result = recall(db, "authentication");
    const ids = result.map(m => m.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2); // reached via graph traversal
  });
});

describe("traverseGraph", () => {
  let db: Database;
  let dbPath: string;

  beforeEach(() => {
    ({ db, path: dbPath } = tempDb());
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(dbPath); } catch {}
  });

  test("empty seeds returns empty", () => {
    const result = traverseGraph(db, []);
    expect(result).toEqual([]);
  });

  test("respects maxNodes bound", () => {
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(insertMemory(db, `memory ${i}`, 0.5));
    }
    // Create chain: 0-1-2-3-4-5-6-7-8-9
    for (let i = 0; i < 9; i++) {
      createAssociation(db, ids[i]!, ids[i + 1]!, 0.5);
    }
    const result = traverseGraph(db, [ids[0]!], { maxNodes: 3 });
    expect(result.length).toBeLessThanOrEqual(3);
  });

  test("respects minEdgeStrength", () => {
    const id1 = insertMemory(db, "a", 0.5);
    const id2 = insertMemory(db, "b", 0.5);
    const id3 = insertMemory(db, "c", 0.5);
    createAssociation(db, id1, id2, 0.8);
    createAssociation(db, id1, id3, 0.05); // too weak

    const result = traverseGraph(db, [id1], { minEdgeStrength: 0.1 });
    const ids = result.map(m => m.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
    expect(ids).not.toContain(id3);
  });

  test("respects maxResults", () => {
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(insertMemory(db, `memory ${i}`, 0.5));
    }
    for (let i = 1; i < 10; i++) {
      createAssociation(db, ids[0]!, ids[i]!, 0.5);
    }
    const result = traverseGraph(db, [ids[0]!], { maxResults: 3 });
    expect(result.length).toBeLessThanOrEqual(3);
  });
});

describe("touchMemories", () => {
  let db: Database;
  let dbPath: string;

  beforeEach(() => {
    ({ db, path: dbPath } = tempDb());
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(dbPath); } catch {}
  });

  test("no-op on empty input", () => {
    touchMemories(db, []);
    // Should not throw
  });

  test("increments access_count and updates last_accessed", () => {
    const id = insertMemory(db, "test", 0.5);
    const before = db.query("SELECT access_count, last_accessed FROM memories WHERE id = ?").get(id) as { access_count: number; last_accessed: number };
    expect(before.access_count).toBe(0);

    touchMemories(db, [id]);
    const after = db.query("SELECT access_count, last_accessed FROM memories WHERE id = ?").get(id) as { access_count: number; last_accessed: number };
    expect(after.access_count).toBe(1);
    expect(after.last_accessed).toBeGreaterThanOrEqual(before.last_accessed);
  });
});

describe("logRetrieval", () => {
  let db: Database;
  let dbPath: string;

  beforeEach(() => {
    ({ db, path: dbPath } = tempDb());
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(dbPath); } catch {}
  });

  test("no-op on empty input", () => {
    logRetrieval(db, []);
    const count = (db.query("SELECT COUNT(*) as c FROM retrieval_log").get() as { c: number }).c;
    expect(count).toBe(0);
  });

  test("creates retrieval log entry with memory IDs", () => {
    const id1 = insertMemory(db, "a", 0.5);
    const id2 = insertMemory(db, "b", 0.5);
    logRetrieval(db, [id1, id2]);

    const logs = db.query("SELECT COUNT(*) as c FROM retrieval_log").get() as { c: number };
    expect(logs.c).toBe(1);

    const entries = db.query("SELECT memory_id FROM retrieval_log_entries ORDER BY memory_id").all() as { memory_id: number }[];
    expect(entries.map(e => e.memory_id)).toEqual([id1, id2]);
  });
});

describe("getIdentityNodes", () => {
  let db: Database;
  let dbPath: string;

  beforeEach(() => {
    ({ db, path: dbPath } = tempDb());
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(dbPath); } catch {}
  });

  test("returns memories with roles for all registered identity nodes", () => {
    // Set up both identity nodes (self + relationship)
    const selfId = createMemory(db, "Test-first engineer", 0.9, []);
    db.run("INSERT OR REPLACE INTO identity_nodes (role, memory_id) VALUES (?, ?)", ["self", selfId]);
    const relId = createMemory(db, "Direct communication", 0.85, []);
    db.run("INSERT OR REPLACE INTO identity_nodes (role, memory_id) VALUES (?, ?)", ["relationship", relId]);

    const nodes = getIdentityNodes(db);
    expect(nodes.length).toBe(2);

    const contents = nodes.map(n => n.content).sort();
    expect(contents).toEqual([
      "Direct communication",
      "Test-first engineer",
    ]);

    // Verify roles are returned
    const roles = nodes.map(n => n.role).sort();
    expect(roles).toEqual(["relationship", "self"]);
  });

  test("returns empty when no nodes registered", () => {
    const nodes = getIdentityNodes(db);
    expect(nodes.length).toBe(0);
  });

  test("returns partial when only some nodes registered", () => {
    const selfId = createMemory(db, "Self model only", 0.9, []);
    db.run("INSERT OR REPLACE INTO identity_nodes (role, memory_id) VALUES (?, ?)", ["self", selfId]);

    const nodes = getIdentityNodes(db);
    expect(nodes.length).toBe(1);
    expect(nodes[0]!.content).toBe("Self model only");
    expect(nodes[0]!.role).toBe("self");
  });

  test("skips archived identity nodes", () => {
    // Create old identity and archive it (simulates evolveIdentity replacing v1 with v2)
    const oldId = createMemory(db, "Self v1", 0.9, []);
    db.run("UPDATE memories SET archived_at = ? WHERE id = ?", [Date.now(), oldId]);

    // Create new current identity
    const newSelfId = createMemory(db, "Self v2", 0.9, []);
    db.run("INSERT OR REPLACE INTO identity_nodes (role, memory_id) VALUES (?, ?)", ["self", newSelfId]);

    // Old should be archived
    const old = db.query("SELECT archived_at FROM memories WHERE id = ?").get(oldId) as any;
    expect(old.archived_at).not.toBeNull();

    // getIdentityNodes should only return current (non-archived) node
    const nodes = getIdentityNodes(db);
    const selfNodes = nodes.filter(n => n.role === "self");
    expect(selfNodes.length).toBe(1);
    expect(selfNodes[0]!.id).toBe(newSelfId);
  });
});

describe("traverseGraph archived exclusion", () => {
  let db: Database;
  let dbPath: string;

  beforeEach(() => {
    ({ db, path: dbPath } = tempDb());
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(dbPath); } catch {}
  });

  test("skips archived memories in BFS", () => {
    const id1 = insertMemory(db, "active seed", 0.7);
    const id2 = insertMemory(db, "active neighbor", 0.6);
    const id3 = insertMemory(db, "archived neighbor", 0.5);

    createAssociation(db, id1, id2, 0.8);
    createAssociation(db, id1, id3, 0.8);

    // Archive id3
    db.run("UPDATE memories SET archived_at = ? WHERE id = ?", [Date.now(), id3]);

    const result = traverseGraph(db, [id1]);
    const ids = result.map(m => m.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
    expect(ids).not.toContain(id3);
  });

  test("skips archived seed memories", () => {
    const id1 = insertMemory(db, "archived seed", 0.7);
    db.run("UPDATE memories SET archived_at = ? WHERE id = ?", [Date.now(), id1]);

    const result = traverseGraph(db, [id1]);
    expect(result.length).toBe(0);
  });
});
