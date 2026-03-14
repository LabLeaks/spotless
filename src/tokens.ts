/**
 * Token budget estimation.
 *
 * Conservative heuristic: ~4 chars per token.
 * Good enough for budget management — we're trimming from the front,
 * so being off by 10-20% just means slightly fewer old turns retained.
 */

import type { Message, ContentBlock, SystemBlock } from "./types.ts";

const CHARS_PER_TOKEN = 4;

/**
 * Estimate token count for a string.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimate token count for a single message.
 */
export function estimateMessageTokens(message: Message): number {
  if (typeof message.content === "string") {
    return estimateTokens(message.content) + 4; // role overhead
  }

  let tokens = 4; // role overhead
  for (const block of message.content) {
    switch (block.type) {
      case "text":
        tokens += estimateTokens(block.text);
        break;
      case "tool_use":
        tokens += estimateTokens(JSON.stringify(block.input)) + estimateTokens(block.name) + 20;
        break;
      case "tool_result":
        tokens += estimateTokens(
          typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "")
        ) + 10;
        break;
      case "thinking":
        tokens += estimateTokens(block.thinking);
        break;
    }
  }
  return tokens;
}

/**
 * Estimate total tokens for a messages array.
 */
export function estimateArrayTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}

/** Default budget for the history prefix (tokens). Used by consolidation pressure as baseline. */
export const HISTORY_BUDGET = 144_000;

/** Max denominator for consolidation pressure calculation.
 * Pressure measures how urgently the digester needs to run, independent of context window size.
 * Without this cap, a 500K+ context budget would let huge volumes of unconsolidated content
 * accumulate before the digester kicks in — and Haiku (200K context) can't process it all at once.
 */
export const PRESSURE_BUDGET_CAP = 144_000;

/** Default target total input tokens. With 1M context models, this can go much higher. */
export const DEFAULT_CONTEXT_BUDGET = 500_000;

/** Tier 2 budget as a fraction of context budget. */
const TIER2_RATIO = 0.1;

/** Minimum Tier 2 budget (tokens). */
const TIER2_FLOOR = 12_000;

/** Maximum Tier 2 budget (tokens). */
const TIER2_CAP = 60_000;

/** Compute Tier 2 budget from context budget — 10% of context, floored at 12K, capped at 60K. */
export function computeTier2Budget(contextBudget: number): number {
  return Math.min(TIER2_CAP, Math.max(TIER2_FLOOR, Math.round(contextBudget * TIER2_RATIO)));
}

/** Legacy constant for backwards compatibility in tests/consolidation defaults. */
export const TIER2_BUDGET = TIER2_FLOOR;

/** Minimum tokens identity always gets, even when world-facts are large. */
export const IDENTITY_FLOOR = 2_000;

/** Minimum tokens world-facts always get, even when identity is large. */
export const MEMORY_FLOOR = 2_000;

/** Overhead for pressure signal, tags, preamble, etc. (tokens). */
export const SUFFIX_OVERHEAD = 1_000;

/** Minimum history budget — agent always gets some history. */
const HISTORY_BUDGET_FLOOR = 20_000;

/**
 * Estimate token count for the system prompt.
 */
export function estimateSystemTokens(system: string | SystemBlock[] | undefined): number {
  if (!system) return 0;
  if (typeof system === "string") return estimateTokens(system);
  let tokens = 0;
  for (const block of system) {
    tokens += estimateTokens(block.text);
  }
  return tokens;
}

/**
 * Estimate token count for tool definitions.
 */
export function estimateToolsTokens(tools: unknown[] | undefined): number {
  if (!tools || tools.length === 0) return 0;
  return estimateTokens(JSON.stringify(tools));
}

/**
 * Compute dynamic history budget after accounting for system, tools, and Tier 2 pool.
 *
 * Formula: contextBudget - systemTokens - toolsTokens - tier2Budget - SUFFIX_OVERHEAD
 * Floored at HISTORY_BUDGET_FLOOR so the agent always gets some history.
 */
export function computeHistoryBudget(systemTokens: number, toolsTokens: number, contextBudget: number = DEFAULT_CONTEXT_BUDGET): number {
  const tier2Budget = computeTier2Budget(contextBudget);
  const available = contextBudget - systemTokens - toolsTokens - tier2Budget - SUFFIX_OVERHEAD;
  return Math.max(available, HISTORY_BUDGET_FLOOR);
}
