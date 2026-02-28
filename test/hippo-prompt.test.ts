import { test, expect, describe } from "bun:test";
import { buildHippoPrompt, HIPPO_TOOLS, type HippoContext } from "../src/hippo-prompt.ts";
import type { Memory } from "../src/types.ts";
import type { IdentityNode } from "../src/recall.ts";

describe("buildHippoPrompt", () => {
  const baseCtx: HippoContext = {
    userMessage: "What was the architecture decision?",
    projectIdentity: null,
    preComputedRecall: [],
    identityNodes: [],
    recentRawSummary: null,
  };

  test("includes user message", () => {
    const prompt = buildHippoPrompt(baseCtx);
    expect(prompt).toContain("What was the architecture decision?");
  });

  test("includes project identity when provided", () => {
    const prompt = buildHippoPrompt({
      ...baseCtx,
      projectIdentity: "/home/user/my-project",
    });
    expect(prompt).toContain("/home/user/my-project");
  });

  test("includes identity nodes with role labels", () => {
    const identityNodes: IdentityNode[] = [{
      id: 1, content: "I am a thorough engineer", salience: 0.9,
      created_at: Date.now(), last_accessed: Date.now(), access_count: 5,
      type: "episodic", archived_at: null, role: "self",
    }];
    const prompt = buildHippoPrompt({ ...baseCtx, identityNodes });
    expect(prompt).toContain("I am a thorough engineer");
    expect(prompt).toContain("[Self-Concept, id:1]");
    expect(prompt).toContain("WHO YOU ARE");
  });

  test("excludes identity nodes from candidate memories (dedup)", () => {
    const identityNodes: IdentityNode[] = [{
      id: 1, content: "Self model", salience: 0.9,
      created_at: Date.now(), last_accessed: Date.now(), access_count: 5,
      type: "episodic", archived_at: null, role: "self",
    }];
    const prompt = buildHippoPrompt({
      ...baseCtx,
      identityNodes,
      preComputedRecall: [
        { id: 1, content: "Self model", salience: 0.9, created_at: Date.now(), last_accessed: Date.now(), access_count: 5, type: "episodic", archived_at: null, score: 999 },
        { id: 10, content: "Other memory", salience: 0.5, created_at: Date.now(), last_accessed: Date.now(), access_count: 0, type: "episodic", archived_at: null, score: 1.2 },
      ],
    });
    // Self model should appear in WHO YOU ARE section only
    expect(prompt).toContain("WHO YOU ARE");
    expect(prompt).toContain("[Self-Concept, id:1] Self model");
    // id:1 should NOT appear in CANDIDATE MEMORIES
    expect(prompt).toContain("CANDIDATE MEMORIES");
    expect(prompt).toContain("[id:10]");
    // Count occurrences of "[id:1]" — should only appear in working self as "[Self-Concept, id:1]"
    const candidateSection = prompt.split("CANDIDATE MEMORIES")[1]!;
    expect(candidateSection).not.toContain("[id:1]");
  });

  test("includes pre-computed recall results", () => {
    const prompt = buildHippoPrompt({
      ...baseCtx,
      preComputedRecall: [
        { id: 10, content: "Uses PostgreSQL", salience: 0.7, created_at: Date.now(), last_accessed: Date.now(), access_count: 2, type: "fact", archived_at: null, score: 1.5 },
        { id: 20, content: "Has REST API", salience: 0.6, created_at: Date.now(), last_accessed: Date.now(), access_count: 1, type: "fact", archived_at: null, score: 1.2 },
      ],
    });
    expect(prompt).toContain("[id:10]");
    expect(prompt).toContain("Uses PostgreSQL");
    expect(prompt).toContain("[id:20]");
  });

  test("handles empty recall results gracefully", () => {
    const prompt = buildHippoPrompt(baseCtx);
    expect(prompt).toContain("memory_ids");
    expect(prompt).not.toContain("CANDIDATE MEMORIES");
  });

  test("includes recent raw summary when provided", () => {
    const prompt = buildHippoPrompt({
      ...baseCtx,
      recentRawSummary: "[USER] Tell me about auth\n[ASSISTANT] Auth uses JWT...",
    });
    expect(prompt).toContain("[USER] Tell me about auth");
  });
});

describe("HIPPO_TOOLS", () => {
  test("has 4 tools defined", () => {
    expect(HIPPO_TOOLS.length).toBe(4);
  });

  test("each tool has name, description, and input_schema", () => {
    for (const tool of HIPPO_TOOLS) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(tool.input_schema).toBeDefined();
      expect(tool.input_schema.type).toBe("object");
    }
  });

  test("tool names match expected set", () => {
    const names = HIPPO_TOOLS.map(t => t.name);
    expect(names).toContain("recall");
    expect(names).toContain("get_context_bundle");
    expect(names).toContain("get_active_state");
    expect(names).toContain("get_recent_raw");
  });
});
