/**
 * Request classification: human_turn / tool_loop / subagent.
 *
 * Inspects each incoming API request and returns the classification
 * used by the proxy to decide how to process it.
 *
 * Classification is independent of agent routing — it checks the system
 * prompt content to distinguish main sessions from subagents, regardless
 * of which agent the request is routed to.
 */

import type { ApiRequest, ContentBlock, Message, RequestClass } from "./types.ts";

/**
 * Check if the system prompt looks like a main Claude Code session.
 * Subagents have shorter, task-specific system prompts without these markers.
 * This works regardless of agent routing — CC always includes this marker
 * for main sessions, and subagents never do.
 */
function isMainSession(system: ApiRequest["system"]): boolean {
  if (!system) return false;

  const text = typeof system === "string"
    ? system
    : system.map((b) => b.text).join("\n");

  return text.includes("Primary working directory:");
}

/**
 * Check if the last message contains tool_result content.
 */
function lastMessageIsToolResult(messages: Message[]): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return false;

  if (typeof last.content === "string") return false;

  return last.content.some(
    (block: ContentBlock) => block.type === "tool_result"
  );
}

/**
 * Classify an incoming API request.
 *
 * Detection order matters:
 * 1. Subagent check first (system prompt inspection)
 * 2. Tool loop (last message is tool_result)
 * 3. Human turn (everything else)
 */
export function classifyRequest(
  request: ApiRequest,
  lastStopReason: string | null
): RequestClass {
  // Subagents have simpler system prompts without main-session markers
  if (!isMainSession(request.system)) {
    return "subagent";
  }

  const { messages } = request;
  if (!messages || messages.length === 0) {
    return "human_turn";
  }

  // Tool loop: last message is a user message with tool_result content
  if (lastMessageIsToolResult(messages)) {
    return "tool_loop";
  }

  // Everything else is a human turn
  // (Confirmed by: first request in conversation, or previous stop_reason was "end_turn")
  return "human_turn";
}
