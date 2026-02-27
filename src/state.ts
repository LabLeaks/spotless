/**
 * Proxy state management.
 *
 * Tracks the conversation state needed for tool loop chain management,
 * turn classification, and message_group assignment.
 */

import type { Message, ProxyState } from "./types.ts";

export function createProxyState(initialMessageGroup: number): ProxyState {
  return {
    cachedBase: null,
    toolLoopChain: [],
    lastStopReason: null,
    currentMessageGroup: initialMessageGroup,
    agentName: null,
    lastHippocampusResult: null,
    hippocampusRunning: null,
    lastSystemPrompt: null,
    hippoGeneration: 0,
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
 */
export function appendToolResultToChain(state: ProxyState, message: Message): void {
  state.toolLoopChain.push(message);
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
  state.lastHippocampusResult = null;
  state.hippocampusRunning = null;
  state.lastSystemPrompt = null;
}
