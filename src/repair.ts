/**
 * Database repair and diagnostics for agent databases.
 *
 * Diagnoses corruption in the history archive (Tier 1) and offers
 * targeted or nuclear repair options. Tier 2 (memories, associations,
 * identity) is always preserved.
 */

import { Database } from "bun:sqlite";
import { openDb, openReadonlyDb, initSchema } from "./db.ts";
import { getAgentDbPath, validateAgentName } from "./agent.ts";
import { existsSync } from "node:fs";

export interface DiagnosticReport {
  agentName: string;
  tier1: {
    totalEvents: number;
    totalGroups: number;
    sessionBoundaries: number;
    orphanedToolResults: number;
    orphanedToolUses: number;
    subagentBoundaryLeaks: number;
    deadRetrySessions: number;
  };
  tier2: {
    memories: number;
    associations: number;
    identityNodes: number;
    digestPasses: number;
    selectorRuns: number;
  };
  issues: string[];
}

interface ToolEvent {
  id: number;
  message_group: number;
  tool_id: string;
}

/**
 * Run diagnostics on an agent's database. Read-only — changes nothing.
 */
export function diagnose(agentName: string): DiagnosticReport {
  if (!validateAgentName(agentName)) {
    throw new Error(`Invalid agent name: "${agentName}"`);
  }

  const dbPath = getAgentDbPath(agentName);
  if (!existsSync(dbPath)) {
    throw new Error(`No database found for agent "${agentName}" at ${dbPath}`);
  }
  const db = openReadonlyDb(dbPath);

  const issues: string[] = [];

  // Tier 1 stats
  const totalEvents = (db.query("SELECT COUNT(*) as c FROM raw_events").get() as { c: number }).c;
  const totalGroups = (db.query("SELECT COUNT(DISTINCT message_group) as c FROM raw_events").get() as { c: number }).c;
  const sessionBoundaries = (db.query("SELECT COUNT(*) as c FROM raw_events WHERE content = '<session-boundary />'").get() as { c: number }).c;

  // Find all non-subagent tool_use events with their tool IDs
  const toolUseRows = db.query(`
    SELECT id, message_group, metadata FROM raw_events
    WHERE content_type = 'tool_use' AND is_subagent = 0 AND metadata IS NOT NULL
    ORDER BY id
  `).all() as { id: number; message_group: number; metadata: string }[];

  const toolUses: ToolEvent[] = [];
  for (const row of toolUseRows) {
    try {
      const meta = JSON.parse(row.metadata);
      if (meta.tool_id) {
        toolUses.push({ id: row.id, message_group: row.message_group, tool_id: meta.tool_id });
      }
    } catch { /* skip malformed metadata */ }
  }

  // Find all non-subagent tool_result events with their tool IDs
  const toolResultRows = db.query(`
    SELECT id, message_group, metadata FROM raw_events
    WHERE content_type = 'tool_result' AND is_subagent = 0 AND metadata IS NOT NULL
    ORDER BY id
  `).all() as { id: number; message_group: number; metadata: string }[];

  const toolResults: ToolEvent[] = [];
  for (const row of toolResultRows) {
    try {
      const meta = JSON.parse(row.metadata);
      if (meta.tool_use_id) {
        toolResults.push({ id: row.id, message_group: row.message_group, tool_id: meta.tool_use_id });
      }
    } catch { /* skip malformed metadata */ }
  }

  // Cross-reference: find orphaned tool_results and tool_uses
  const toolUseIdSet = new Set(toolUses.map(t => t.tool_id));
  const toolResultIdSet = new Set(toolResults.map(t => t.tool_id));

  const orphanedToolResults = toolResults.filter(tr => !toolUseIdSet.has(tr.tool_id));
  const orphanedToolUses = toolUses.filter(tu => !toolResultIdSet.has(tu.tool_id));

  if (orphanedToolResults.length > 0) {
    issues.push(`${orphanedToolResults.length} orphaned tool_result(s) with no matching tool_use`);
  }
  if (orphanedToolUses.length > 0) {
    issues.push(`${orphanedToolUses.length} orphaned tool_use(s) with no matching tool_result`);
  }

  // Find subagent boundary leaks: session boundaries that fall between a tool_use and its matching tool_result
  const boundaryGroups = db.query(
    "SELECT DISTINCT message_group FROM raw_events WHERE content = '<session-boundary />'"
  ).all() as { message_group: number }[];
  const boundaryGroupSet = new Set(boundaryGroups.map(b => b.message_group));

  let subagentBoundaryLeaks = 0;
  for (const tu of toolUses) {
    const matchingResult = toolResults.find(tr => tr.tool_id === tu.tool_id);
    if (!matchingResult) continue;

    // Count session boundaries between this tool_use and its tool_result
    let leaksForPair = 0;
    for (const bg of boundaryGroupSet) {
      if (bg > tu.message_group && bg < matchingResult.message_group) {
        leaksForPair++;
      }
    }
    if (leaksForPair > 0) {
      subagentBoundaryLeaks += leaksForPair;
      issues.push(
        `${leaksForPair} session boundary(ies) leaked between tool_use (group ${tu.message_group}) and tool_result (group ${matchingResult.message_group}) — likely from subagent sessions`
      );
    }
  }

  // Find dead retry sessions: user message followed by session boundary with no assistant response
  const deadRetrySessions = countDeadRetrySessions(db);
  if (deadRetrySessions > 0) {
    issues.push(`${deadRetrySessions} dead retry session(s) — user messages with no assistant response followed by session boundary`);
  }

  // Tier 2 stats
  const memories = (db.query("SELECT COUNT(*) as c FROM memories").get() as { c: number }).c;
  const associations = (db.query("SELECT COUNT(*) as c FROM associations").get() as { c: number }).c;
  const identityNodes = (db.query("SELECT COUNT(*) as c FROM identity_nodes WHERE memory_id IS NOT NULL").get() as { c: number }).c;

  let digestPasses = 0;
  let selectorRuns = 0;
  try {
    digestPasses = (db.query("SELECT COUNT(*) as c FROM digest_passes").get() as { c: number }).c;
    selectorRuns = (db.query("SELECT COUNT(*) as c FROM selector_runs").get() as { c: number }).c;
  } catch { /* tables may not exist in old DBs */ }

  // SQLite integrity check
  const integrity = db.query("PRAGMA integrity_check").get() as { integrity_check: string };
  if (integrity.integrity_check !== "ok") {
    issues.push(`SQLite integrity check failed: ${integrity.integrity_check}`);
  }

  db.close();

  return {
    agentName,
    tier1: {
      totalEvents,
      totalGroups,
      sessionBoundaries,
      orphanedToolResults: orphanedToolResults.length,
      orphanedToolUses: orphanedToolUses.length,
      subagentBoundaryLeaks,
      deadRetrySessions,
    },
    tier2: {
      memories,
      associations,
      identityNodes,
      digestPasses,
      selectorRuns,
    },
    issues,
  };
}

