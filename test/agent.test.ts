import { test, expect, describe } from "bun:test";
import {
  parseAgentFromUrl,
  stripAgentPrefix,
  validateAgentName,
  generateAgentName,
  getAgentDbPath,
} from "../src/agent.ts";
import { join } from "node:path";
import { homedir } from "node:os";

describe("parseAgentFromUrl", () => {
  test("extracts agent name from /agent/<name>/v1/messages", () => {
    expect(parseAgentFromUrl("/agent/wren/v1/messages")).toBe("wren");
  });

  test("extracts agent name from /agent/<name>/v1/messages with hyphens", () => {
    expect(parseAgentFromUrl("/agent/my-agent-1/v1/messages")).toBe("my-agent-1");
  });

  test("returns null for bare /v1/messages", () => {
    expect(parseAgentFromUrl("/v1/messages")).toBeNull();
  });

  test("returns null for /v1/messages/count", () => {
    expect(parseAgentFromUrl("/v1/messages/count")).toBeNull();
  });

  test("returns null for invalid agent name (uppercase)", () => {
    expect(parseAgentFromUrl("/agent/Wren/v1/messages")).toBeNull();
  });

  test("returns null for agent name starting with hyphen", () => {
    expect(parseAgentFromUrl("/agent/-wren/v1/messages")).toBeNull();
  });

  test("extracts agent with no trailing path", () => {
    expect(parseAgentFromUrl("/agent/wren")).toBe("wren");
  });
});

describe("stripAgentPrefix", () => {
  test("strips /agent/<name> from path", () => {
    expect(stripAgentPrefix("/agent/wren/v1/messages")).toBe("/v1/messages");
  });

  test("leaves bare /v1/messages unchanged", () => {
    expect(stripAgentPrefix("/v1/messages")).toBe("/v1/messages");
  });

  test("handles agent with only name (no subpath)", () => {
    expect(stripAgentPrefix("/agent/wren")).toBe("/");
  });
});

describe("validateAgentName", () => {
  test("accepts lowercase alpha", () => {
    expect(validateAgentName("wren")).toBe(true);
  });

  test("accepts alphanumeric with hyphens", () => {
    expect(validateAgentName("my-agent-1")).toBe(true);
  });

  test("rejects uppercase", () => {
    expect(validateAgentName("Wren")).toBe(false);
  });

  test("rejects spaces", () => {
    expect(validateAgentName("my agent")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(validateAgentName("")).toBe(false);
  });

  test("rejects name starting with hyphen", () => {
    expect(validateAgentName("-wren")).toBe(false);
  });

  test("rejects name longer than 32 chars", () => {
    expect(validateAgentName("a".repeat(33))).toBe(false);
  });

  test("accepts name exactly 32 chars", () => {
    expect(validateAgentName("a".repeat(32))).toBe(true);
  });

  test("accepts single char", () => {
    expect(validateAgentName("a")).toBe(true);
  });
});

describe("generateAgentName", () => {
  test("returns a valid name", () => {
    const name = generateAgentName();
    expect(validateAgentName(name)).toBe(true);
    expect(name.length).toBeGreaterThan(0);
  });
});

describe("getAgentDbPath", () => {
  test("returns correct path under ~/.spotless/agents/", () => {
    const path = getAgentDbPath("wren");
    expect(path).toBe(join(homedir(), ".spotless", "agents", "wren", "spotless.db"));
  });
});
