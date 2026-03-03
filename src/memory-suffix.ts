/**
 * Memory suffix assembly.
 *
 * Renders selector-selected memories as a text block for injection
 * into the user's message. Claude never sees memory IDs or metadata.
 */

import type { Database } from "bun:sqlite";
import type { Memory, Message, ContentBlock } from "./types.ts";
import { estimateTokens, TIER2_BUDGET, IDENTITY_FLOOR, MEMORY_FLOOR } from "./tokens.ts";

/**
 * Build the memory suffix text from selected memory IDs.
 *
 * Fetches memory content in chronological order (created_at ASC),
 * renders as `<relevant knowledge>...</relevant knowledge>`.
 * Budget-bounded — stops adding memories when budget exceeded.
 *
 * Returns empty string if no IDs or no memories found.
 */
export function buildMemorySuffix(
  db: Database,
  memoryIds: number[] | null,
  budget: number = TIER2_BUDGET,
): string {
  if (!memoryIds || memoryIds.length === 0) return "";

  const placeholders = memoryIds.map(() => "?").join(",");
  const memories = db.query(`
    SELECT content FROM memories
    WHERE id IN (${placeholders}) AND archived_at IS NULL
    ORDER BY created_at ASC
  `).all(...memoryIds) as { content: string }[];

  if (memories.length === 0) return "";

  // Add memories until budget exceeded
  const lines: string[] = [];
  let tokensUsed = 0;
  const overhead = estimateTokens("<relevant knowledge>\n\n</relevant knowledge>\n\n");

  for (const mem of memories) {
    const memTokens = estimateTokens(mem.content);
    if (tokensUsed + memTokens + overhead > budget && lines.length > 0) break;
    lines.push(mem.content);
    tokensUsed += memTokens;
  }

  if (lines.length === 0) return "";

  return `<relevant knowledge>\n${lines.join("\n")}\n</relevant knowledge>\n\n`;
}

export interface Tier2Allocation {
  identityBudget: number;
  memoryBudget: number;
}

/**
 * Compute the sliding Tier 2 budget split between identity and world-fact memories.
 *
 * Both bins have minimum floors. When both fit, each gets exactly what it needs.
 * When one overflows, the other expands up to (total - floor).
 */
export function computeTier2Allocation(
  identityNeeded: number,
  memoryNeeded: number,
  totalBudget: number = TIER2_BUDGET,
  identityFloor: number = IDENTITY_FLOOR,
  memoryFloor: number = MEMORY_FLOOR,
): Tier2Allocation {
  // Both fit within total budget
  if (identityNeeded + memoryNeeded <= totalBudget) {
    return {
      identityBudget: identityNeeded,
      memoryBudget: memoryNeeded,
    };
  }

  // Identity overflows — cap it, give memory at least its floor
  if (identityNeeded > totalBudget - memoryFloor) {
    return {
      identityBudget: totalBudget - memoryFloor,
      memoryBudget: memoryFloor,
    };
  }

  // Memory overflows — cap it, give identity at least its floor
  if (memoryNeeded > totalBudget - identityFloor) {
    return {
      identityBudget: identityFloor,
      memoryBudget: totalBudget - identityFloor,
    };
  }

  // Middle case: both moderately large, sum exceeds budget but neither
  // individually dominates. Proportional scaling with floor enforcement.
  const totalNeeded = identityNeeded + memoryNeeded;
  let identityBudget = Math.round((identityNeeded / totalNeeded) * totalBudget);
  let memoryBudget = totalBudget - identityBudget;

  if (identityBudget < identityFloor) {
    identityBudget = identityFloor;
    memoryBudget = totalBudget - identityFloor;
  } else if (memoryBudget < memoryFloor) {
    memoryBudget = memoryFloor;
    identityBudget = totalBudget - memoryFloor;
  }

  return { identityBudget, memoryBudget };
}

/**
 * Build the identity suffix from selector-selected identity fact IDs.
 *
 * Queries memory content, formats as `I am {name}.\n\n- fact1\n- fact2`,
 * budget-limited. Returns the `<your identity>...</your identity>` tag.
 *
 * Always includes the agent name line, even with no facts.
 */
export function buildIdentitySuffix(
  db: Database,
  agentName: string,
  memoryIds: number[] | null,
  budget: number,
): string {
  const nameLine = `I am ${agentName}.`;
  let content = nameLine;

  if (memoryIds && memoryIds.length > 0) {
    const placeholders = memoryIds.map(() => "?").join(",");
    const facts = db.query(`
      SELECT content FROM memories
      WHERE id IN (${placeholders}) AND archived_at IS NULL
      ORDER BY created_at DESC
    `).all(...memoryIds) as { content: string }[];

    if (facts.length > 0) {
      const parts: string[] = [nameLine, ""];
      let tokens = estimateTokens(nameLine);

      for (const f of facts) {
        const line = `- ${f.content}`;
        const lineTokens = estimateTokens(line);
        if (tokens + lineTokens > budget && parts.length > 2) break;
        parts.push(line);
        tokens += lineTokens;
      }

      content = parts.join("\n");
    }
  }

  return `<your identity>\n${content}\n</your identity>\n\n`;
}

/**
 * Inject memory suffix into a user message.
 *
 * Prepends suffix to message content. Handles both string and array
 * content formats. Returns a new message (no mutation).
 */
export function injectMemorySuffix(msg: Message, suffix: string): Message {
  if (!suffix) return msg;

  if (typeof msg.content === "string") {
    return { role: msg.role, content: suffix + msg.content };
  }

  // Array content — prepend to first text block or insert new one
  const blocks: ContentBlock[] = [...msg.content.map(b => ({ ...b }))];
  const firstTextIdx = blocks.findIndex(b => b.type === "text");

  if (firstTextIdx >= 0) {
    const textBlock = blocks[firstTextIdx]! as { type: "text"; text: string };
    blocks[firstTextIdx] = { type: "text", text: suffix + textBlock.text };
  } else {
    blocks.unshift({ type: "text", text: suffix });
  }

  return { role: msg.role, content: blocks };
}
