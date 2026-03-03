/**
 * Digest orchestrator.
 *
 * Two-phase digest pass:
 *   Phase 1 (Consolidation): catalogs facts, merges, strengthens associations
 *   Phase 2 (Identity): first-person self-reflection, identity/relationship evolution
 *
 * Both phases share newMemoryIds and DigestResult counters within a single runDigestPass().
 *
 * Never throws. Logs errors and returns result with error list.
 */

import { getAgentDbPath } from "./agent.ts";
import { openDb, initSchema } from "./db.ts";
import {
  buildDigestSystemPrompt,
  buildDigestInitialMessage,
  buildDigestTurnPrompt,
  buildReflectionSystemPrompt,
  buildReflectionInitialMessage,
  type DigestContext,
  type DigestTurn,
  type ReflectionPassContext,
} from "./digest-prompt.ts";
import {
  queryMemories,
  queryRawEvents,
  getAssociations,
  createMemory,
  createAssociation,
  updateMemory,
  mergeMemories,
  countHumanTurnsBetween,
  drainRetrievalLog,
  supersedeMemory,
  updateSelfConcept,
  markSignificance,
  cleanupConsolidatedFromFts,
} from "./digest-tools.ts";
import { getIdentityNodes } from "./recall.ts";
import { getConsolidationPressure } from "./consolidation.ts";
import type { DigestResult, MemoryType } from "./types.ts";
import type { Database } from "bun:sqlite";

export interface DigestPassConfig {
  agentName: string;
  model?: string;        // default: "haiku"
  maxRawEvents?: number; // max message groups to process
  maxIterations?: number; // max consolidation tool-use turns (default 20)
  dryRun?: boolean;
}

interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
}

// --- Phase-specific tool sets ---

export const CONSOLIDATION_TOOLS = new Set([
  "query_memories", "query_raw_events", "get_associations",
  "create_memory", "create_association", "update_memory",
  "merge_memories", "count_human_turns_between",
  "drain_retrieval_log", "supersede_memory",
  "done",
]);

export const REFLECTION_TOOLS = new Set([
  "query_memories",
  "update_self_concept",
  "mark_significance",
  "done",
]);

// Union of both for executeTool validation
const ALL_TOOLS = new Set([...CONSOLIDATION_TOOLS, ...REFLECTION_TOOLS]);

// --- Tool loop ---

interface ToolLoopConfig {
  systemPrompt: string;
  initialMessage: string;
  model: string;
  maxIterations: number;
  allowedTools: Set<string>;
  db: Database;
  newMemoryIds: number[];
  result: DigestResult;
  logPrefix: string;
}

