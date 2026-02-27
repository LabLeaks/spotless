/**
 * Dream tool functions — pure SQLite operations for the dreaming orchestrator.
 *
 * 16 functions that read/write Tier 2 (memories, associations, identity_nodes)
 * and query Tier 1 (raw_events) for consolidation. No LLM calls.
 */

import type { Database } from "bun:sqlite";
import type { Memory, Association, MemoryType } from "./types.ts";
import { sanitizeFts5Query } from "./recall.ts";

// --- Query functions ---

interface MemoryWithAssociationCount extends Memory {
  association_count: number;
}

interface QueryMemoriesFilter {
  query?: string;    // FTS5 match
  minSalience?: number;
  limit?: number;
  includeArchived?: boolean;
}

/**
 * Query memories, optionally with FTS5 search. Joins association count.
 * By default excludes archived memories (archived_at IS NOT NULL).
 */
export function queryMemories(
  db: Database,
  filter?: QueryMemoriesFilter,
): MemoryWithAssociationCount[] {
  const limit = filter?.limit ?? 100;
  const archiveFilter = filter?.includeArchived ? "" : "AND m.archived_at IS NULL";

  if (filter?.query) {
    // FTS5 search — sanitize query to prevent syntax errors
    const sanitized = sanitizeFts5Query(filter.query);
    if (!sanitized) return [];

    try {
      const rows = db.query(`
        SELECT m.*, (
          SELECT COUNT(*) FROM associations a
          WHERE a.source_id = m.id OR a.target_id = m.id
        ) AS association_count
        FROM memories m
        JOIN memories_fts f ON f.rowid = m.id
        WHERE memories_fts MATCH ?
        ${filter.minSalience != null ? "AND m.salience >= ?" : ""}
        ${archiveFilter}
        ORDER BY m.salience DESC
        LIMIT ?
      `).all(
        ...[
          sanitized,
          ...(filter.minSalience != null ? [filter.minSalience] : []),
          limit,
        ],
      ) as MemoryWithAssociationCount[];
      return rows;
    } catch {
      // FTS5 query error — return empty results
      return [];
    }
  }

  if (filter?.minSalience != null) {
    return db.query(`
      SELECT m.*, (
        SELECT COUNT(*) FROM associations a
        WHERE a.source_id = m.id OR a.target_id = m.id
      ) AS association_count
      FROM memories m
      WHERE m.salience >= ?
      ${archiveFilter}
      ORDER BY m.salience DESC
      LIMIT ?
    `).all(filter.minSalience, limit) as MemoryWithAssociationCount[];
  }

  return db.query(`
    SELECT m.*, (
      SELECT COUNT(*) FROM associations a
      WHERE a.source_id = m.id OR a.target_id = m.id
    ) AS association_count
    FROM memories m
    WHERE 1=1 ${archiveFilter}
    ORDER BY m.salience DESC
    LIMIT ?
  `).all(limit) as MemoryWithAssociationCount[];
}

interface QueryRawEventsOpts {
  limit?: number;               // max message_groups (not rows)
  unconsolidatedOnly?: boolean;  // exclude events linked via memory_sources
  newestFirst?: boolean;         // DESC ordering (for hippocampus recent context)
}

interface RawEventGroup {
  message_group: number;
  events: {
    id: number;
    role: string;
    content_type: string;
    content: string;
    timestamp: number;
  }[];
}

/**
 * Query raw events grouped by message_group.
 * Excludes thinking blocks and subagent content.
 * `limit` applies to message_groups, not individual rows.
 * `unconsolidatedOnly` excludes events that already have memory_sources links.
 */
