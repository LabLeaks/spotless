/**
 * SQLite database connection and schema initialization.
 *
 * Per-agent SQLite at ~/.spotless/agents/<name>/spotless.db
 * WAL mode, foreign keys ON, busy_timeout 5000ms on every connection.
 */

import { Database } from "bun:sqlite";

const SCHEMA = `
-- Tier 1: Eidetic Archive
CREATE TABLE IF NOT EXISTS raw_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  message_group INTEGER NOT NULL,
  role TEXT NOT NULL,
  content_type TEXT NOT NULL,
  content TEXT NOT NULL,
  is_subagent INTEGER DEFAULT 0,
  metadata JSON
);

CREATE INDEX IF NOT EXISTS idx_raw_timestamp ON raw_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_raw_not_thinking ON raw_events(timestamp) WHERE content_type != 'thinking';
CREATE INDEX IF NOT EXISTS idx_raw_human_turns ON raw_events(id) WHERE role = 'user' AND content_type = 'text' AND is_subagent = 0;
CREATE INDEX IF NOT EXISTS idx_raw_message_group ON raw_events(message_group);
`;

// --- Tier 2: Engram Network ---

const TIER2_SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  salience REAL NOT NULL DEFAULT 0.5,
  created_at INTEGER NOT NULL,
  last_accessed INTEGER NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL DEFAULT 'episodic' CHECK(type IN ('episodic','fact','affective','identity')),
  archived_at INTEGER
);

CREATE TABLE IF NOT EXISTS memory_sources (
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  raw_event_id INTEGER NOT NULL REFERENCES raw_events(id),
  PRIMARY KEY (memory_id, raw_event_id)
);

CREATE TABLE IF NOT EXISTS associations (
  source_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  strength REAL NOT NULL DEFAULT 0.1,
  reinforcement_count INTEGER NOT NULL DEFAULT 1,
  last_reinforced INTEGER NOT NULL,
  PRIMARY KEY (source_id, target_id),
  CHECK (source_id < target_id)
);

CREATE TABLE IF NOT EXISTS retrieval_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS retrieval_log_entries (
  log_id INTEGER NOT NULL REFERENCES retrieval_log(id) ON DELETE CASCADE,
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  PRIMARY KEY (log_id, memory_id)
);

CREATE INDEX IF NOT EXISTS idx_memories_salience ON memories(salience DESC);
CREATE INDEX IF NOT EXISTS idx_memories_accessed ON memories(last_accessed DESC);
CREATE INDEX IF NOT EXISTS idx_assoc_strength ON associations(strength DESC);
CREATE INDEX IF NOT EXISTS idx_assoc_source ON associations(source_id, strength DESC);
CREATE INDEX IF NOT EXISTS idx_assoc_target ON associations(target_id, strength DESC);

-- Working Self: 3-row registry pointing into the memory graph
CREATE TABLE IF NOT EXISTS identity_nodes (
  role TEXT PRIMARY KEY,
  memory_id INTEGER REFERENCES memories(id) ON DELETE SET NULL
);
`;

// --- Diagnostic tables ---

const DIAGNOSTIC_SCHEMA = `
CREATE TABLE IF NOT EXISTS dream_passes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  ops_requested INTEGER NOT NULL DEFAULT 0,
  ops_executed INTEGER NOT NULL DEFAULT 0,
  memories_created INTEGER NOT NULL DEFAULT 0,
  memories_merged INTEGER NOT NULL DEFAULT 0,
  memories_pruned INTEGER NOT NULL DEFAULT 0,
  memories_superseded INTEGER NOT NULL DEFAULT 0,
  associations_created INTEGER NOT NULL DEFAULT 0,
  identity_ops INTEGER NOT NULL DEFAULT 0,
  errors TEXT
);

CREATE TABLE IF NOT EXISTS hippocampus_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  memory_ids TEXT,
  memory_count INTEGER NOT NULL DEFAULT 0,
  cue_text TEXT
);
`;

// FTS5 doesn't support IF NOT EXISTS — must check programmatically
const FTS5_SCHEMA = `
CREATE VIRTUAL TABLE raw_events_fts USING fts5(content, content=raw_events, content_rowid=id);
`;

const FTS5_TRIGGER = `
CREATE TRIGGER IF NOT EXISTS raw_events_fts_insert AFTER INSERT ON raw_events
  WHEN new.content_type != 'thinking' BEGIN
  INSERT INTO raw_events_fts(rowid, content) VALUES (new.id, new.content);