/**
 * Purge the history archive (Tier 1) while preserving Tier 2.
 *
 * Deletes: raw_events, raw_events_fts content, retrieval_log
 * Preserves: memories, associations, identity_nodes, digest_passes, selector_runs
 *
 * Also breaks memory_sources links (they reference raw_events) — this means
 * digesting can't trace memories back to source events, but the memories
 * themselves are fine.
 */
export function purgeHistory(agentName: string): { eventsDeleted: number } {
  if (!validateAgentName(agentName)) {
    throw new Error(`Invalid agent name: "${agentName}"`);
  }

  const dbPath = getAgentDbPath(agentName);
  const db = openDb(dbPath);
  initSchema(db);

  const count = (db.query("SELECT COUNT(*) as c FROM raw_events").get() as { c: number }).c;

  // Clear FTS5 index first (external content table needs special handling)
  try {
    // Rebuild command clears and re-indexes — since we're about to delete all rows, just clear
    db.run("INSERT INTO raw_events_fts(raw_events_fts) VALUES('rebuild')");
  } catch { /* FTS5 table may not exist */ }

  // Delete memory_sources (links to raw_events) — memories survive, just lose source tracing
  db.run("DELETE FROM memory_sources");

  // Delete retrieval log (references memories, but the log entries themselves are disposable)
  db.run("DELETE FROM retrieval_log_entries");
  db.run("DELETE FROM retrieval_log");

  // Delete all raw events
  db.run("DELETE FROM raw_events");

  // Rebuild FTS5 after deletion
  try {
    db.run("INSERT INTO raw_events_fts(raw_events_fts) VALUES('rebuild')");
  } catch { /* FTS5 table may not exist */ }

  // Vacuum to reclaim space
  db.run("VACUUM");

  db.close();

  return { eventsDeleted: count };
}

/**
 * Targeted repair: remove subagent session boundary leaks and dead retry artifacts.
 *
 * Specifically:
 * 1. Delete session boundaries that fall between a tool_use and its matching tool_result
 *    (these are from subagent sessions and corrupt the history trace)
 * 2. Delete dead retry sessions (user messages followed by session boundary, no assistant response)
 */
