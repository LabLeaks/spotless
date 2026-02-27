/**
 * Token budget estimation.
 *
 * Conservative heuristic: ~4 chars per token.
 * Good enough for budget management — we're trimming from the front,
 * so being off by 10-20% just means slightly fewer old turns retained.
 */

import type { Message, ContentBlock } from "./types.ts";

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

/** Default budget for the eidetic prefix (tokens). Tunable. */
export const EIDETIC_BUDGET = 144_000;

/** Default budget for the memory suffix (tokens). Tunable. */
export const MEMORY_SUFFIX_BUDGET = 8_000;