async function runToolLoop(config: ToolLoopConfig): Promise<void> {
  const { systemPrompt, initialMessage, model, maxIterations, allowedTools, db, newMemoryIds, result, logPrefix } = config;
  const turns: DigestTurn[] = [];

  for (let i = 0; i < maxIterations; i++) {
    const prompt = buildDigestTurnPrompt(systemPrompt, initialMessage, turns);

    // Retry once on empty output (haiku sometimes returns empty under load)
    let output = await spawnClaude(prompt, model);
    if (!output) {
      output = await spawnClaude(prompt, model);
    }

    if (!output) {
      result.errors.push(`${logPrefix} Iteration ${i}: empty output from claude`);
      break;
    }

    const toolCall = parseToolCall(output);
    if (!toolCall) {
      const snippet = output.length > 200 ? output.slice(0, 200) + "..." : output;
      console.error(`[digest] ${logPrefix} Parse failed, output: ${snippet}`);
      result.errors.push(`${logPrefix} Iteration ${i}: could not parse tool call from output`);
      turns.push({ role: "assistant", content: output });
      turns.push({ role: "user", content: "Invalid output. Please output exactly ONE JSON object: {\"tool\":\"...\",\"input\":{...}}" });
      continue;
    }

    result.operationsRequested++;

    if (toolCall.tool === "done") {
      result.operationsExecuted++;
      break;
    }

    // Validate tool is allowed in this phase
    if (!allowedTools.has(toolCall.tool)) {
      turns.push({ role: "assistant", content: JSON.stringify(toolCall) });
      const errMsg = `Tool "${toolCall.tool}" is not available in this phase. Available: ${[...allowedTools].filter(t => t !== "done").join(", ")}`;
      result.errors.push(`${logPrefix} ${errMsg}`);
      turns.push({ role: "user", content: JSON.stringify({ error: errMsg }) });
      continue;
    }

    turns.push({ role: "assistant", content: JSON.stringify(toolCall) });

    try {
      const toolResult = executeTool(db, toolCall, newMemoryIds, result);
      turns.push({ role: "user", content: JSON.stringify(toolResult) });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${logPrefix} Tool ${toolCall.tool}: ${errMsg}`);
      turns.push({ role: "user", content: JSON.stringify({ error: errMsg }) });
    }
  }
}

// --- Identity pass helpers ---

/**
 * Determine whether the reflection pass should run.
 * True only if consolidation created new memories.
 */
export function shouldRunReflectionPass(newMemoryIds: number[]): boolean {
  return newMemoryIds.length > 0;
}

/**
 * Load memories by IDs for the identity prompt context.
 */
export function loadNewMemories(db: Database, ids: number[]): { id: number; content: string; salience: number }[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return db.query(`SELECT id, content, salience FROM memories WHERE id IN (${placeholders})`).all(...ids) as { id: number; content: string; salience: number }[];
}

/**
 * Count total memories in the network.
 */
export function getTotalMemoryCount(db: Database): number {
  const row = db.query("SELECT COUNT(*) as cnt FROM memories").get() as { cnt: number };
  return row.cnt;
}

// --- Main entry point ---

/**
 * Run a single digest pass for an agent (consolidation + identity phases).
 */
export async function runDigestPass(config: DigestPassConfig): Promise<DigestResult> {
  const start = Date.now();
  const result: DigestResult = {
    operationsRequested: 0,
    operationsExecuted: 0,
    memoriesCreated: 0,
    memoriesMerged: 0,
    memoriesSuperseded: 0,
    associationsCreated: 0,
    reflectionOps: 0,
    errors: [],
    durationMs: 0,
    groupsConsolidated: 0,
    pressure: 0,
  };

  try {
    const dbPath = getAgentDbPath(config.agentName);
    const db = openDb(dbPath);
    initSchema(db);

    try {
      // 1. Query unconsolidated raw events
      const rawGroups = queryRawEvents(db, {
        unconsolidatedOnly: true,
        limit: config.maxRawEvents ?? 50,
      });

      if (rawGroups.length === 0) {
        result.durationMs = Date.now() - start;
        return result;
      }

      // 2. Drain retrieval log for co-occurrence data
      const retrievalSets = drainRetrievalLog(db);
      let retrievalLogSummary: string | null = null;
      if (retrievalSets.length > 0) {
        retrievalLogSummary = retrievalSets
          .map(ids => `Co-retrieved: [${ids.join(", ")}]`)
          .join("\n");
      }

      // 3. Build consolidation prompts
      const ctx: DigestContext = {
        rawEventGroups: rawGroups,
        retrievalLogSummary,
      };

      const systemPrompt = buildDigestSystemPrompt();
      const initialMessage = buildDigestInitialMessage(ctx);

      if (config.dryRun) {
        console.log("[digest] Dry run — prompt built, not executing");
        console.log("[digest] System prompt length:", systemPrompt.length, "chars");
        console.log("[digest] Initial message length:", initialMessage.length, "chars");
        console.log("[digest] Raw event groups:", rawGroups.length);
        result.durationMs = Date.now() - start;
        return result;
      }

      const model = config.model ?? "haiku";
      const newMemoryIds: number[] = [];

      // Phase 1: Consolidation
      await runToolLoop({
        systemPrompt,
        initialMessage,
        model,
        maxIterations: config.maxIterations ?? 20,
        allowedTools: CONSOLIDATION_TOOLS,
        db,
        newMemoryIds,
        result,
        logPrefix: "[consolidation]",
      });

      // Phase 2: Reflection (runs when new memories were created)
      if (shouldRunReflectionPass(newMemoryIds)) {
        const identityNodes = getIdentityNodes(db);
        const newMemories = loadNewMemories(db, newMemoryIds);
        const totalCount = getTotalMemoryCount(db);

        // Query associated memories per identity anchor so haiku can see
        // existing self-concept facts and pick supersedes_id targets
        const associatedMemories: Record<string, { id: number; content: string; salience: number }[]> = {};
        for (const node of identityNodes) {
          const assocs = getAssociations(db, node.id);
          const connectedIds = assocs
            .filter(a => a.strength >= 0.5)
            .map(a => a.connected_id);
          if (connectedIds.length > 0) {
            const placeholders = connectedIds.map(() => "?").join(",");
            const memories = db.query(`
              SELECT id, content, salience FROM memories
              WHERE id IN (${placeholders}) AND archived_at IS NULL
              ORDER BY salience DESC
            `).all(...connectedIds) as { id: number; content: string; salience: number }[];
            associatedMemories[node.role] = memories;
          } else {
            associatedMemories[node.role] = [];
          }
        }

        const reflectionCtx: ReflectionPassContext = {
          agentName: config.agentName,
          newMemories,
          identityNodes: identityNodes.map(n => ({
            role: n.role, id: n.id, content: n.content,
          })),
          totalMemoryCount: totalCount,
          associatedMemories,
        };

        await runToolLoop({
          systemPrompt: buildReflectionSystemPrompt(config.agentName),
          initialMessage: buildReflectionInitialMessage(reflectionCtx),
          model,
          maxIterations: 6,
          allowedTools: REFLECTION_TOOLS,
          db,
          newMemoryIds,
          result,
          logPrefix: "[reflection]",
        });

      }

      // Post-consolidation: Clean source events from raw_events_fts
      // Runs after both phases so all newMemoryIds (Phase 1 + Phase 2) are included
      if (newMemoryIds.length > 0) {
        try {
          cleanupConsolidatedFromFts(db, newMemoryIds);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`FTS5 cleanup failed: ${msg}`);
        }
      }

      // Mark all processed groups as consolidated
      try {
        const groupIds = rawGroups.map(g => g.message_group);
        if (groupIds.length > 0) {
          const placeholders = groupIds.map(() => "?").join(",");
          db.run(
            `UPDATE raw_events SET consolidated = 1 WHERE message_group IN (${placeholders}) AND is_subagent = 0`,
            groupIds,
          );
          result.groupsConsolidated = groupIds.length;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Post-pass marking failed: ${msg}`);
      }

      // Compute current consolidation pressure for digest loop scheduling
      try {
        const { pressure } = getConsolidationPressure(db);
        result.pressure = pressure;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Pressure computation failed: ${msg}`);
      }

      // Persist digest pass result for dashboard diagnostics
      try {
        db.run(
          `INSERT INTO digest_passes
            (timestamp, duration_ms, ops_requested, ops_executed,
             memories_created, memories_merged, memories_pruned, memories_superseded,
             associations_created, identity_ops, errors)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            Date.now(),
            Date.now() - start,
            result.operationsRequested,
            result.operationsExecuted,
            result.memoriesCreated,
            result.memoriesMerged,
            0, // memories_pruned — pruning removed, column kept for schema compat
            result.memoriesSuperseded,
            result.associationsCreated,
            result.reflectionOps,
            result.errors.length > 0 ? JSON.stringify(result.errors) : null,
          ],
        );
      } catch (err) {
        console.error(`[digest] Failed to persist digest pass:`, err);
      }
    } finally {
      db.close();
    }
  } catch (err) {
    result.errors.push(`Digest pass failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  result.durationMs = Date.now() - start;
  return result;
}

/**
 * Parse a tool call from model output.
 * Expects: {"tool":"name","input":{...}}
 */
export function parseToolCall(output: string): ToolCall | null {
  const text = output.trim();

  // Try: markdown code fence
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    const parsed = tryParseToolCall(fenceMatch[1]!.trim());
    if (parsed) return parsed;
  }

  // Try: find first complete JSON object in text (not last — model may
  // hallucinate multiple tool calls with fake [TOOL_RESULT] in between)
  const braceStart = text.indexOf("{");
  if (braceStart !== -1) {
    // Walk forward from first { to find matching }
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = braceStart; i < text.length; i++) {
      const ch = text[i]!;
      if (escape) { escape = false; continue; }
      if (ch === "\\" && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const parsed = tryParseToolCall(text.slice(braceStart, i + 1));
          if (parsed) return parsed;
          break;
        }
      }
    }
  }

  return null;
}

function tryParseToolCall(json: string): ToolCall | null {
  try {
    const obj = JSON.parse(json);
    if (obj && typeof obj.tool === "string") {
      return {
        tool: obj.tool,
        input: obj.input && typeof obj.input === "object" ? obj.input : {},
      };
    }
  } catch {
    // Not valid JSON
  }
  return null;
}

/**
 * Resolve a memory reference that could be a numeric ID or "new_N" reference.
 */
function resolveMemoryRef(ref: unknown, newMemoryIds: number[]): number | null {
  if (typeof ref === "number") return ref;
  if (typeof ref === "string" && ref.startsWith("new_")) {
    const idx = parseInt(ref.slice(4), 10);
    if (!isNaN(idx) && idx >= 0 && idx < newMemoryIds.length) {
      return newMemoryIds[idx]!;
    }
  }
  return null;
}

const VALID_TYPES: Set<string> = new Set(["episodic", "fact"]);

/**
 * Execute a digest tool call against the database.
 */
export function executeTool(
  db: Database,
  call: ToolCall,
  newMemoryIds: number[],
  result: DigestResult,
): unknown {
  if (!ALL_TOOLS.has(call.tool)) {
    throw new Error(`Unknown tool: ${call.tool}`);
  }

  const input = call.input;

  switch (call.tool) {
    case "query_memories": {
      const memories = queryMemories(db, {
        query: input.query as string | undefined,
        minSalience: input.min_salience as number | undefined,
        limit: input.limit as number | undefined,
      });
      result.operationsExecuted++;
      return { memories: memories.map(m => ({
        id: m.id, content: m.content, salience: m.salience,
        access_count: m.access_count, association_count: m.association_count,
      }))};
    }

    case "query_raw_events": {
      const groups = queryRawEvents(db, {
        limit: input.limit as number | undefined,
        unconsolidatedOnly: input.unconsolidated_only as boolean | undefined,
      });
      result.operationsExecuted++;
      return { groups };
    }

    case "get_associations": {
      const memId = input.memory_id as number;
      const assocs = getAssociations(db, memId);
      result.operationsExecuted++;
      return { associations: assocs.map(a => ({
        connected_id: a.connected_id, strength: a.strength,
        reinforcement_count: a.reinforcement_count,
      }))};
    }

    case "create_memory": {
      let memType: MemoryType = "episodic";
      if (input.type) {
        if (!VALID_TYPES.has(input.type as string)) {
          throw new Error(`Invalid memory type: "${input.type}". Must be one of: episodic, fact`);
        }
        memType = input.type as MemoryType;
      }
      const id = createMemory(
        db,
        input.content as string,
        input.salience as number,
        (input.source_event_ids as number[]) ?? [],
        memType,
      );
      newMemoryIds.push(id);
      result.memoriesCreated++;
      result.operationsExecuted++;
      return { created_id: id, ref: `new_${newMemoryIds.length - 1}` };
    }

    case "create_association": {
      const a = resolveMemoryRef(input.memory_a, newMemoryIds);
      const b = resolveMemoryRef(input.memory_b, newMemoryIds);
      if (a === null || b === null) {
        throw new Error(`Unresolvable memory refs: ${input.memory_a}, ${input.memory_b}`);
      }
      createAssociation(db, a, b, input.strength as number);
      result.associationsCreated++;
      result.operationsExecuted++;
      return { ok: true };
    }

    case "update_memory": {
      const updates: { content?: string; salience?: number } = {};
      if (input.content !== undefined) updates.content = input.content as string;
      if (input.salience !== undefined) updates.salience = input.salience as number;
      updateMemory(db, input.memory_id as number, updates);
      result.operationsExecuted++;
      return { ok: true };
    }

    case "merge_memories": {
      const mergeType = input.type as string | undefined;
      const validMergeType = mergeType && VALID_TYPES.has(mergeType) ? mergeType as MemoryType : "episodic";
      const newId = mergeMemories(
        db,
        input.source_ids as number[],
        input.content as string,
        input.salience as number,
        validMergeType,
      );
      newMemoryIds.push(newId);
      result.memoriesMerged++;
      result.operationsExecuted++;
      return { merged_id: newId, ref: `new_${newMemoryIds.length - 1}` };
    }

    case "count_human_turns_between": {
      const count = countHumanTurnsBetween(
        db,
        input.event_a as number,
        input.event_b as number,
      );
      result.operationsExecuted++;
      return { count };
    }

    case "supersede_memory": {
      const targetRef = resolveMemoryRef(input.target_id, newMemoryIds);
      if (targetRef === null) {
        throw new Error(`Unresolvable memory ref: ${input.target_id}`);
      }
      const { newId, oldId } = supersedeMemory(
        db,
        targetRef,
        input.corrected_content as string,
        input.salience as number,
        (input.source_event_ids as number[]) ?? [],
      );
      newMemoryIds.push(newId);
      result.memoriesSuperseded++;
      result.operationsExecuted++;
      return { new_id: newId, old_id: oldId, ref: `new_${newMemoryIds.length - 1}` };
    }

    case "drain_retrieval_log": {
      const sets = drainRetrievalLog(db);
      result.operationsExecuted++;
      return { co_retrieval_sets: sets };
    }

    case "update_self_concept": {
      const anchor = (input.anchor as "self" | "relationship") ?? "self";
      const { newId, archivedId } = updateSelfConcept(
        db,
        input.content as string,
        input.salience as number,
        anchor,
        (input.source_event_ids as number[]) ?? [],
        input.supersedes_id as number | undefined,
      );
      newMemoryIds.push(newId);
      result.memoriesCreated++;
      if (archivedId !== undefined) result.memoriesSuperseded++;
      result.reflectionOps++;
      result.operationsExecuted++;
      return { new_id: newId, archived_id: archivedId, ref: `new_${newMemoryIds.length - 1}` };
    }

    case "mark_significance": {
      const memRef = resolveMemoryRef(input.memory_id, newMemoryIds);
      if (memRef === null) {
        throw new Error(`Unresolvable memory ref: ${input.memory_id}`);
      }
      markSignificance(db, memRef);
      result.reflectionOps++;
      result.operationsExecuted++;
      return { ok: true };
    }

    default:
      throw new Error(`Unknown tool: ${call.tool}`);
  }
}

/**
 * Spawn `claude -p --model <model>` and return stdout.
 */
export async function spawnClaude(prompt: string, model: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(
      ["claude", "-p", "--model", model, "--output-format", "text"],
      {
        stdin: new Blob([prompt]),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          CLAUDECODE: "",
        },
      },
    );

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.error(`[digest] claude exited with code ${exitCode}`);
      if (stderr) console.error(`[digest] stderr: ${stderr.slice(0, 500)}`);
      return null;
    }

    const trimmed = stdout.trim();
    if (!trimmed) {
      console.error(`[digest] claude returned empty stdout (exit 0)`);
      if (stderr) console.error(`[digest] stderr: ${stderr.slice(0, 500)}`);
    }

    return trimmed;
  } catch (err) {
    console.error(`[digest] Failed to spawn claude:`, err);
    return null;
  }
}
