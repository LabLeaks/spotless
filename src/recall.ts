/**
 * Recall pipeline: FTS5 search + graph traversal + retrieval scoring.
 *
 * Used by the proxy (pre-computation before selector) and by selector
 * tool calls. Pure SQLite operations — no LLM calls.
 */

import type { Database } from "bun:sqlite";
import type { Memory } from "./types.ts";
import { getAssociations } from "./digest-tools.ts";

// --- Scoring ---

const ALPHA = 1.0; // recency weight
const BETA = 1.0;  // salience weight

/**
 * Score a memory by recency + salience.
 *
 * recency = 1 / (1 + hoursSinceNewest)
 *   where newest = MAX(created_at, last_accessed)
 * salience = memory.salience (already 0-1)
 */
export function scoreMemory(memory: Memory, now: number): number {
  const newest = Math.max(memory.created_at, memory.last_accessed);
  const hoursSince = Math.max(0, (now - newest) / (1000 * 60 * 60));
  const recency = 1 / (1 + hoursSince);
  return ALPHA * recency + BETA * memory.salience;
}

// --- Graph Traversal ---

export interface TraversalOpts {
  maxNodes?: number;        // max visited nodes (default 50)
  minEdgeStrength?: number; // minimum association strength to follow (default 0.1)
  maxResults?: number;      // max memories returned (default 30)
}

/**
 * BFS graph traversal from seed memory IDs.
 * Follows associations bidirectionally, collecting connected memories.
 * Returns scored memories sorted by score DESC.
 */
export function traverseGraph(
  db: Database,
  seedIds: number[],
  opts?: TraversalOpts,
): (Memory & { score: number })[] {
  const maxNodes = opts?.maxNodes ?? 50;
  const minEdgeStrength = opts?.minEdgeStrength ?? 0.1;
  const maxResults = opts?.maxResults ?? 30;
  const now = Date.now();

  if (seedIds.length === 0) return [];

  const visited = new Set<number>(seedIds);
  const frontier: number[] = [...seedIds];
  const collected: (Memory & { score: number })[] = [];

  // Collect seed memories (skip archived)
  for (const id of seedIds) {
    const mem = db.query("SELECT * FROM memories WHERE id = ? AND archived_at IS NULL").get(id) as Memory | null;
    if (mem) {
      collected.push({ ...mem, score: scoreMemory(mem, now) });
    }
  }

  // BFS
  while (frontier.length > 0 && visited.size < maxNodes) {
    const current = frontier.shift()!;
    const neighbors = getAssociations(db, current);

    for (const neighbor of neighbors) {
      if (neighbor.strength < minEdgeStrength) continue;
      if (visited.has(neighbor.connected_id)) continue;

      visited.add(neighbor.connected_id);

      const mem = db.query("SELECT * FROM memories WHERE id = ? AND archived_at IS NULL").get(neighbor.connected_id) as Memory | null;
      if (mem) {
        collected.push({ ...mem, score: scoreMemory(mem, now) });
        frontier.push(neighbor.connected_id);
      }

      if (visited.size >= maxNodes) break;
    }
  }

  // Sort by score DESC, return top maxResults
  collected.sort((a, b) => b.score - a.score);
  return collected.slice(0, maxResults);
}

// --- Main recall function ---

export interface RecallOpts extends TraversalOpts {
  // Future: additional filtering options
}

/**
 * Recall memories relevant to a cue string.
 *
 * 1. FTS5 match on memories_fts
 * 2. Spread activation from hits
 * 3. Score and rank results
 *
 * Returns scored memories sorted by score DESC.
 */
export function recall(
  db: Database,
  cue: string,
  opts?: RecallOpts,
): (Memory & { score: number })[] {
  if (!cue.trim()) return [];

  // FTS5 search — sanitize the query for FTS5 syntax
  const sanitized = sanitizeFts5Query(cue);
  if (!sanitized) return [];

  let seedIds: number[];
  try {
    const rows = db.query(`
      SELECT m.id FROM memories m
      JOIN memories_fts f ON f.rowid = m.id
      WHERE memories_fts MATCH ?
      LIMIT 20
    `).all(sanitized) as { id: number }[];
    seedIds = rows.map(r => r.id);
  } catch {
    // FTS5 query syntax error — return empty
    return [];
  }

  if (seedIds.length === 0) return [];

  return traverseGraph(db, seedIds, opts);
}

/**
 * Sanitize a user message into a valid FTS5 query.
 * Splits into words, wraps each in quotes, joins with OR.
 */
export function sanitizeFts5Query(text: string): string {
  const words = text
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 1); // skip single chars
  if (words.length === 0) return "";
  return words.map(w => `"${w}"`).join(" OR ");
}

// --- Identity nodes ---

export interface IdentityNode extends Memory {
  role: string;
}

/**
 * Get all working-self memories (self, relationship) from the registry.
 * Returns the role alongside each memory so the selector prompt can label them.
 */
export function getIdentityNodes(db: Database): IdentityNode[] {
  return db.query(`
    SELECT m.*, n.role FROM identity_nodes n
    JOIN memories m ON m.id = n.memory_id
    WHERE n.memory_id IS NOT NULL
      AND m.archived_at IS NULL
  `).all() as IdentityNode[];
}

// --- Access tracking ---

/**
 * Update last_accessed and increment access_count for each memory ID.
 * No-op on empty input, never throws.
 */
export function touchMemories(db: Database, ids: number[]): void {
  if (ids.length === 0) return;
  try {
    const now = Date.now();
    const stmt = db.prepare(
      "UPDATE memories SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?"
    );
    for (const id of ids) {
      stmt.run(now, id);
    }
  } catch {
    // Non-fatal — log silently
  }
}

// --- Retrieval logging ---

/**
 * Log a set of co-retrieved memory IDs to the retrieval log.
 * No-op on empty input, never throws.
 */
export function logRetrieval(db: Database, ids: number[]): void {
  if (ids.length === 0) return;
  try {
    const now = Date.now();
    db.run("INSERT INTO retrieval_log (timestamp) VALUES (?)", [now]);
    const logId = (db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id;

    const stmt = db.prepare(
      "INSERT OR IGNORE INTO retrieval_log_entries (log_id, memory_id) VALUES (?, ?)"
    );
    for (const id of ids) {
      stmt.run(logId, id);
    }
  } catch {
    // Non-fatal — log silently
  }
}
