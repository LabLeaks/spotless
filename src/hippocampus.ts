/**
 * Hippocampus orchestrator.
 *
 * Spawns `claude -p --model haiku` with the hippocampus prompt,
 * parses the output for memory IDs. Single-shot v1 — no tool-use loop.
 *
 * Never throws. All errors caught, logged, return empty result.
 */

import type { Database } from "bun:sqlite";
import type { Memory } from "./types.ts";
import { recall, getIdentityNodes } from "./recall.ts";
import { buildHippoPrompt, type HippoContext, type ScoredMemory } from "./hippo-prompt.ts";
import { queryRawEvents } from "./dream-tools.ts";

export interface HippoConfig {
  db: Database;
  userMessage: string;
  systemPrompt?: string;
  model?: string;
  timeoutMs?: number;
}

export interface HippoResult {
  memoryIds: number[];
}

const EMPTY_RESULT: HippoResult = { memoryIds: [] };

/**
 * Run the hippocampus: recall → build prompt → spawn claude → parse IDs.
 *
 * Never throws — returns empty result on any failure.
 */
export async function runHippocampus(config: HippoConfig): Promise<HippoResult> {
  try {
    const { db, userMessage } = config;

    // 1. Pre-compute recall
    const preComputed = recall(db, userMessage);

    // 2. Get identity nodes (working self: self, relationship)
    const identityNodes = getIdentityNodes(db);

    // 3. If no recall results and no identity nodes, nothing to do
    if (preComputed.length === 0 && identityNodes.length === 0) {
      return EMPTY_RESULT;
    }

    // 4. Query recent raw events (last 5 groups as summary)
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

    // 5. Extract project identity
    const projectIdentity = config.systemPrompt
      ? extractProjectIdentity(config.systemPrompt)
      : null;

    // 6. Ensure all identity nodes are in recall results (dedup by ID)
    const recallWithIdentity: ScoredMemory[] = [...preComputed];
    for (const node of identityNodes) {
      if (!recallWithIdentity.some(m => m.id === node.id)) {
        recallWithIdentity.unshift({ ...node, score: 999 });
      }
    }

    // 7. Build prompt
    const ctx: HippoContext = {
      userMessage,
      projectIdentity,
      preComputedRecall: recallWithIdentity,
      identityNodes,
      recentRawSummary,
    };
    const prompt = buildHippoPrompt(ctx);

    // 8. Spawn claude
    const model = config.model ?? "haiku";
    const timeoutMs = config.timeoutMs ?? 15_000;
    const output = await spawnClaudeWithTimeout(prompt, model, timeoutMs);

    if (!output) return EMPTY_RESULT;

    // 9. Parse memory IDs
    const ids = parseMemoryIds(output);
    if (ids.length === 0) return EMPTY_RESULT;

    // 10. Sort chronologically
    const sorted = sortByCreatedAt(db, ids);
    return { memoryIds: sorted };
  } catch (err) {
    console.error("[hippo] Error:", err);
    return EMPTY_RESULT;
  }
}

/**
 * Parse memory IDs from hippocampus output.
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
          console.error(`[hippo] claude exited with code ${exitCode}`);
          if (stderr) console.error(`[hippo] stderr: ${stderr.slice(0, 300)}`);
          return null;
        }
        return stdout.trim();
      })(),
      new Promise<null>((resolve) => {
        setTimeout(() => {
          try { proc.kill(); } catch { /* already exited */ }
          console.warn(`[hippo] Timeout after ${timeoutMs}ms`);
          resolve(null);
        }, timeoutMs);
      }),
    ]);

    return result;
  } catch (err) {
    console.error("[hippo] Failed to spawn claude:", err);
    return null;
  }
}