export function queryRawEvents(
  db: Database,
  opts?: QueryRawEventsOpts,
): RawEventGroup[] {
  const groupLimit = opts?.limit ?? 50;
  const sortDir = opts?.newestFirst ? "DESC" : "ASC";

  // First, get the distinct message groups
  let groupQuery: string;
  if (opts?.unconsolidatedOnly) {
    groupQuery = `
      SELECT DISTINCT r.message_group
      FROM raw_events r
      WHERE r.is_subagent = 0
        AND r.content_type != 'thinking'
        AND r.content != '<session-boundary />'
        AND r.content NOT LIKE '<system-reminder>%'
        AND r.id NOT IN (SELECT raw_event_id FROM memory_sources)
      ORDER BY r.message_group ${sortDir}
      LIMIT ?
    `;
  } else {
    groupQuery = `
      SELECT DISTINCT message_group
      FROM raw_events
      WHERE is_subagent = 0
        AND content_type != 'thinking'
        AND content != '<session-boundary />'
        AND content NOT LIKE '<system-reminder>%'
      ORDER BY message_group ${sortDir}
      LIMIT ?
    `;
  }

  const groups = db.query(groupQuery).all(groupLimit) as { message_group: number }[];
  if (groups.length === 0) return [];

  const groupIds = groups.map((g) => g.message_group);
  const placeholders = groupIds.map(() => "?").join(",");

  // Get all rows for those groups, excluding session boundaries and system reminders
  const rows = db.query(`
    SELECT id, message_group, role, content_type, content, timestamp
    FROM raw_events
    WHERE message_group IN (${placeholders})
      AND is_subagent = 0
      AND content_type != 'thinking'
      AND content != '<session-boundary />'
      AND content NOT LIKE '<system-reminder>%'
    ORDER BY id ASC
  `).all(...groupIds) as {
    id: number;
    message_group: number;
    role: string;
    content_type: string;
    content: string;
    timestamp: number;
  }[];

  // Group by message_group
  const result: RawEventGroup[] = [];
  const groupMap = new Map<number, RawEventGroup>();

  for (const row of rows) {
    let group = groupMap.get(row.message_group);
    if (!group) {
      group = { message_group: row.message_group, events: [] };
      groupMap.set(row.message_group, group);
      result.push(group);
    }
    group.events.push({
      id: row.id,
      role: row.role,
      content_type: row.content_type,
      content: row.content,
      timestamp: row.timestamp,
    });
  }

  return result;
}

/**
 * Get all associations for a memory (bidirectional).
 */
export function getAssociations(
  db: Database,
  memoryId: number,
): (Association & { connected_id: number })[] {
  return db.query(`
    SELECT source_id, target_id, strength, reinforcement_count, last_reinforced,
           target_id AS connected_id
    FROM associations WHERE source_id = ?
    UNION ALL
    SELECT source_id, target_id, strength, reinforcement_count, last_reinforced,
           source_id AS connected_id
    FROM associations WHERE target_id = ?
  `).all(memoryId, memoryId) as (Association & { connected_id: number })[];
}

// --- Mutation functions ---

/**
 * Create a memory with optional source event links.
 * Returns the new memory ID.
 */
