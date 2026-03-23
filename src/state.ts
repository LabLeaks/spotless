/**
 * Proxy state management.
 *
 * Tracks the conversation state needed for tool loop chain management,
 * turn classification, and message_group assignment.
 */

import type { ContentBlockToolResult, Message, ProxyState } from "./types.ts";
import { createWorkingSet } from "./working-set.ts";

export function createProxyState(initialMessageGroup: number, initialSessionId: number = 0): ProxyState {
  return {
    cachedBase: null,
    toolLoopChain: [],
    lastStopReason: null,
    currentMessageGroup: initialMessageGroup,
    agentName: null,
    lastSelectorResult: null,
    selectorRunning: null,
    lastSystemPrompt: null,
    selectorGeneration: 0,
    currentSessionId: initialSessionId,
    currentExchangeStart: null,
    workingSet: createWorkingSet(),
  };
}

/**
 * Advance to the next message group. Returns the new group number.
 * Called once per API message (request or response).
 */
export function nextMessageGroup(state: ProxyState): number {
  state.currentMessageGroup += 1;
  return state.currentMessageGroup;
}

/**
 * Reset state for a new human turn.
 * The cached base will be set by the proxy after processing.
 */
export function resetForHumanTurn(state: ProxyState, newBase: Message[]): void {
  state.cachedBase = newBase;
  state.toolLoopChain = [];
}

/**
 * Append an assistant response to the tool loop chain.
 * Called when tapping the SSE stream captures a complete response.
 */
export function appendAssistantToChain(state: ProxyState, message: Message): void {
  state.toolLoopChain.push(message);
}

/**
 * Append a tool result to the tool loop chain.
 * Called when a tool_loop request comes in with tool_result content.
 *
 * Deduplicates retried requests: if ALL tool_use_ids in the incoming message
 * already exist in the chain, this is a CC retry (e.g. from idleTimeout drop)
 * and we skip to prevent "each tool_use must have a single result" API 400s.
 */
export function appendToolResultToChain(state: ProxyState, message: Message): void {
  const incomingIds = getToolResultIds(message);
  if (incomingIds.length > 0) {
    const existingIds = new Set<string>();
    for (const msg of state.toolLoopChain) {
      for (const id of getToolResultIds(msg)) existingIds.add(id);
    }
    if (incomingIds.every(id => existingIds.has(id))) return; // retry — skip
  }
  state.toolLoopChain.push(message);
}

/**
 * Extract tool_use_id values from tool_result blocks in a message.
 */
export function getToolResultIds(message: Message): string[] {
  if (typeof message.content === "string") return [];
  return (message.content as ContentBlockToolResult[])
    .filter((b): b is ContentBlockToolResult => b.type === "tool_result")
    .map(b => b.tool_use_id);
}

/**
 * Check if this looks like a new conversation (single user message).
 */
export function isNewConversation(messages: Message[]): boolean {
  return messages.length === 1 && messages[0]!.role === "user";
}

/**
 * Reset state entirely (new conversation or proxy restart).
 */
export function resetState(state: ProxyState): void {
  state.cachedBase = null;
  state.toolLoopChain = [];
  state.lastStopReason = null;
  state.lastSelectorResult = null;
  state.selectorRunning = null;
  state.lastSystemPrompt = null;
  state.currentExchangeStart = null;
}
