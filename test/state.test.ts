import { test, expect, describe } from "bun:test";
import {
  createProxyState,
  nextMessageGroup,
  resetForHumanTurn,
  appendAssistantToChain,
  appendToolResultToChain,
  isNewConversation,
  resetState,
} from "../src/state.ts";

describe("proxy state", () => {
  test("initializes with correct defaults", () => {
    const state = createProxyState(0);
    expect(state.cachedBase).toBeNull();
    expect(state.toolLoopChain).toEqual([]);
    expect(state.lastStopReason).toBeNull();
    expect(state.currentMessageGroup).toBe(0);
  });

  test("initializes from existing message group", () => {
    const state = createProxyState(42);
    expect(state.currentMessageGroup).toBe(42);
  });

  test("nextMessageGroup increments", () => {
    const state = createProxyState(5);
    expect(nextMessageGroup(state)).toBe(6);
    expect(nextMessageGroup(state)).toBe(7);
    expect(state.currentMessageGroup).toBe(7);
  });

  test("resetForHumanTurn clears chain and sets base", () => {
    const state = createProxyState(0);
    state.toolLoopChain = [
      { role: "assistant", content: "old" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "result" }] },
    ];

    const newBase = [{ role: "user" as const, content: "new question" }];
    resetForHumanTurn(state, newBase);

    expect(state.cachedBase).toEqual(newBase);
    expect(state.toolLoopChain).toEqual([]);
  });

  test("appendAssistantToChain grows chain", () => {
    const state = createProxyState(0);
    appendAssistantToChain(state, { role: "assistant", content: "response 1" });
    appendAssistantToChain(state, { role: "assistant", content: "response 2" });
    expect(state.toolLoopChain.length).toBe(2);
  });

  test("appendToolResultToChain grows chain", () => {
    const state = createProxyState(0);
    appendToolResultToChain(state, {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "result" }],
    });
    expect(state.toolLoopChain.length).toBe(1);
  });

  test("isNewConversation detects single user message", () => {
    expect(isNewConversation([{ role: "user", content: "hello" }])).toBe(true);
  });

  test("isNewConversation returns false for multi-message", () => {
    expect(
      isNewConversation([
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "bye" },
      ])
    ).toBe(false);
  });

  test("resetState clears everything", () => {
    const state = createProxyState(10);
    state.cachedBase = [{ role: "user", content: "something" }];
    state.toolLoopChain = [{ role: "assistant", content: "something" }];
    state.lastStopReason = "end_turn";

    resetState(state);

    expect(state.cachedBase).toBeNull();
    expect(state.toolLoopChain).toEqual([]);
    expect(state.lastStopReason).toBeNull();
    // message group is NOT reset by resetState (it persists)
    expect(state.currentMessageGroup).toBe(10);
  });
});
