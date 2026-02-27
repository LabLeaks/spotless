import { test, expect, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb, initSchema, getMaxMessageGroup, migrateMemoryTypes } from "../src/db.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

function tempDb(): { db: Database; path: string } {
  const path = join(tmpdir(), `spotless-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = openDb(path);
  initSchema(db);
  return { db, path };
}

describe("database", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const p of cleanup) {
      try { unlinkSync(p); } catch {}
      try { unlinkSync(p + "-wal"); } catch {}
      try { unlinkSync(p + "-shm"); } catch {}
    }
    cleanup.length = 0;
  });

  test("pragmas are set correctly", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const fk = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(fk.foreign_keys).toBe(1);

    const journal = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(journal.journal_mode).toBe("wal");

    const timeout = db.query("PRAGMA busy_timeout").get() as { timeout: number };
    expect(timeout.timeout).toBe(5000);

    db.close();
  });

  test("schema creates all tables and indexes", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("raw_events");
    expect(tableNames).toContain("raw_events_fts");

    db.close();
  });

  test("FTS5 trigger indexes non-thinking content", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    // Insert a text event — should be indexed
    db.run(
      "INSERT INTO raw_events (timestamp, message_group, role, content_type, content) VALUES (?, ?, ?, ?, ?)",
      [Date.now(), 1, "user", "text", "hello world from the user"]
    );

    // Insert a thinking event — should NOT be indexed
    db.run(
      "INSERT INTO raw_events (timestamp, message_group, role, content_type, content) VALUES (?, ?, ?, ?, ?)",
      [Date.now(), 1, "assistant", "thinking", "let me think about this"]
    );

    const ftsResults = db.query("SELECT rowid FROM raw_events_fts WHERE raw_events_fts MATCH 'hello'").all();
    expect(ftsResults.length).toBe(1);

    const noThinking = db.query("SELECT rowid FROM raw_events_fts WHERE raw_events_fts MATCH 'think'").all();
    expect(noThinking.length).toBe(0);

    db.close();
  });

  test("schema init is idempotent", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    // Should not throw
    initSchema(db);
    initSchema(db);

    db.close();
  });

  test("getMaxMessageGroup returns 0 on empty db", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    expect(getMaxMessageGroup(db)).toBe(0);

    db.close();
  });

  test("getMaxMessageGroup returns max after inserts", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    db.run(
      "INSERT INTO raw_events (timestamp, message_group, role, content_type, content) VALUES (?, ?, ?, ?, ?)",
      [Date.now(), 5, "user", "text", "hello"]
    );
    db.run(
      "INSERT INTO raw_events (timestamp, message_group, role, content_type, content) VALUES (?, ?, ?, ?, ?)",
      [Date.now(), 10, "assistant", "text", "hi"]
    );

    expect(getMaxMessageGroup(db)).toBe(10);

    db.close();
  });
});

describe("tier 2 schema", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const p of cleanup) {
      try { unlinkSync(p); } catch {}
      try { unlinkSync(p + "-wal"); } catch {}
      try { unlinkSync(p + "-shm"); } catch {}
    }
    cleanup.length = 0;
  });

  test("Tier 2 tables exist after initSchema on fresh DB", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const tables = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain("memories");
    expect(names).toContain("memory_sources");
    expect(names).toContain("associations");
    expect(names).toContain("retrieval_log");
    expect(names).toContain("retrieval_log_entries");
    expect(names).toContain("memories_fts");

    db.close();
  });

  test("Tier 2 tables added to existing Tier 1 DB (idempotent)", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    // Second init should not throw
    initSchema(db);

    const tables = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain("memories");
    expect(names).toContain("associations");

    db.close();
  });

  test("CASCADE: delete memory removes memory_sources rows", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const now = Date.now();
    // Insert a raw event to reference
    db.run(
      "INSERT INTO raw_events (timestamp, message_group, role, content_type, content) VALUES (?, ?, ?, ?, ?)",
      [now, 1, "user", "text", "test content"]
    );
    const rawId = (db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id;

    // Insert a memory
    db.run(
      "INSERT INTO memories (content, salience, created_at, last_accessed) VALUES (?, ?, ?, ?)",
      ["test memory", 0.5, now, now]
    );
    const memId = (db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id;

    // Link them
    db.run("INSERT INTO memory_sources (memory_id, raw_event_id) VALUES (?, ?)", [memId, rawId]);

    // Verify link exists
    const before = db.query("SELECT COUNT(*) as c FROM memory_sources WHERE memory_id = ?").get(memId) as { c: number };
    expect(before.c).toBe(1);

    // Delete the memory
    db.run("DELETE FROM memories WHERE id = ?", [memId]);

    // memory_sources should be gone
    const after = db.query("SELECT COUNT(*) as c FROM memory_sources WHERE memory_id = ?").get(memId) as { c: number };
    expect(after.c).toBe(0);

    db.close();
  });

  test("CASCADE: delete memory removes association rows", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const now = Date.now();
    // Insert two memories
    db.run("INSERT INTO memories (content, salience, created_at, last_accessed) VALUES (?, ?, ?, ?)", ["mem A", 0.5, now, now]);
    const idA = (db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id;
    db.run("INSERT INTO memories (content, salience, created_at, last_accessed) VALUES (?, ?, ?, ?)", ["mem B", 0.5, now, now]);
    const idB = (db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id;

    // Create association (canonical: smaller id first)
    const [lo, hi] = idA < idB ? [idA, idB] : [idB, idA];
    db.run(
      "INSERT INTO associations (source_id, target_id, strength, last_reinforced) VALUES (?, ?, ?, ?)",
      [lo, hi, 0.5, now]
    );

    // Delete first memory — association should cascade
    db.run("DELETE FROM memories WHERE id = ?", [idA]);

    const after = db.query("SELECT COUNT(*) as c FROM associations").get() as { c: number };
    expect(after.c).toBe(0);

    db.close();
  });

  test("CHECK: associations rejects source_id >= target_id", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const now = Date.now();
    db.run("INSERT INTO memories (content, salience, created_at, last_accessed) VALUES (?, ?, ?, ?)", ["mem A", 0.5, now, now]);
    const idA = (db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id;
    db.run("INSERT INTO memories (content, salience, created_at, last_accessed) VALUES (?, ?, ?, ?)", ["mem B", 0.5, now, now]);
    const idB = (db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id;

    const [lo, hi] = idA < idB ? [idA, idB] : [idB, idA];

    // source_id == target_id should fail
    expect(() => {
      db.run(
        "INSERT INTO associations (source_id, target_id, strength, last_reinforced) VALUES (?, ?, ?, ?)",
        [lo, lo, 0.5, now]
      );
    }).toThrow();

    // source_id > target_id should fail
    expect(() => {
      db.run(
        "INSERT INTO associations (source_id, target_id, strength, last_reinforced) VALUES (?, ?, ?, ?)",
        [hi, lo, 0.5, now]
      );
    }).toThrow();

    db.close();
  });

  test("memories FTS5 stays in sync on insert", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const now = Date.now();
    db.run(
      "INSERT INTO memories (content, salience, created_at, last_accessed) VALUES (?, ?, ?, ?)",
      ["the quick brown fox jumps", 0.7, now, now]
    );

    const results = db.query("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'quick'").all();
    expect(results.length).toBe(1);

    db.close();
  });

  test("memories FTS5 stays in sync on update", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const now = Date.now();
    db.run(
      "INSERT INTO memories (content, salience, created_at, last_accessed) VALUES (?, ?, ?, ?)",
      ["original content here", 0.5, now, now]
    );
    const id = (db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id;

    // Update content
    db.run("UPDATE memories SET content = ? WHERE id = ?", ["replaced content now", id]);

    // Old term gone
    const oldResults = db.query("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'original'").all();
    expect(oldResults.length).toBe(0);

    // New term found
    const newResults = db.query("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'replaced'").all();
    expect(newResults.length).toBe(1);

    db.close();
  });

  test("memories FTS5 stays in sync on delete", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const now = Date.now();
    db.run(
      "INSERT INTO memories (content, salience, created_at, last_accessed) VALUES (?, ?, ?, ?)",
      ["deletable content xyz", 0.3, now, now]
    );
    const id = (db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id;

    db.run("DELETE FROM memories WHERE id = ?", [id]);

    const results = db.query("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'deletable'").all();
    expect(results.length).toBe(0);

    db.close();
  });

  test("retrieval_log CASCADE: delete log removes entries", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const now = Date.now();
    // Create a memory
    db.run("INSERT INTO memories (content, salience, created_at, last_accessed) VALUES (?, ?, ?, ?)", ["mem", 0.5, now, now]);
    const memId = (db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id;

    // Create a retrieval log entry
    db.run("INSERT INTO retrieval_log (timestamp) VALUES (?)", [now]);
    const logId = (db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id;

    db.run("INSERT INTO retrieval_log_entries (log_id, memory_id) VALUES (?, ?)", [logId, memId]);

    // Delete the log
    db.run("DELETE FROM retrieval_log WHERE id = ?", [logId]);

    const after = db.query("SELECT COUNT(*) as c FROM retrieval_log_entries").get() as { c: number };
    expect(after.c).toBe(0);

    db.close();
  });
});

describe("memory type architecture", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const p of cleanup) {
      try { unlinkSync(p); } catch {}
      try { unlinkSync(p + "-wal"); } catch {}
      try { unlinkSync(p + "-shm"); } catch {}
    }
    cleanup.length = 0;
  });

  test("type and archived_at columns exist after initSchema on fresh DB", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const columns = db.query("PRAGMA table_info(memories)").all() as { name: string }[];
    const colNames = columns.map(c => c.name);

    expect(colNames).toContain("type");
    expect(colNames).toContain("archived_at");

    db.close();
  });

  test("type column defaults to 'episodic'", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const now = Date.now();
    db.run(
      "INSERT INTO memories (content, salience, created_at, last_accessed) VALUES (?, ?, ?, ?)",
      ["test memory", 0.5, now, now]
    );
    const row = db.query("SELECT type, archived_at FROM memories").get() as { type: string; archived_at: number | null };
    expect(row.type).toBe("episodic");
    expect(row.archived_at).toBeNull();

    db.close();
  });

  test("CHECK constraint rejects invalid types", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const now = Date.now();
    expect(() => {
      db.run(
        "INSERT INTO memories (content, salience, created_at, last_accessed, type) VALUES (?, ?, ?, ?, ?)",
        ["bad type", 0.5, now, now, "invalid"]
      );
    }).toThrow();

    db.close();
  });

  test("valid types accepted: episodic, fact, affective, identity", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const now = Date.now();
    for (const type of ["episodic", "fact", "affective", "identity"]) {
      db.run(
        "INSERT INTO memories (content, salience, created_at, last_accessed, type) VALUES (?, ?, ?, ?, ?)",
        [`${type} memory`, 0.5, now, now, type]
      );
    }
    const count = (db.query("SELECT COUNT(*) as c FROM memories").get() as { c: number }).c;
    expect(count).toBe(4);

    db.close();
  });

  test("FTS5 excludes archived rows on INSERT", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const now = Date.now();
    // Insert active memory
    db.run(
      "INSERT INTO memories (content, salience, created_at, last_accessed, type) VALUES (?, ?, ?, ?, ?)",
      ["active unicorn memory", 0.5, now, now, "episodic"]
    );
    // Insert archived memory
    db.run(
      "INSERT INTO memories (content, salience, created_at, last_accessed, type, archived_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["archived phoenix memory", 0.5, now, now, "fact", now]
    );

    const activeResults = db.query("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'unicorn'").all();
    expect(activeResults.length).toBe(1);

    const archivedResults = db.query("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'phoenix'").all();
    expect(archivedResults.length).toBe(0);

    db.close();
  });

  test("FTS5 removes entry when archived_at set via UPDATE", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const now = Date.now();
    db.run(
      "INSERT INTO memories (content, salience, created_at, last_accessed, type) VALUES (?, ?, ?, ?, ?)",
      ["searchable dragon content", 0.5, now, now, "fact"]
    );
    const id = (db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id;

    // Should be in FTS5
    let results = db.query("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'dragon'").all();
    expect(results.length).toBe(1);

    // Archive it
    db.run("UPDATE memories SET archived_at = ? WHERE id = ?", [now, id]);

    // Should be removed from FTS5
    results = db.query("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'dragon'").all();
    expect(results.length).toBe(0);

    db.close();
  });

  test("migration classifies identity_nodes references as identity type", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const now = Date.now();
    // Create a memory and point identity_nodes at it
    db.run(
      "INSERT INTO memories (content, salience, created_at, last_accessed) VALUES (?, ?, ?, ?)",
      ["I am nova, a coding agent", 0.9, now, now]
    );
    const memId = (db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id;
    db.run("INSERT OR REPLACE INTO identity_nodes (role, memory_id) VALUES (?, ?)", ["self", memId]);

    // Run migration again
    migrateMemoryTypes(db);

    const row = db.query("SELECT type FROM memories WHERE id = ?").get(memId) as { type: string };
    expect(row.type).toBe("identity");

    db.close();
  });

  test("migration classifies [SUPERSEDED] content as archived fact", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const now = Date.now();
    db.run(
      "INSERT INTO memories (content, salience, created_at, last_accessed) VALUES (?, ?, ?, ?)",
      ["[SUPERSEDED] User's dog is named Rex", 0.1, now, now]
    );
    const id = (db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id;

    // Run migration
    migrateMemoryTypes(db);

    const row = db.query("SELECT type, archived_at FROM memories WHERE id = ?").get(id) as { type: string; archived_at: number | null };
    expect(row.type).toBe("fact");
    expect(row.archived_at).not.toBeNull();

    db.close();
  });

  test("migration is idempotent (run twice)", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    // Run migration twice — should not throw
    migrateMemoryTypes(db);
    migrateMemoryTypes(db);

    // Verify schema still works
    const now = Date.now();
    db.run(
      "INSERT INTO memories (content, salience, created_at, last_accessed, type) VALUES (?, ?, ?, ?, ?)",
      ["test", 0.5, now, now, "fact"]
    );
    const count = (db.query("SELECT COUNT(*) as c FROM memories").get() as { c: number }).c;
    expect(count).toBe(1);

    db.close();
  });
});