export function repairHistory(agentName: string): {
  boundariesRemoved: number;
  deadSessionsRemoved: number;
} {
  if (!validateAgentName(agentName)) {
    throw new Error(`Invalid agent name: "${agentName}"`);
  }

  const dbPath = getAgentDbPath(agentName);
  const db = openDb(dbPath);
  initSchema(db);

  let boundariesRemoved = 0;
  let deadSessionsRemoved = 0;

  // 1. Remove subagent boundary leaks
  const toolUseRows = db.query(`
    SELECT id, message_group, metadata FROM raw_events
    WHERE content_type = 'tool_use' AND is_subagent = 0 AND metadata IS NOT NULL
  `).all() as { id: number; message_group: number; metadata: string }[];

  const toolResultRows = db.query(`
    SELECT id, message_group, metadata FROM raw_events
    WHERE content_type = 'tool_result' AND is_subagent = 0 AND metadata IS NOT NULL
  `).all() as { id: number; message_group: number; metadata: string }[];

  // Build tool_id → group mappings
  const toolUseByToolId = new Map<string, number>();
  for (const row of toolUseRows) {
    try {
      const meta = JSON.parse(row.metadata);
      if (meta.tool_id) toolUseByToolId.set(meta.tool_id, row.message_group);
    } catch { /* skip */ }
  }

  const toolResultByToolId = new Map<string, number>();
  for (const row of toolResultRows) {
    try {
      const meta = JSON.parse(row.metadata);
      if (meta.tool_use_id) toolResultByToolId.set(meta.tool_use_id, row.message_group);
    } catch { /* skip */ }
  }

  // Find and delete boundaries between tool_use/result pairs
  for (const [toolId, tuGroup] of toolUseByToolId) {
    const trGroup = toolResultByToolId.get(toolId);
    if (!trGroup || trGroup <= tuGroup) continue;

    const result = db.run(
      `DELETE FROM raw_events
       WHERE content = '<session-boundary />'
         AND message_group > ? AND message_group < ?`,
      [tuGroup, trGroup],
    );
    boundariesRemoved += result.changes;
  }

  // 2. Remove dead retry sessions
  // Pattern: user message group with no assistant response in adjacent groups,
  // followed by a session boundary. These are failed API calls.
  deadSessionsRemoved = removeDeadRetrySessions(db);

  // Rebuild FTS5
  try {
    db.run("INSERT INTO raw_events_fts(raw_events_fts) VALUES('rebuild')");
  } catch { /* FTS5 may not exist */ }

  db.close();

  return { boundariesRemoved, deadSessionsRemoved };
}

/**
 * Count dead retry sessions: user-only groups followed by session boundary, no assistant response.
 */
function countDeadRetrySessions(db: Database): number {
  // Get all non-subagent message groups and their roles
  const groups = db.query(`
    SELECT message_group, GROUP_CONCAT(DISTINCT role) as roles
    FROM raw_events
    WHERE is_subagent = 0
      AND content != '<session-boundary />'
      AND content_type != 'thinking'
    GROUP BY message_group
    ORDER BY message_group
  `).all() as { message_group: number; roles: string }[];

  const boundaryGroups = new Set(
    (db.query(
      "SELECT DISTINCT message_group FROM raw_events WHERE content = '<session-boundary />'"
    ).all() as { message_group: number }[]).map(b => b.message_group)
  );

  let count = 0;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    // User-only group (no assistant in this group)
    if (g.roles === "user") {
      // Check if followed by a session boundary (no assistant response between this and next boundary)
      const nextGroup = groups[i + 1];
      if (!nextGroup) {
        // Last group is user-only — could be the current message, don't count
        continue;
      }
      // Is there a session boundary between this group and the next content group?
      for (const bg of boundaryGroups) {
        if (bg > g.message_group && bg <= nextGroup.message_group) {
          // User message → boundary → next content = dead retry
          // But only if the next group is also user (no assistant responded)
          if (nextGroup.roles === "user" || nextGroup.roles.includes("user")) {
            count++;
          }
          break;
        }
      }
    }
  }
  return count;
}

/**
 * Remove dead retry sessions from the database.
 * Deletes user-only groups that precede a session boundary with no assistant response.
 */
function removeDeadRetrySessions(db: Database): number {
  const groups = db.query(`
    SELECT message_group, GROUP_CONCAT(DISTINCT role) as roles
    FROM raw_events
    WHERE is_subagent = 0
      AND content != '<session-boundary />'
      AND content_type != 'thinking'
    GROUP BY message_group
    ORDER BY message_group
  `).all() as { message_group: number; roles: string }[];

  const boundaryGroups = new Set(
    (db.query(
      "SELECT DISTINCT message_group FROM raw_events WHERE content = '<session-boundary />'"
    ).all() as { message_group: number }[]).map(b => b.message_group)
  );

  const groupsToDelete: number[] = [];
  // Also collect boundary groups that precede dead retries
  const boundariesToDelete: number[] = [];

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    if (g.roles === "user") {
      const nextGroup = groups[i + 1];
      if (!nextGroup) continue;

      for (const bg of boundaryGroups) {
        if (bg > g.message_group && bg <= nextGroup.message_group) {
          if (nextGroup.roles === "user" || nextGroup.roles.includes("user")) {
            groupsToDelete.push(g.message_group);
            boundariesToDelete.push(bg);
          }
          break;
        }
      }
    }
  }

  let removed = 0;
  for (const mg of groupsToDelete) {
    // Delete memory_sources that reference these raw_events (no CASCADE on raw_event_id)
    db.run(
      `DELETE FROM memory_sources WHERE raw_event_id IN (
        SELECT id FROM raw_events WHERE message_group = ? AND is_subagent = 0
      )`,
      [mg],
    );
    const result = db.run(
      "DELETE FROM raw_events WHERE message_group = ? AND is_subagent = 0",
      [mg],
    );
    removed += result.changes;
  }

  // Also clean up the boundaries that followed the dead retries
  for (const bg of boundariesToDelete) {
    db.run(
      "DELETE FROM raw_events WHERE message_group = ? AND content = '<session-boundary />'",
      [bg],
    );
  }

  return removed > 0 ? groupsToDelete.length : 0;
}
