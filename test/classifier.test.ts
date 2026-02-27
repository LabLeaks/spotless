import { test, expect, describe } from "bun:test";
import { classifyRequest } from "../src/classifier.ts";
import type { ApiRequest } from "../src/types.ts";

describe("classifyRequest", () => {
  const mainSystemPrompt = "You are Claude.\nPrimary working directory: /Users/gk/project\nContents of CLAUDE.md...";

  test("first request in conversation is human_turn", () => {
    const req: ApiRequest = {
      model: "claude-sonnet-4-20250514",
      system: mainSystemPrompt,
      messages: [{ role: "user", content: "Hello" }],
    };
    expect(classifyRequest(req, null)).toBe("human_turn");
  });

  test("text user message after end_turn is human_turn", () => {
    const req: ApiRequest = {
      model: "claude-sonnet-4-20250514",
      system: mainSystemPrompt,
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
        { role: "user", content: "How are you?" },
      ],
    };
    expect(classifyRequest(req, "end_turn")).toBe("human_turn");
  });

  test("tool_result message is tool_loop", () => {
    const req: ApiRequest = {
      model: "claude-sonnet-4-20250514",
      system: mainSystemPrompt,
      messages: [
        { role: "user", content: "Read the file" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_01", name: "Read", input: { path: "foo.ts" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_01", content: "file contents" },
          ],
        },
      ],
    };
    expect(classifyRequest(req, "tool_use")).toBe("tool_loop");
  });

  test("subagent detected by missing system prompt marker", () => {
    const req: ApiRequest = {
      model: "claude-haiku-4-5-20251001",
      system: "You are a helpful research assistant. Search for information about...",
      messages: [{ role: "user", content: "Find info about X" }],
    };
    expect(classifyRequest(req, null)).toBe("subagent");
  });

  test("subagent detected when system is undefined", () => {
    const req: ApiRequest = {
      model: "claude-haiku-4-5-20251001",
      messages: [{ role: "user", content: "Hello" }],
    };
    expect(classifyRequest(req, null)).toBe("subagent");
  });

  test("system prompt as array of blocks", () => {
    const req: ApiRequest = {
      model: "claude-sonnet-4-20250514",
      system: [
        { type: "text", text: "You are Claude.\nPrimary working directory: /Users/gk/project" },
        { type: "text", text: "Contents of CLAUDE.md..." },
      ],
      messages: [{ role: "user", content: "Hello" }],
    };
    expect(classifyRequest(req, null)).toBe("human_turn");
  });

  test("empty messages array is human_turn", () => {
    const req: ApiRequest = {
      model: "claude-sonnet-4-20250514",
      system: mainSystemPrompt,
      messages: [],
    };
    expect(classifyRequest(req, null)).toBe("human_turn");
  });
});