export function createMemory(
  db: Database,
  content: string,
  salience: number,
  sourceEventIds: number[],
  type: MemoryType = "episodic",
): number {
  const now = Date.now();
  db.run(
    "INSERT INTO memories (content, salience, created_at, last_accessed, type) VALUES (?, ?, ?, ?, ?)",
    [content, salience, now, now, type],
  );
  const id = (db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id;

  if (sourceEventIds.length > 0) {
    const stmt = db.prepare("INSERT OR IGNORE INTO memory_sources (memory_id, raw_event_id) VALUES (?, ?)");
    for (const eventId of sourceEventIds) {
      stmt.run(id, eventId);
    }
  }

  return id;
}

/**
 * Create or strengthen an association between two memories.
 * Canonical ordering enforced (source_id < target_id).
 * On conflict: take max strength, increment reinforcement_count.
 */
export function createAssociation(
  db: Database,
  a: number,
  b: number,
  strength: number,
): void {
  if (a === b) return; // no self-loops

  const [lo, hi] = a < b ? [a, b] : [b, a];
  const now = Date.now();

  db.run(`
    INSERT INTO associations (source_id, target_id, strength, reinforcement_count, last_reinforced)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(source_id, target_id) DO UPDATE SET
      strength = MAX(associations.strength, excluded.strength),
      reinforcement_count = associations.reinforcement_count + 1,
      last_reinforced = excluded.last_reinforced
  `, [lo, hi, strength, now]);
}

/**
 * Partial update of a memory's content and/or salience.
 */
export function updateMemory(
  db: Database,
  id: number,
  updates: { content?: string; salience?: number },
): void {
  const sets: string[] = [];
  const params: (string | number)[] = [];

  if (updates.content !== undefined) {
    sets.push("content = ?");
    params.push(updates.content);
  }
  if (updates.salience !== undefined) {
    sets.push("salience = ?");
    params.push(updates.salience);
  }

  if (sets.length === 0) return;

  params.push(id);
  db.run(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`, params);
}

/**
 * Merge multiple memories into one.
 *
 * Transaction:
 * 1. Read associations from all source memories
 * 2. Create merged memory with combined source links
 * 3. Transfer strongest associations (avoiding self-loops)
 * 4. Delete originals (CASCADE cleans up old associations + memory_sources)
 *
 * Returns new memory ID.
 */
export function mergeMemories(
  db: Database,
  sourceIds: number[],
  content: string,
  salience: number,
  type: MemoryType = "episodic",
): number {
  if (sourceIds.length === 0) throw new Error("mergeMemories: no source IDs");

  return db.transaction(() => {
    const placeholders = sourceIds.map(() => "?").join(",");

    // Gather all source event links from originals
    const sourceLinks = db.query(
      `SELECT DISTINCT raw_event_id FROM memory_sources WHERE memory_id IN (${placeholders})`
    ).all(...sourceIds) as { raw_event_id: number }[];

    // Gather all associations from originals
    const existingAssocs = db.query(`
      SELECT source_id, target_id, strength, reinforcement_count, last_reinforced
      FROM associations
      WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})
    `).all(...sourceIds, ...sourceIds) as Association[];

    // Create the merged memory
    const now = Date.now();
    db.run(
      "INSERT INTO memories (content, salience, created_at, last_accessed, type) VALUES (?, ?, ?, ?, ?)",
      [content, salience, now, now, type],
    );
    const newId = (db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id;

    // Transfer source links
    const insertSource = db.prepare(
      "INSERT OR IGNORE INTO memory_sources (memory_id, raw_event_id) VALUES (?, ?)"
    );
    for (const link of sourceLinks) {
      insertSource.run(newId, link.raw_event_id);
    }

    // Build association map: for each external memory, keep the strongest connection
    const sourceIdSet = new Set(sourceIds);
    const assocMap = new Map<number, { strength: number; reinforcement_count: number }>();

    for (const a of existingAssocs) {
      let otherId: number | null = null;
      if (sourceIdSet.has(a.source_id) && !sourceIdSet.has(a.target_id)) {
        otherId = a.target_id;
      } else if (sourceIdSet.has(a.target_id) && !sourceIdSet.has(a.source_id)) {
        otherId = a.source_id;
      }
      if (otherId === null) continue;

      const existing = assocMap.get(otherId);
      if (!existing || a.strength > existing.strength) {
        assocMap.set(otherId, {
          strength: a.strength,
          reinforcement_count: a.reinforcement_count,
        });
      }
    }

    // Delete originals — CASCADE removes their associations + memory_sources
    db.run(`DELETE FROM memories WHERE id IN (${placeholders})`, sourceIds);

    // Create transferred associations with the new memory
    for (const [otherId, data] of assocMap) {
      const [lo, hi] = newId < otherId ? [newId, otherId] : [otherId, newId];
      db.run(`
        INSERT INTO associations (source_id, target_id, strength, reinforcement_count, last_reinforced)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(source_id, target_id) DO UPDATE SET
          strength = MAX(associations.strength, excluded.strength),
          reinforcement_count = associations.reinforcement_count + excluded.reinforcement_count,
          last_reinforced = excluded.last_reinforced
      `, [lo, hi, data.strength, data.reinforcement_count, now]);
    }

    return newId;
  })();
}

/**
 * Count human turns (user text, non-subagent) between two raw_event IDs (exclusive).
 */
export function countHumanTurnsBetween(
  db: Database,
  a: number,
  b: number,
): number {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const row = db.query(`
    SELECT COUNT(DISTINCT message_group) as count
    FROM raw_events
    WHERE id > ? AND id < ?
      AND role = 'user'
      AND content_type = 'text'
      AND is_subagent = 0
  `).get(lo, hi) as { count: number };
  return row.count;
}

/**
 * Prune a memory only if ALL THREE conditions are met:
 * 1. Low salience (< 0.3)
 * 2. Zero access count
 * 3. No associations or all associations weak (strength < 0.2)
 *
 * Returns true if pruned, false if conditions not met.
 */
export function pruneMemory(db: Database, id: number): boolean {
  const mem = db.query("SELECT salience, access_count FROM memories WHERE id = ?").get(id) as
    | { salience: number; access_count: number }
    | null;

  if (!mem) return false;

  // Condition 1: low salience
  if (mem.salience >= 0.3) return false;

  // Condition 2: zero access
  if (mem.access_count > 0) return false;

  // Condition 3: no associations or all weak
  const strongAssoc = db.query(`
    SELECT COUNT(*) as count FROM associations
    WHERE (source_id = ? OR target_id = ?) AND strength >= 0.2
  `).get(id, id) as { count: number };

  if (strongAssoc.count > 0) return false;

  // All conditions met — prune
  db.run("DELETE FROM memories WHERE id = ?", [id]);
  return true;
}

/**
 * Supersede a wrong memory with corrected content.
 *
 * The "I was wrong" operation:
 * 1. Validate target exists
 * 2. Create new memory with corrected content (type: fact)
 * 3. Archive old: set archived_at (FTS5 trigger removes from search)
 * 4. Duplicate associations from old → new
 * 5. Create strong association (0.9) between old and new (correction breadcrumb)
 *
 * Old memory is preserved (archived, not deleted) — its memory_sources links
 * prevent re-learning the wrong fact from raw events. Original content and
 * salience preserved for provenance.
 */
export function supersedeMemory(
  db: Database,
  targetId: number,
  correctedContent: string,
  salience: number,
  sourceEventIds: number[],
): { newId: number; oldId: number } {
  // 1. Validate target exists (before transaction — fail fast)
  const target = db.query("SELECT * FROM memories WHERE id = ?").get(targetId) as Memory | null;
  if (!target) throw new Error(`supersedeMemory: target memory ${targetId} does not exist`);

  return db.transaction(() => {
    // 2. Create new memory with corrected content (facts are current-state)
    const newId = createMemory(db, correctedContent, salience, sourceEventIds, "fact");

    // 3. Archive old memory (preserves original content and salience)
    const now = Date.now();
    db.run("UPDATE memories SET archived_at = ?, type = 'fact' WHERE id = ?", [now, targetId]);

    // 4. Duplicate associations from old → new
    const assocs = getAssociations(db, targetId);
    for (const a of assocs) {
      createAssociation(db, newId, a.connected_id, a.strength);
    }

    // 5. Create correction breadcrumb association (0.9)
    createAssociation(db, targetId, newId, 0.9);

    return { newId, oldId: targetId };
  })();
}

// --- Identity node evolution ---

interface EvolveNodeOpts {
  newSalience: number;
}

/**
 * Shared helper for evolving identity nodes (core, self, relationship).
 *
 * 1. Look up current node from identity_nodes registry
 * 2. If exists: create new, demote old, transfer associations + sources, link
 * 3. If not: create fresh
 * 4. Upsert registry
 *
 * All evolution functions share this pattern — they differ only in
 * role name, salience values, and link strength.
 */
function evolveNode(
  db: Database,
  role: string,
  newContent: string,
  sourceEventIds: number[],
  opts: EvolveNodeOpts,
): { newId: number; previousId: number | null } {
  return db.transaction(() => {
    // Look up current node from registry
    const registry = db.query(
      "SELECT memory_id FROM identity_nodes WHERE role = ? AND memory_id IS NOT NULL"
    ).get(role) as { memory_id: number } | null;

    let current: Memory | null = null;
    if (registry) {
      current = db.query("SELECT * FROM memories WHERE id = ?").get(registry.memory_id) as Memory | null;
    }

    if (current) {
      // Evolve existing node
      const newId = createMemory(db, newContent, opts.newSalience, sourceEventIds, "identity");

      // Transfer associations old → new
      const assocs = getAssociations(db, current.id);
      for (const a of assocs) {
        createAssociation(db, newId, a.connected_id, a.strength);
      }

      // Transfer memory_sources old → new
      const oldSources = db.query(
        "SELECT raw_event_id FROM memory_sources WHERE memory_id = ?"
      ).all(current.id) as { raw_event_id: number }[];
      const stmt = db.prepare("INSERT OR IGNORE INTO memory_sources (memory_id, raw_event_id) VALUES (?, ?)");
      for (const s of oldSources) {
        stmt.run(newId, s.raw_event_id);
      }

      // Archive old: preserved for provenance, excluded from FTS5 by trigger.
      const now = Date.now();
      db.run("UPDATE memories SET archived_at = ? WHERE id = ?", [now, current.id]);

      // Upsert registry
      db.run("INSERT OR REPLACE INTO identity_nodes (role, memory_id) VALUES (?, ?)", [role, newId]);

      return { newId, previousId: current.id };
    }

    // No existing node — create fresh
    const newId = createMemory(db, newContent, opts.newSalience, sourceEventIds, "identity");
    db.run("INSERT OR REPLACE INTO identity_nodes (role, memory_id) VALUES (?, ?)", [role, newId]);
    return { newId, previousId: null };
  })();
}

/**
 * Look up the current identity node for a role.
 * Returns null if no registry entry or memory deleted.
 */
function getRegistryNode(db: Database, role: string): Memory | null {
  const registry = db.query(
    "SELECT memory_id FROM identity_nodes WHERE role = ? AND memory_id IS NOT NULL"
  ).get(role) as { memory_id: number } | null;

  if (!registry) return null;
  return db.query("SELECT * FROM memories WHERE id = ?").get(registry.memory_id) as Memory | null;
}

// --- Identity tools ---

/**
 * Self-referential encoding: create a memory with richer connectivity.
 * Links to self-model node if it exists (identity-adjacent).
 */
export function reflectOnSelf(
  db: Database,
  insight: string,
  sourceEventIds: number[],
): { newId: number } {
  const newId = createMemory(db, insight, 0.85, sourceEventIds);

  const selfNode = getRegistryNode(db, "self");
  if (selfNode) {
    createAssociation(db, newId, selfNode.id, 0.8);
  }

  return { newId };
}

/**
 * Evolve the self-model node. Salience 0.9 / 0.2 (fades naturally).
 */
export function evolveIdentity(
  db: Database,
  newSelfModel: string,
  sourceEventIds: number[],
): { newId: number; previousId: number | null } {
  return evolveNode(db, "self", newSelfModel, sourceEventIds, {
    newSalience: 0.9,
  });
}

/**
 * Evolve the relationship-model node. Salience 0.85 / 0.2 (fades naturally).
 */
export function evolveRelationship(
  db: Database,
  newDynamic: string,
  sourceEventIds: number[],
): { newId: number; previousId: number | null } {
  return evolveNode(db, "relationship", newDynamic, sourceEventIds, {
    newSalience: 0.85,
  });
}

/**
 * Somatic marker: boost a memory's retrieval properties.
 * Salience +0.15 (capped at 0.95), associate to self-model if it exists.
 */
export function markSignificance(
  db: Database,
  memoryId: number,
): void {
  const mem = db.query("SELECT salience FROM memories WHERE id = ?").get(memoryId) as { salience: number } | null;
  if (!mem) throw new Error(`markSignificance: memory ${memoryId} does not exist`);

  const newSalience = Math.min(0.95, mem.salience + 0.15);
  updateMemory(db, memoryId, { salience: newSalience });

  const selfNode = getRegistryNode(db, "self");
  if (selfNode) {
    createAssociation(db, memoryId, selfNode.id, 0.6);
  }
}

/**
 * Remove consolidated raw events from raw_events_fts.
 * After dreaming processes events into memories, remove the FTS5 entries
 * so only unconsolidated events remain searchable (by future dreaming passes).
 * The raw_events rows themselves are preserved.
 *
 * Returns count of FTS5 entries cleaned.
 */
export function cleanupConsolidatedFromFts(
  db: Database,
  memoryIds: number[],
): number {
  if (memoryIds.length === 0) return 0;

  const placeholders = memoryIds.map(() => "?").join(",");
  const rows = db.query(`
    SELECT DISTINCT r.id, r.content
    FROM raw_events r
    JOIN memory_sources ms ON ms.raw_event_id = r.id
    WHERE ms.memory_id IN (${placeholders})
  `).all(...memoryIds) as { id: number; content: string }[];

  let cleaned = 0;
  for (const row of rows) {
    try {
      db.run(
        "INSERT INTO raw_events_fts(raw_events_fts, rowid, content) VALUES ('delete', ?, ?)",
        [row.id, row.content],
      );
      cleaned++;
    } catch {
      // May not be in FTS5 (already cleaned or thinking block)
    }
  }

  return cleaned;
}

/**
 * Drain the retrieval log: read co-retrieval sets, delete processed entries.
 * Returns arrays of memory IDs that were co-retrieved together.
 */
export function drainRetrievalLog(
  db: Database,
): number[][] {
  const logs = db.query(
    "SELECT id FROM retrieval_log ORDER BY id ASC"
  ).all() as { id: number }[];

  if (logs.length === 0) return [];

  const result: number[][] = [];

  for (const log of logs) {
    const entries = db.query(
      "SELECT memory_id FROM retrieval_log_entries WHERE log_id = ? ORDER BY memory_id"
    ).all(log.id) as { memory_id: number }[];

    if (entries.length > 0) {
      result.push(entries.map((e) => e.memory_id));
    }
  }

  // Delete all processed logs (CASCADE removes entries)
  db.run("DELETE FROM retrieval_log");

  return result;
}
