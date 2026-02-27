import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb, initSchema } from "../src/db.ts";
import {
  queryMemories,
  queryRawEvents,
  getAssociations,
  createMemory,
  createAssociation,
  updateMemory,
  mergeMemories,
  countHumanTurnsBetween,
  pruneMemory,
  drainRetrievalLog,
  supersedeMemory,
  reflectOnSelf,
  evolveIdentity,
  evolveRelationship,
  markSignificance,
  cleanupConsolidatedFromFts,
} from "../src/dream-tools.ts";
import { getIdentityNodes } from "../src/recall.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

function tempDb(): { db: Database; path: string } {
  const path = join(tmpdir(), `spotless-dream-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = openDb(path);
  initSchema(db);
  return { db, path };
}

function insertRawEvent(
  db: Database,
  group: number,
  role: string,
  contentType: string,
  content: string,
  isSubagent = 0,
): number {
  db.run(
    "INSERT INTO raw_events (timestamp, message_group, role, content_type, content, is_subagent) VALUES (?, ?, ?, ?, ?, ?)",
    [Date.now(), group, role, contentType, content, isSubagent],
  );
  return (db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id;
}

function insertMemory(db: Database, content: string, salience: number, accessCount = 0): number {
  const now = Date.now();
  db.run(
    "INSERT INTO memories (content, salience, created_at, last_accessed, access_count) VALUES (?, ?, ?, ?, ?)",
    [content, salience, now, now, accessCount],
  );
  return (db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id;
}

describe("dream-tools", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const p of cleanup) {
      try { unlinkSync(p); } catch {}
      try { unlinkSync(p + "-wal"); } catch {}
      try { unlinkSync(p + "-shm"); } catch {}
    }
    cleanup.length = 0;
  });

  describe("queryMemories", () => {
    test("returns all memories ordered by salience DESC", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      insertMemory(db, "low importance", 0.2);
      insertMemory(db, "high importance", 0.9);
      insertMemory(db, "medium importance", 0.5);

      const results = queryMemories(db);
      expect(results.length).toBe(3);
      expect(results[0]!.content).toBe("high importance");
      expect(results[0]!.salience).toBe(0.9);

      db.close();
    });

    test("filters by FTS5 query", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      insertMemory(db, "the user prefers TypeScript", 0.7);
      insertMemory(db, "project uses SQLite database", 0.6);
      insertMemory(db, "testing with bun framework", 0.5);

      const results = queryMemories(db, { query: "TypeScript" });
      expect(results.length).toBe(1);
      expect(results[0]!.content).toContain("TypeScript");

      db.close();
    });

    test("M6: FTS5 query with special characters does not throw", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      insertMemory(db, "don't over-engineer the solution", 0.7);

      // These would break raw FTS5 MATCH without sanitization
      const results1 = queryMemories(db, { query: "don't over-engineer" });
      expect(results1.length).toBe(1);

      const results2 = queryMemories(db, { query: "user(1) AND OR" });
      // Should not throw — returns empty or results gracefully
      expect(Array.isArray(results2)).toBe(true);

      const results3 = queryMemories(db, { query: '"unmatched quote' });
      expect(Array.isArray(results3)).toBe(true);

      const results4 = queryMemories(db, { query: "column:value" });
      expect(Array.isArray(results4)).toBe(true);

      db.close();
    });

    test("filters by minimum salience", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      insertMemory(db, "low", 0.1);
      insertMemory(db, "high", 0.8);

      const results = queryMemories(db, { minSalience: 0.5 });
      expect(results.length).toBe(1);
      expect(results[0]!.content).toBe("high");

      db.close();
    });

    test("includes association_count", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const id1 = insertMemory(db, "mem A", 0.5);
      const id2 = insertMemory(db, "mem B", 0.5);
      createAssociation(db, id1, id2, 0.5);

      const results = queryMemories(db);
      const memA = results.find((m) => m.content === "mem A");
      expect(memA!.association_count).toBe(1);

      db.close();
    });

    test("respects limit", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      for (let i = 0; i < 10; i++) insertMemory(db, `mem ${i}`, 0.5);

      const results = queryMemories(db, { limit: 3 });
      expect(results.length).toBe(3);

      db.close();
    });
  });

  describe("queryRawEvents", () => {
    test("groups events by message_group", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      insertRawEvent(db, 1, "user", "text", "hello");
      insertRawEvent(db, 2, "assistant", "text", "hi there");
      insertRawEvent(db, 2, "assistant", "tool_use", '{"name":"test"}');

      const groups = queryRawEvents(db);
      expect(groups.length).toBe(2);
      expect(groups[0]!.message_group).toBe(1);
      expect(groups[0]!.events.length).toBe(1);
      expect(groups[1]!.message_group).toBe(2);
      expect(groups[1]!.events.length).toBe(2);

      db.close();
    });

    test("excludes thinking blocks and subagent content", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      insertRawEvent(db, 1, "user", "text", "user msg");
      insertRawEvent(db, 2, "assistant", "thinking", "thinking...");
      insertRawEvent(db, 3, "user", "text", "subagent msg", 1);

      const groups = queryRawEvents(db);
      expect(groups.length).toBe(1);
      expect(groups[0]!.events[0]!.content).toBe("user msg");

      db.close();
    });

    test("limit applies to message_groups not rows", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      // 3 groups with multiple rows each
      for (let g = 1; g <= 3; g++) {
        insertRawEvent(db, g, "user", "text", `group ${g} msg 1`);
        insertRawEvent(db, g, "assistant", "text", `group ${g} msg 2`);
      }

      const groups = queryRawEvents(db, { limit: 2 });
      expect(groups.length).toBe(2);

      db.close();
    });

    test("unconsolidatedOnly excludes events with memory_sources links", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const ev1 = insertRawEvent(db, 1, "user", "text", "consolidated msg");
      insertRawEvent(db, 2, "user", "text", "new msg");

      // Link ev1 to a memory
      const memId = insertMemory(db, "test mem", 0.5);
      db.run("INSERT INTO memory_sources (memory_id, raw_event_id) VALUES (?, ?)", [memId, ev1]);

      const groups = queryRawEvents(db, { unconsolidatedOnly: true });
      expect(groups.length).toBe(1);
      expect(groups[0]!.message_group).toBe(2);

      db.close();
    });
  });

  describe("getAssociations", () => {
    test("returns bidirectional associations", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const id1 = insertMemory(db, "mem 1", 0.5);
      const id2 = insertMemory(db, "mem 2", 0.5);
      const id3 = insertMemory(db, "mem 3", 0.5);

      createAssociation(db, id1, id2, 0.5);
      createAssociation(db, id1, id3, 0.3);

      const assocs = getAssociations(db, id1);
      expect(assocs.length).toBe(2);

      const connectedIds = assocs.map((a) => a.connected_id).sort();
      expect(connectedIds).toEqual([id2, id3].sort());

      db.close();
    });

    test("returns empty for memory with no associations", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const id = insertMemory(db, "lonely mem", 0.5);
      const assocs = getAssociations(db, id);
      expect(assocs.length).toBe(0);

      db.close();
    });
  });

  describe("createMemory", () => {
    test("creates memory with source links", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const ev1 = insertRawEvent(db, 1, "user", "text", "source 1");
      const ev2 = insertRawEvent(db, 2, "assistant", "text", "source 2");

      const memId = createMemory(db, "derived fact", 0.7, [ev1, ev2]);

      const mem = db.query("SELECT * FROM memories WHERE id = ?").get(memId) as any;
      expect(mem.content).toBe("derived fact");
      expect(mem.salience).toBe(0.7);

      const sources = db.query("SELECT raw_event_id FROM memory_sources WHERE memory_id = ?").all(memId) as { raw_event_id: number }[];
      expect(sources.length).toBe(2);

      db.close();
    });

    test("creates memory without source links", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const memId = createMemory(db, "standalone fact", 0.5, []);

      const mem = db.query("SELECT * FROM memories WHERE id = ?").get(memId) as any;
      expect(mem.content).toBe("standalone fact");

      const sources = db.query("SELECT * FROM memory_sources WHERE memory_id = ?").all(memId);
      expect(sources.length).toBe(0);

      db.close();
    });
  });

  describe("createAssociation", () => {
    test("canonical ordering: always stores smaller id first", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const id1 = insertMemory(db, "mem A", 0.5);
      const id2 = insertMemory(db, "mem B", 0.5);

      // Pass in reverse order
      createAssociation(db, id2, id1, 0.5);

      const assoc = db.query("SELECT * FROM associations").get() as any;
      expect(assoc.source_id).toBe(Math.min(id1, id2));
      expect(assoc.target_id).toBe(Math.max(id1, id2));

      db.close();
    });

    test("upsert: takes max strength and increments reinforcement_count", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const id1 = insertMemory(db, "mem A", 0.5);
      const id2 = insertMemory(db, "mem B", 0.5);

      createAssociation(db, id1, id2, 0.3);
      createAssociation(db, id1, id2, 0.7);

      const assoc = db.query("SELECT * FROM associations").get() as any;
      expect(assoc.strength).toBe(0.7);
      expect(assoc.reinforcement_count).toBe(2);

      db.close();
    });

    test("upsert: keeps existing higher strength", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const id1 = insertMemory(db, "mem A", 0.5);
      const id2 = insertMemory(db, "mem B", 0.5);

      createAssociation(db, id1, id2, 0.9);
      createAssociation(db, id1, id2, 0.3);

      const assoc = db.query("SELECT * FROM associations").get() as any;
      expect(assoc.strength).toBe(0.9);
      expect(assoc.reinforcement_count).toBe(2);

      db.close();
    });

    test("ignores self-loops", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const id1 = insertMemory(db, "mem A", 0.5);
      createAssociation(db, id1, id1, 0.5);

      const count = db.query("SELECT COUNT(*) as c FROM associations").get() as { c: number };
      expect(count.c).toBe(0);

      db.close();
    });
  });

  describe("updateMemory", () => {
    test("updates content only", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const id = insertMemory(db, "original", 0.5);
      updateMemory(db, id, { content: "updated" });

      const mem = db.query("SELECT content, salience FROM memories WHERE id = ?").get(id) as any;
      expect(mem.content).toBe("updated");
      expect(mem.salience).toBe(0.5);

      db.close();
    });

    test("updates salience only", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const id = insertMemory(db, "content", 0.5);
      updateMemory(db, id, { salience: 0.9 });

      const mem = db.query("SELECT content, salience FROM memories WHERE id = ?").get(id) as any;
      expect(mem.content).toBe("content");
      expect(mem.salience).toBe(0.9);

      db.close();
    });

    test("updates both content and salience", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const id = insertMemory(db, "original", 0.5);
      updateMemory(db, id, { content: "new", salience: 0.8 });

      const mem = db.query("SELECT content, salience FROM memories WHERE id = ?").get(id) as any;
      expect(mem.content).toBe("new");
      expect(mem.salience).toBe(0.8);

      db.close();
    });

    test("no-op when no updates provided", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const id = insertMemory(db, "original", 0.5);
      updateMemory(db, id, {});

      const mem = db.query("SELECT content FROM memories WHERE id = ?").get(id) as any;
      expect(mem.content).toBe("original");

      db.close();
    });
  });

  describe("mergeMemories", () => {
    test("merges memories and transfers source links", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const ev1 = insertRawEvent(db, 1, "user", "text", "raw 1");
      const ev2 = insertRawEvent(db, 2, "user", "text", "raw 2");

      const m1 = createMemory(db, "fact A", 0.5, [ev1]);
      const m2 = createMemory(db, "fact B", 0.6, [ev2]);

      const newId = mergeMemories(db, [m1, m2], "merged fact A+B", 0.7);

      // Original memories gone
      const originals = db.query("SELECT id FROM memories WHERE id IN (?, ?)").all(m1, m2);
      expect(originals.length).toBe(0);

      // New memory exists
      const merged = db.query("SELECT * FROM memories WHERE id = ?").get(newId) as any;
      expect(merged.content).toBe("merged fact A+B");
      expect(merged.salience).toBe(0.7);

      // Source links transferred
      const sources = db.query("SELECT raw_event_id FROM memory_sources WHERE memory_id = ?").all(newId) as { raw_event_id: number }[];
      expect(sources.length).toBe(2);
      const eventIds = sources.map((s) => s.raw_event_id).sort();
      expect(eventIds).toEqual([ev1, ev2].sort());

      db.close();
    });

    test("transfers associations to external memories", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const m1 = insertMemory(db, "mem A", 0.5);
      const m2 = insertMemory(db, "mem B", 0.5);
      const mExternal = insertMemory(db, "external mem", 0.5);

      createAssociation(db, m1, mExternal, 0.7);
      createAssociation(db, m2, mExternal, 0.4);

      const newId = mergeMemories(db, [m1, m2], "merged A+B", 0.6);

      // External association transferred with strongest strength
      const assocs = getAssociations(db, newId);
      expect(assocs.length).toBe(1);
      expect(assocs[0]!.connected_id).toBe(mExternal);
      expect(assocs[0]!.strength).toBe(0.7);

      db.close();
    });

    test("handles self-loop in merge (internal associations dropped)", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const m1 = insertMemory(db, "mem A", 0.5);
      const m2 = insertMemory(db, "mem B", 0.5);

      // Association between the two memories being merged
      createAssociation(db, m1, m2, 0.8);

      const newId = mergeMemories(db, [m1, m2], "merged", 0.6);

      // No self-loop should exist
      const assocs = getAssociations(db, newId);
      expect(assocs.length).toBe(0);

      db.close();
    });

    test("throws on empty source IDs", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      expect(() => mergeMemories(db, [], "merged", 0.5)).toThrow();

      db.close();
    });
  });

  describe("countHumanTurnsBetween", () => {
    test("counts user text turns between two IDs", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const ev1 = insertRawEvent(db, 1, "user", "text", "first");
      insertRawEvent(db, 2, "assistant", "text", "response");
      insertRawEvent(db, 3, "user", "text", "second");
      insertRawEvent(db, 4, "assistant", "text", "response 2");
      insertRawEvent(db, 5, "user", "text", "third");
      const ev6 = insertRawEvent(db, 6, "assistant", "text", "response 3");

      // Between first and last (exclusive)
      const count = countHumanTurnsBetween(db, ev1, ev6);
      expect(count).toBe(2); // groups 3 and 5

      db.close();
    });

    test("excludes subagent turns", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const ev1 = insertRawEvent(db, 1, "user", "text", "first");
      insertRawEvent(db, 2, "user", "text", "subagent msg", 1);
      insertRawEvent(db, 3, "user", "text", "human msg");
      const ev4 = insertRawEvent(db, 4, "user", "text", "last");

      const count = countHumanTurnsBetween(db, ev1, ev4);
      expect(count).toBe(1); // only group 3

      db.close();
    });

    test("returns 0 for adjacent IDs", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const ev1 = insertRawEvent(db, 1, "user", "text", "first");
      const ev2 = insertRawEvent(db, 1, "user", "text", "second");

      const count = countHumanTurnsBetween(db, ev1, ev2);
      expect(count).toBe(0);

      db.close();
    });
  });

  describe("pruneMemory", () => {
    test("prunes when all three conditions met", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const id = insertMemory(db, "ephemeral", 0.1, 0); // low salience, zero access

      const result = pruneMemory(db, id);
      expect(result).toBe(true);

      const mem = db.query("SELECT * FROM memories WHERE id = ?").get(id);
      expect(mem).toBeNull();

      db.close();
    });

    test("refuses to prune high salience", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const id = insertMemory(db, "important", 0.8, 0);

      const result = pruneMemory(db, id);
      expect(result).toBe(false);

      const mem = db.query("SELECT * FROM memories WHERE id = ?").get(id);
      expect(mem).not.toBeNull();

      db.close();
    });

    test("refuses to prune with access count > 0", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const id = insertMemory(db, "accessed", 0.1, 3);

      const result = pruneMemory(db, id);
      expect(result).toBe(false);

      db.close();
    });

    test("refuses to prune with strong associations", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const id1 = insertMemory(db, "connected low", 0.1, 0);
      const id2 = insertMemory(db, "other", 0.5);

      createAssociation(db, id1, id2, 0.5); // strong association

      const result = pruneMemory(db, id1);
      expect(result).toBe(false);

      db.close();
    });

    test("prunes with only weak associations", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const id1 = insertMemory(db, "weakly connected", 0.1, 0);
      const id2 = insertMemory(db, "other", 0.5);

      createAssociation(db, id1, id2, 0.1); // weak association

      const result = pruneMemory(db, id1);
      expect(result).toBe(true);

      db.close();
    });

    test("returns false for non-existent memory", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const result = pruneMemory(db, 99999);
      expect(result).toBe(false);

      db.close();
    });
  });

  describe("drainRetrievalLog", () => {
    test("returns co-retrieval sets and cleans up", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const m1 = insertMemory(db, "mem 1", 0.5);
      const m2 = insertMemory(db, "mem 2", 0.5);
      const m3 = insertMemory(db, "mem 3", 0.5);

      // Two retrieval events
      const now = Date.now();
      db.run("INSERT INTO retrieval_log (timestamp) VALUES (?)", [now]);
      const log1 = (db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id;
      db.run("INSERT INTO retrieval_log_entries (log_id, memory_id) VALUES (?, ?)", [log1, m1]);
      db.run("INSERT INTO retrieval_log_entries (log_id, memory_id) VALUES (?, ?)", [log1, m2]);

      db.run("INSERT INTO retrieval_log (timestamp) VALUES (?)", [now + 1]);
      const log2 = (db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id;
      db.run("INSERT INTO retrieval_log_entries (log_id, memory_id) VALUES (?, ?)", [log2, m2]);
      db.run("INSERT INTO retrieval_log_entries (log_id, memory_id) VALUES (?, ?)", [log2, m3]);

      const sets = drainRetrievalLog(db);
      expect(sets.length).toBe(2);
      expect(sets[0]).toEqual([m1, m2]);
      expect(sets[1]).toEqual([m2, m3]);

      // Log should be empty after draining
      const remaining = db.query("SELECT COUNT(*) as c FROM retrieval_log").get() as { c: number };
      expect(remaining.c).toBe(0);

      const remainingEntries = db.query("SELECT COUNT(*) as c FROM retrieval_log_entries").get() as { c: number };
      expect(remainingEntries.c).toBe(0);

      db.close();
    });

    test("returns empty array when no logs", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const sets = drainRetrievalLog(db);
      expect(sets.length).toBe(0);

      db.close();
    });
  });

  describe("supersedeMemory", () => {
    test("creates corrected memory and archives old", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const ev1 = insertRawEvent(db, 1, "user", "text", "wrong info");
      const oldId = createMemory(db, "The sky is green", 0.7, [ev1]);

      const ev2 = insertRawEvent(db, 2, "user", "text", "correction");
      const { newId, oldId: returnedOldId } = supersedeMemory(
        db, oldId, "The sky is blue", 0.85, [ev2],
      );

      expect(returnedOldId).toBe(oldId);

      // New memory has corrected content with type=fact
      const newMem = db.query("SELECT * FROM memories WHERE id = ?").get(newId) as any;
      expect(newMem.content).toBe("The sky is blue");
      expect(newMem.salience).toBe(0.85);
      expect(newMem.type).toBe("fact");
      expect(newMem.archived_at).toBeNull();

      // Old memory archived (content preserved, salience preserved)
      const oldMem = db.query("SELECT * FROM memories WHERE id = ?").get(oldId) as any;
      expect(oldMem.content).toBe("The sky is green"); // No [SUPERSEDED] prefix
      expect(oldMem.salience).toBe(0.7); // Original salience preserved
      expect(oldMem.archived_at).not.toBeNull();
      expect(oldMem.type).toBe("fact");

      db.close();
    });

    test("transfers associations from old to new", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const oldId = insertMemory(db, "wrong fact", 0.7);
      const relatedId = insertMemory(db, "related memory", 0.6);
      createAssociation(db, oldId, relatedId, 0.5);

      const { newId } = supersedeMemory(db, oldId, "correct fact", 0.85, []);

      // New memory should have association to related
      const newAssocs = getAssociations(db, newId);
      const relatedAssoc = newAssocs.find(a => a.connected_id === relatedId);
      expect(relatedAssoc).toBeDefined();
      expect(relatedAssoc!.strength).toBe(0.5);

      db.close();
    });

    test("creates strong (0.9) correction breadcrumb association", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const oldId = insertMemory(db, "wrong", 0.7);
      const { newId } = supersedeMemory(db, oldId, "correct", 0.85, []);

      // Should have association between old and new
      const assocs = getAssociations(db, newId);
      const breadcrumb = assocs.find(a => a.connected_id === oldId);
      expect(breadcrumb).toBeDefined();
      expect(breadcrumb!.strength).toBe(0.9);

      db.close();
    });

    test("preserves source events on old memory", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const ev1 = insertRawEvent(db, 1, "user", "text", "original source");
      const oldId = createMemory(db, "wrong fact", 0.7, [ev1]);

      const ev2 = insertRawEvent(db, 2, "user", "text", "correction source");
      const { newId } = supersedeMemory(db, oldId, "correct fact", 0.85, [ev2]);

      // Old memory retains its source links
      const oldSources = db.query(
        "SELECT raw_event_id FROM memory_sources WHERE memory_id = ?"
      ).all(oldId) as { raw_event_id: number }[];
      expect(oldSources.length).toBe(1);
      expect(oldSources[0]!.raw_event_id).toBe(ev1);

      // New memory has its own source links
      const newSources = db.query(
        "SELECT raw_event_id FROM memory_sources WHERE memory_id = ?"
      ).all(newId) as { raw_event_id: number }[];
      expect(newSources.length).toBe(1);
      expect(newSources[0]!.raw_event_id).toBe(ev2);

      db.close();
    });

    test("throws on non-existent target", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      expect(() => supersedeMemory(db, 99999, "corrected", 0.85, [])).toThrow(
        "target memory 99999 does not exist"
      );

      db.close();
    });

    test("double supersession creates chain with archived versions", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const originalId = insertMemory(db, "first version", 0.7);
      const { newId: correctionId } = supersedeMemory(db, originalId, "second version", 0.85, []);
      const { newId: correction2Id } = supersedeMemory(db, correctionId, "third version", 0.9, []);

      // Original should be archived (content and salience preserved)
      const original = db.query("SELECT * FROM memories WHERE id = ?").get(originalId) as any;
      expect(original.content).toBe("first version");
      expect(original.archived_at).not.toBeNull();

      // First correction should also be archived
      const correction = db.query("SELECT * FROM memories WHERE id = ?").get(correctionId) as any;
      expect(correction.content).toBe("second version");
      expect(correction.archived_at).not.toBeNull();

      // Latest correction is active
      const correction2 = db.query("SELECT * FROM memories WHERE id = ?").get(correction2Id) as any;
      expect(correction2.content).toBe("third version");
      expect(correction2.salience).toBe(0.9);
      expect(correction2.archived_at).toBeNull();

      // Chain: original → correction → correction2 (via 0.9 associations)
      const origAssocs = getAssociations(db, originalId);
      expect(origAssocs.some(a => a.connected_id === correctionId)).toBe(true);
      const corrAssocs = getAssociations(db, correctionId);
      expect(corrAssocs.some(a => a.connected_id === correction2Id)).toBe(true);

      db.close();
    });

    test("old memory still exists (not deleted)", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const oldId = insertMemory(db, "wrong", 0.7);
      supersedeMemory(db, oldId, "correct", 0.85, []);

      const old = db.query("SELECT id FROM memories WHERE id = ?").get(oldId);
      expect(old).not.toBeNull();

      db.close();
    });
  });

  describe("reflectOnSelf", () => {
    test("creates memory at 0.85 with source event links", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const ev1 = insertRawEvent(db, 1, "user", "text", "interaction data");
      const { newId } = reflectOnSelf(db, "I tend to over-engineer", [ev1]);

      const mem = db.query("SELECT * FROM memories WHERE id = ?").get(newId) as any;
      expect(mem.content).toBe("I tend to over-engineer");
      expect(mem.salience).toBe(0.85);

      const sources = db.query("SELECT raw_event_id FROM memory_sources WHERE memory_id = ?").all(newId) as any[];
      expect(sources.length).toBe(1);
      expect(sources[0].raw_event_id).toBe(ev1);

      db.close();
    });

    test("associates with self-model node at 0.8 when node exists", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      // Create self-model via evolveIdentity
      const { newId: selfId } = evolveIdentity(db, "Test-first engineer", []);

      const { newId } = reflectOnSelf(db, "I tend to over-engineer", []);

      const assocs = getAssociations(db, newId);
      const selfAssoc = assocs.find(a => a.connected_id === selfId);
      expect(selfAssoc).toBeDefined();
      expect(selfAssoc!.strength).toBe(0.8);

      db.close();
    });

    test("works when no self-model node exists", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const { newId } = reflectOnSelf(db, "I tend to over-engineer", []);

      const mem = db.query("SELECT * FROM memories WHERE id = ?").get(newId) as any;
      expect(mem.content).toBe("I tend to over-engineer");
      expect(mem.salience).toBe(0.85);

      // No association since no self-model
      const assocs = getAssociations(db, newId);
      expect(assocs.length).toBe(0);

      db.close();
    });

    test("content is pure insight text — no metadata prefix", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const { newId } = reflectOnSelf(db, "Always run tests", []);

      const mem = db.query("SELECT content FROM memories WHERE id = ?").get(newId) as any;
      expect(mem.content).toBe("Always run tests");
      // No [SELF] or [INSIGHT] prefix
      expect(mem.content).not.toMatch(/^\[/);

      db.close();
    });
  });

  describe("evolveIdentity", () => {
    test("fresh creation: no existing → creates at 0.9, inserts registry", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const { newId, previousId } = evolveIdentity(db, "Thorough, test-first", []);

      expect(previousId).toBeNull();

      const mem = db.query("SELECT * FROM memories WHERE id = ?").get(newId) as any;
      expect(mem.content).toBe("Thorough, test-first");
      expect(mem.salience).toBe(0.9);

      const reg = db.query("SELECT memory_id FROM identity_nodes WHERE role = 'self'").get() as any;
      expect(reg.memory_id).toBe(newId);

      db.close();
    });

    test("evolution: old archived, new at 0.9 with type=identity", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const { newId: oldId } = evolveIdentity(db, "Self v1", []);
      const { newId, previousId } = evolveIdentity(db, "Self v2", []);

      expect(previousId).toBe(oldId);

      const newMem = db.query("SELECT * FROM memories WHERE id = ?").get(newId) as any;
      expect(newMem.salience).toBe(0.9);
      expect(newMem.type).toBe("identity");
      expect(newMem.archived_at).toBeNull();

      // Old memory archived (not deleted) — preserved for provenance
      const oldMem = db.query("SELECT * FROM memories WHERE id = ?").get(oldId) as any;
      expect(oldMem).not.toBeNull();
      expect(oldMem.archived_at).not.toBeNull();
      expect(oldMem.content).toBe("Self v1");

      db.close();
    });

    test("associations transferred old → new, old archived", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const { newId: selfId } = evolveIdentity(db, "Self v1", []);
      const relatedId = insertMemory(db, "related insight", 0.6);
      createAssociation(db, selfId, relatedId, 0.5);

      const { newId } = evolveIdentity(db, "Self v2", []);

      // New memory got the association
      const newAssocs = getAssociations(db, newId);
      const relatedAssoc = newAssocs.find(a => a.connected_id === relatedId);
      expect(relatedAssoc).toBeDefined();
      expect(relatedAssoc!.strength).toBe(0.5);

      // Old memory archived (not deleted)
      const oldMem = db.query("SELECT * FROM memories WHERE id = ?").get(selfId) as any;
      expect(oldMem).not.toBeNull();
      expect(oldMem.archived_at).not.toBeNull();

      db.close();
    });

    test("registry points to new memory after evolution", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      evolveIdentity(db, "Self v1", []);
      const { newId } = evolveIdentity(db, "Self v2", []);

      const reg = db.query("SELECT memory_id FROM identity_nodes WHERE role = 'self'").get() as any;
      expect(reg.memory_id).toBe(newId);

      db.close();
    });

    test("M5: transfers memory_sources from old to new", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const ev1 = insertRawEvent(db, 1, "user", "text", "original insight");
      const ev2 = insertRawEvent(db, 2, "user", "text", "new insight");
      evolveIdentity(db, "Self v1", [ev1]);
      const { newId } = evolveIdentity(db, "Self v2", [ev2]);

      // New memory should have both old and new source links
      const sources = db.query(
        "SELECT raw_event_id FROM memory_sources WHERE memory_id = ? ORDER BY raw_event_id"
      ).all(newId) as { raw_event_id: number }[];
      expect(sources.length).toBe(2);
      expect(sources.map(s => s.raw_event_id)).toEqual([ev1, ev2]);

      db.close();
    });

    test("multiple evolutions: old versions archived, only latest active", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const { newId: id1 } = evolveIdentity(db, "Self v1", []);
      const { newId: id2 } = evolveIdentity(db, "Self v2", []);
      const { newId: id3 } = evolveIdentity(db, "Self v3", []);

      // Old versions archived
      const v1 = db.query("SELECT archived_at FROM memories WHERE id = ?").get(id1) as any;
      expect(v1.archived_at).not.toBeNull();
      const v2 = db.query("SELECT archived_at FROM memories WHERE id = ?").get(id2) as any;
      expect(v2.archived_at).not.toBeNull();

      // Latest version is current (not archived)
      const v3Mem = db.query("SELECT salience, archived_at FROM memories WHERE id = ?").get(id3) as any;
      expect(v3Mem.salience).toBe(0.9);
      expect(v3Mem.archived_at).toBeNull();

      // Registry points to latest
      const reg = db.query("SELECT memory_id FROM identity_nodes WHERE role = 'self'").get() as any;
      expect(reg.memory_id).toBe(id3);

      db.close();
    });
  });

  describe("evolveRelationship", () => {
    test("fresh creation at 0.85, previousId null", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const { newId, previousId } = evolveRelationship(db, "Formal, cautious", []);

      expect(previousId).toBeNull();

      const mem = db.query("SELECT * FROM memories WHERE id = ?").get(newId) as any;
      expect(mem.content).toBe("Formal, cautious");
      expect(mem.salience).toBe(0.85);

      const reg = db.query("SELECT memory_id FROM identity_nodes WHERE role = 'relationship'").get() as any;
      expect(reg.memory_id).toBe(newId);

      db.close();
    });

    test("evolution: old archived, new at 0.85 with type=identity", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const { newId: oldId } = evolveRelationship(db, "Rel v1", []);
      const { newId, previousId } = evolveRelationship(db, "Rel v2", []);

      expect(previousId).toBe(oldId);

      const newMem = db.query("SELECT * FROM memories WHERE id = ?").get(newId) as any;
      expect(newMem.salience).toBe(0.85);
      expect(newMem.type).toBe("identity");

      // Old archived (not deleted)
      const oldMem = db.query("SELECT * FROM memories WHERE id = ?").get(oldId) as any;
      expect(oldMem).not.toBeNull();
      expect(oldMem.archived_at).not.toBeNull();

      db.close();
    });

    test("works when no registry entry exists", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      // No prior relationship node
      const { newId, previousId } = evolveRelationship(db, "New dynamic", []);
      expect(previousId).toBeNull();
      expect(newId).toBeGreaterThan(0);

      db.close();
    });

    test("M5: transfers memory_sources from old to new", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const ev1 = insertRawEvent(db, 1, "user", "text", "early interaction");
      const ev2 = insertRawEvent(db, 2, "user", "text", "later interaction");
      evolveRelationship(db, "Rel v1", [ev1]);
      const { newId } = evolveRelationship(db, "Rel v2", [ev2]);

      const sources = db.query(
        "SELECT raw_event_id FROM memory_sources WHERE memory_id = ? ORDER BY raw_event_id"
      ).all(newId) as { raw_event_id: number }[];
      expect(sources.length).toBe(2);
      expect(sources.map(s => s.raw_event_id)).toEqual([ev1, ev2]);

      db.close();
    });

    test("multiple evolutions: old versions archived, latest is current", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const { newId: id1 } = evolveRelationship(db, "Rel v1", []);
      const { newId: id2 } = evolveRelationship(db, "Rel v2", []);
      const { newId: id3 } = evolveRelationship(db, "Rel v3", []);

      // Old versions archived (not deleted)
      const v1 = db.query("SELECT archived_at FROM memories WHERE id = ?").get(id1) as any;
      expect(v1.archived_at).not.toBeNull();
      const v2 = db.query("SELECT archived_at FROM memories WHERE id = ?").get(id2) as any;
      expect(v2.archived_at).not.toBeNull();

      // Latest is active
      const v3 = db.query("SELECT archived_at FROM memories WHERE id = ?").get(id3) as any;
      expect(v3.archived_at).toBeNull();

      // Registry points to latest
      const reg = db.query("SELECT memory_id FROM identity_nodes WHERE role = 'relationship'").get() as any;
      expect(reg.memory_id).toBe(id3);

      db.close();
    });
  });

  describe("markSignificance", () => {
    test("boosts target salience by 0.15", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const id = insertMemory(db, "important discovery", 0.6);
      markSignificance(db, id);

      const mem = db.query("SELECT salience FROM memories WHERE id = ?").get(id) as any;
      expect(mem.salience).toBeCloseTo(0.75);

      db.close();
    });

    test("caps salience at 0.95", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const id = insertMemory(db, "already high", 0.9);
      markSignificance(db, id);

      const mem = db.query("SELECT salience FROM memories WHERE id = ?").get(id) as any;
      expect(mem.salience).toBe(0.95);

      db.close();
    });

    test("creates association to self-model node at 0.6 when node exists", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const { newId: selfId } = evolveIdentity(db, "Test engineer", []);
      const memId = insertMemory(db, "breakthrough moment", 0.5);

      markSignificance(db, memId);

      const assocs = getAssociations(db, memId);
      const selfAssoc = assocs.find(a => a.connected_id === selfId);
      expect(selfAssoc).toBeDefined();
      expect(selfAssoc!.strength).toBe(0.6);

      db.close();
    });

    test("throws on non-existent memory", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      expect(() => markSignificance(db, 99999)).toThrow("memory 99999 does not exist");

      db.close();
    });
  });

  describe("cleanupConsolidatedFromFts", () => {
    test("removes consolidated raw events from FTS5", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const ev1 = insertRawEvent(db, 1, "user", "text", "consolidated zebra content");
      const ev2 = insertRawEvent(db, 2, "assistant", "text", "consolidated giraffe content");

      // Create memory linked to these events
      const memId = createMemory(db, "summary of zebra and giraffe", 0.7, [ev1, ev2]);

      // Verify events are in raw_events_fts before cleanup
      const before1 = db.query("SELECT rowid FROM raw_events_fts WHERE raw_events_fts MATCH 'zebra'").all();
      expect(before1.length).toBe(1);

      // Cleanup
      const cleaned = cleanupConsolidatedFromFts(db, [memId]);
      expect(cleaned).toBe(2);

      // Events should be removed from FTS5
      const after1 = db.query("SELECT rowid FROM raw_events_fts WHERE raw_events_fts MATCH 'zebra'").all();
      expect(after1.length).toBe(0);
      const after2 = db.query("SELECT rowid FROM raw_events_fts WHERE raw_events_fts MATCH 'giraffe'").all();
      expect(after2.length).toBe(0);

      db.close();
    });

    test("raw_events rows still exist after FTS5 cleanup", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const ev1 = insertRawEvent(db, 1, "user", "text", "preserved content");
      const memId = createMemory(db, "summary", 0.7, [ev1]);

      cleanupConsolidatedFromFts(db, [memId]);

      // Row still exists in raw_events
      const row = db.query("SELECT id FROM raw_events WHERE id = ?").get(ev1);
      expect(row).not.toBeNull();

      db.close();
    });

    test("empty input is no-op", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const result = cleanupConsolidatedFromFts(db, []);
      expect(result).toBe(0);

      db.close();
    });
  });

  describe("memory types", () => {
    test("createMemory with type param stores correct type", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const factId = createMemory(db, "user's dog is Biscuit", 0.7, [], "fact");
      const affId = createMemory(db, "that was tense", 0.6, [], "affective");

      const factMem = db.query("SELECT type FROM memories WHERE id = ?").get(factId) as any;
      expect(factMem.type).toBe("fact");

      const affMem = db.query("SELECT type FROM memories WHERE id = ?").get(affId) as any;
      expect(affMem.type).toBe("affective");

      db.close();
    });

    test("createMemory defaults to 'episodic'", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const id = createMemory(db, "something happened", 0.5, []);
      const mem = db.query("SELECT type FROM memories WHERE id = ?").get(id) as any;
      expect(mem.type).toBe("episodic");

      db.close();
    });

    test("supersedeMemory: archived_at set, no [SUPERSEDED] prefix, content preserved", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const oldId = createMemory(db, "Wrong answer", 0.7, []);
      supersedeMemory(db, oldId, "Correct answer", 0.85, []);

      const old = db.query("SELECT * FROM memories WHERE id = ?").get(oldId) as any;
      expect(old.content).toBe("Wrong answer"); // original content preserved
      expect(old.archived_at).not.toBeNull();
      expect(old.content).not.toContain("[SUPERSEDED]");

      db.close();
    });

    test("queryMemories excludes archived by default", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const activeId = createMemory(db, "active searchable elephant", 0.7, []);
      const archivedId = createMemory(db, "archived searchable giraffe", 0.5, []);

      // Archive one
      db.run("UPDATE memories SET archived_at = ? WHERE id = ?", [Date.now(), archivedId]);

      const results = queryMemories(db);
      expect(results.length).toBe(1);
      expect(results[0]!.id).toBe(activeId);

      db.close();
    });

    test("queryMemories includes archived when flag set", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      createMemory(db, "active memory", 0.7, []);
      const archivedId = createMemory(db, "archived memory", 0.5, []);
      db.run("UPDATE memories SET archived_at = ? WHERE id = ?", [Date.now(), archivedId]);

      const results = queryMemories(db, { includeArchived: true });
      expect(results.length).toBe(2);

      db.close();
    });

    test("evolveIdentity: old archived with type=identity", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const { newId: oldId } = evolveIdentity(db, "Self v1", []);
      evolveIdentity(db, "Self v2", []);

      const old = db.query("SELECT type, archived_at FROM memories WHERE id = ?").get(oldId) as any;
      expect(old.type).toBe("identity");
      expect(old.archived_at).not.toBeNull();

      db.close();
    });

    test("evolveRelationship: old archived with preserved content", () => {
      const { db, path } = tempDb();
      cleanup.push(path);

      const { newId: oldId } = evolveRelationship(db, "Rel v1", []);
      evolveRelationship(db, "Rel v2", []);

      const old = db.query("SELECT content, archived_at FROM memories WHERE id = ?").get(oldId) as any;
      expect(old.content).toBe("Rel v1");
      expect(old.archived_at).not.toBeNull();

      db.close();
    });
  });
});