END;
`;

const MEMORIES_FTS5_SCHEMA = `
CREATE VIRTUAL TABLE memories_fts USING fts5(content, content=memories, content_rowid=id);
`;

const MEMORIES_FTS5_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories
  WHEN new.archived_at IS NULL BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
  -- Remove old entry if it was in FTS5 (was active)
  INSERT INTO memories_fts(memories_fts, rowid, content)
    SELECT 'delete', old.id, old.content WHERE old.archived_at IS NULL;
  -- Add new entry only if still active
  INSERT INTO memories_fts(rowid, content)
    SELECT new.id, new.content WHERE new.archived_at IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories
  WHEN old.archived_at IS NULL BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
`;

/**
 * Open a database connection with required pragmas.
 */
export function openDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  return db;
}

/**
 * Open a read-only database connection.
 * Safe for concurrent reads alongside WAL-mode writers.
 */
export function openReadonlyDb(dbPath: string): Database {
  const db = new Database(dbPath, { readonly: true });
  db.run("PRAGMA busy_timeout = 5000");
  return db;
}

/**
 * Migrate existing databases: add type and archived_at columns to memories.
 * Idempotent — safe to run on both fresh and existing databases.
 */
export function migrateMemoryTypes(db: Database): void {
  // Add columns (try/catch for idempotent — column may already exist)
  try {
    db.run("ALTER TABLE memories ADD COLUMN type TEXT NOT NULL DEFAULT 'episodic' CHECK(type IN ('episodic','fact','affective','identity'))");
  } catch {
    // Column already exists
  }

  try {
    db.run("ALTER TABLE memories ADD COLUMN archived_at INTEGER");
  } catch {
    // Column already exists
  }

  // Classify: identity_nodes references → type='identity'
  db.run(`
    UPDATE memories SET type = 'identity'
    WHERE id IN (SELECT memory_id FROM identity_nodes WHERE memory_id IS NOT NULL)
      AND type != 'identity'
  `);

  // Classify: [SUPERSEDED] content → type='fact', archived_at=created_at
  db.run(`
    UPDATE memories SET type = 'fact', archived_at = created_at
    WHERE content LIKE '[SUPERSEDED]%'
      AND archived_at IS NULL
  `);

  // Remove archived rows from FTS5
  const archived = db.query(
    "SELECT id, content FROM memories WHERE archived_at IS NOT NULL"
  ).all() as { id: number; content: string }[];

  for (const row of archived) {
    try {
      db.run(
        "INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', ?, ?)",
        [row.id, row.content]
      );
    } catch {
      // May not be in FTS5
    }
  }
}

/**
 * Rebuild memories_fts triggers to handle archived_at semantics.
 * Drops old triggers and recreates with archive-aware logic.
 */
function rebuildMemoriesFtsTriggers(db: Database): void {
  db.run("DROP TRIGGER IF EXISTS memories_fts_insert");
  db.run("DROP TRIGGER IF EXISTS memories_fts_update");
  db.run("DROP TRIGGER IF EXISTS memories_fts_delete");
  db.run(MEMORIES_FTS5_TRIGGERS);
}

/**
 * Initialize the schema. Idempotent — safe to run on existing databases.
 */
export function initSchema(db: Database): void {
  // Tier 1
  db.run(SCHEMA);

  // Tier 1 FTS5
  const rawFtsExists = db.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='raw_events_fts'"
  ).get();
  if (!rawFtsExists) {
    db.run(FTS5_SCHEMA);
  }
  db.run(FTS5_TRIGGER);

  // Tier 2
  db.run(TIER2_SCHEMA);

  // Diagnostic tables
  db.run(DIAGNOSTIC_SCHEMA);

  // Tier 2 FTS5
  const memoriesFtsExists = db.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'"
  ).get();
  if (!memoriesFtsExists) {
    db.run(MEMORIES_FTS5_SCHEMA);
  }

  // Always rebuild triggers to ensure archive-aware versions
  rebuildMemoriesFtsTriggers(db);

  // Migrate existing DBs: add type/archived_at columns, classify rows
  migrateMemoryTypes(db);
}

/**
 * Get the current max message_group from the database.
 * Used to initialize the proxy's message_group counter on startup.
 */
export function getMaxMessageGroup(db: Database): number {
  const row = db.query("SELECT COALESCE(MAX(message_group), 0) as max_group FROM raw_events").get() as { max_group: number } | null;
  return row?.max_group ?? 0;
}
