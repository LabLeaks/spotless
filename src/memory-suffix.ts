/**
 * Memory suffix assembly.
 *
 * Renders hippocampus-selected memories as a text block for injection
 * into the user's message. Claude never sees memory IDs or metadata.
 */

import type { Database } from "bun:sqlite";
import type { Memory, Message, ContentBlock } from "./types.ts";
import { estimateTokens } from "./tokens.ts";

const MEMORY_SUFFIX_BUDGET = 8_000; // tokens

/**
 * Build the memory suffix text from selected memory IDs.
 *
 * Fetches memory content in chronological order (created_at ASC),
 * renders as `<your memories>...</your memories>`.
 * Budget-bounded — stops adding memories when budget exceeded.
 *
 * Returns empty string if no IDs or no memories found.
 */
export function buildMemorySuffix(
  db: Database,
  memoryIds: number[] | null,
  budget: number = MEMORY_SUFFIX_BUDGET,
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
  const overhead = estimateTokens("<your memories>\n\n</your memories>\n\n");

  for (const mem of memories) {
    const memTokens = estimateTokens(mem.content);
    if (tokensUsed + memTokens + overhead > budget && lines.length > 0) break;
    lines.push(mem.content);
    tokensUsed += memTokens;
  }

  if (lines.length === 0) return "";

  return `<your memories>\n${lines.join("\n")}\n</your memories>\n\n`;
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
