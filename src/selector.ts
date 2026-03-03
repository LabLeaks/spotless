/**
 * Selector orchestrator.
 *
 * Spawns `claude -p --model haiku` with the selector prompt,
 * parses the output for memory IDs. Single-shot v1 — no tool-use loop.
 *
 * Never throws. All errors caught, logged, return empty result.
 */

import type { Database } from "bun:sqlite";
import type { Memory } from "./types.ts";
import { recall, getIdentityNodes } from "./recall.ts";
import { buildSelectorPrompt, type SelectorContext, type ScoredMemory } from "./selector-prompt.ts";
import { queryRawEvents, getIdentityFacts } from "./digest-tools.ts";

export interface SelectorConfig {
  db: Database;
  userMessage: string;
  systemPrompt?: string;
  model?: string;
  timeoutMs?: number;
}

export interface SelectorResult {
  memoryIds: number[];
}

const EMPTY_RESULT: SelectorResult = { memoryIds: [] };

/**
 * Run the selector: recall → build prompt → spawn claude → parse IDs.
 *
 * Never throws — returns empty result on any failure.
 */
export async function runSelector(config: SelectorConfig): Promise<SelectorResult> {
  try {
    const { db, userMessage } = config;

    // 1. Pre-compute recall
    const preComputed = recall(db, userMessage);

    // 2. Get identity nodes (working self: self, relationship)
    const identityNodes = getIdentityNodes(db);

    // 3. Get identity facts for contextual selection
    const selfFacts = getIdentityFacts(db, "self");
    const relFacts = getIdentityFacts(db, "relationship");
    const identityFactIds = new Set([...selfFacts, ...relFacts].map(f => f.id));

    // 4. If no recall results, no identity nodes, and no identity facts, nothing to do
    if (preComputed.length === 0 && identityNodes.length === 0 && identityFactIds.size === 0) {
      return EMPTY_RESULT;
    }

    // 5. Query recent raw events (last 5 groups as summary)
    const recentGroups = queryRawEvents(db, { limit: 5, newestFirst: true });
    let recentRawSummary: string | null = null;
    if (recentGroups.length > 0) {
      const lines: string[] = [];
      for (const group of recentGroups) {
        for (const ev of group.events) {
          const prefix = ev.role === "user" ? "USER" : "ASSISTANT";
          const content = ev.content.length > 500
            ? ev.content.slice(0, 500) + "..."
            : ev.content;
          lines.push(`[${prefix}] ${content}`);
        }
      }
      recentRawSummary = lines.join("\n");
    }

    // 6. Extract project identity
    const projectIdentity = config.systemPrompt
      ? extractProjectIdentity(config.systemPrompt)
      : null;

    // 7. Ensure all identity nodes are in recall results (dedup by ID)
    const recallWithIdentity: ScoredMemory[] = [...preComputed];
    const seenIds = new Set(recallWithIdentity.map(m => m.id));

    for (const node of identityNodes) {
      if (!seenIds.has(node.id)) {
        recallWithIdentity.unshift({ ...node, score: 999 });
        seenIds.add(node.id);
      }
    }

    // 8. Merge identity facts into recall at score 100 (below anchors at 999)
    for (const fact of [...selfFacts, ...relFacts]) {
      if (!seenIds.has(fact.id)) {
        recallWithIdentity.push({
          id: fact.id,
          content: fact.content,
          salience: fact.salience,
          created_at: fact.created_at,
          last_accessed: fact.created_at,
          access_count: 0,
          type: "fact",
          archived_at: null,
          score: 100,
        });
        seenIds.add(fact.id);
      }
    }

    // 9. Build prompt
    const ctx: SelectorContext = {
      userMessage,
      projectIdentity,
      preComputedRecall: recallWithIdentity,
      identityNodes,
      identityFactIds,
      recentRawSummary,
    };
    const prompt = buildSelectorPrompt(ctx);

    // 10. Spawn claude
    const model = config.model ?? "haiku";
    const timeoutMs = config.timeoutMs ?? 45_000;
    const output = await spawnClaudeWithTimeout(prompt, model, timeoutMs);

    if (!output) return EMPTY_RESULT;

    // 11. Parse memory IDs
    const ids = parseMemoryIds(output);
    if (ids.length === 0) return EMPTY_RESULT;

    // 12. Sort chronologically
    const sorted = sortByCreatedAt(db, ids);
    return { memoryIds: sorted };
  } catch (err) {
    console.error("[selector] Error:", err);
    return EMPTY_RESULT;
  }
}

/**
 * Parse memory IDs from selector output.
 * Handles: clean JSON, fenced JSON, embedded JSON in prose.
 */
export function parseMemoryIds(output: string): number[] {
  const text = output.trim();

  // Try: markdown code fence
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    const ids = extractIdsFromJson(fenceMatch[1]!.trim());
    if (ids) return ids;
  }

  // Try: find {"memory_ids": [...]} anywhere in text
  const jsonMatch = text.match(/\{[^{}]*"memory_ids"\s*:\s*\[[\d\s,]*\][^{}]*\}/);
  if (jsonMatch) {
    const ids = extractIdsFromJson(jsonMatch[0]);
    if (ids) return ids;
  }

  // Try: raw JSON object
  const ids = extractIdsFromJson(text);
  if (ids) return ids;

  return [];
}

function extractIdsFromJson(json: string): number[] | null {
  try {
    const parsed = JSON.parse(json);
    if (parsed && Array.isArray(parsed.memory_ids)) {
      const ids = parsed.memory_ids.filter(
        (id: unknown): id is number => typeof id === "number" && Number.isInteger(id)
      );
      return ids.length > 0 ? ids : null;
    }
  } catch {
    // Not valid JSON
  }
  return null;
}

/**
 * Extract project identity from the system prompt.
 * Looks for "Primary working directory" or project name patterns.
 */
export function extractProjectIdentity(systemPrompt: string): string | null {
  // CC includes "Primary working directory: /path/to/project"
  const dirMatch = systemPrompt.match(/Primary working directory:\s*(.+)/);
  if (dirMatch) {
    return dirMatch[1]!.trim();
  }
  return null;
}

/**
 * Sort memory IDs by created_at ASC (chronological order).
 */
export function sortByCreatedAt(db: Database, ids: number[]): number[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.query(`
    SELECT id FROM memories WHERE id IN (${placeholders}) AND archived_at IS NULL ORDER BY created_at ASC
  `).all(...ids) as { id: number }[];
  return rows.map(r => r.id);
}

/**
 * Spawn `claude -p --model <model>` with timeout.
 */
async function spawnClaudeWithTimeout(
  prompt: string,
  model: string,
  timeoutMs: number,
): Promise<string | null> {
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

    const result = await Promise.race([
      (async () => {
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
          console.error(`[selector] claude exited with code ${exitCode}`);
          if (stderr) console.error(`[selector] stderr: ${stderr.slice(0, 300)}`);
          return null;
        }
        return stdout.trim();
      })(),
      new Promise<null>((resolve) => {
        setTimeout(() => {
          try { proc.kill(); } catch { /* already exited */ }
          console.warn(`[selector] Timeout after ${timeoutMs}ms`);
          resolve(null);
        }, timeoutMs);
      }),
    ]);

    return result;
  } catch (err) {
    console.error("[selector] Failed to spawn claude:", err);
    return null;
  }
}
