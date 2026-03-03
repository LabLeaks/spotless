import { test, expect, describe } from "bun:test";
import { buildSelectorPrompt, SELECTOR_TOOLS, type SelectorContext } from "../src/selector-prompt.ts";
import type { Memory } from "../src/types.ts";
import type { IdentityNode } from "../src/recall.ts";

describe("buildSelectorPrompt", () => {
  const baseCtx: SelectorContext = {
    userMessage: "What was the architecture decision?",
    projectIdentity: null,
    preComputedRecall: [],
    identityNodes: [],
    identityFactIds: new Set(),
    recentRawSummary: null,
  };

  test("includes user message", () => {
    const prompt = buildSelectorPrompt(baseCtx);
    expect(prompt).toContain("What was the architecture decision?");
  });

  test("includes project identity when provided", () => {
    const prompt = buildSelectorPrompt({
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
    const prompt = buildSelectorPrompt({ ...baseCtx, identityNodes });
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
    const prompt = buildSelectorPrompt({
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
    const prompt = buildSelectorPrompt({
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
    const prompt = buildSelectorPrompt(baseCtx);
    expect(prompt).toContain("memory_ids");
    expect(prompt).not.toContain("CANDIDATE MEMORIES");
  });

  test("includes recent raw summary when provided", () => {
    const prompt = buildSelectorPrompt({
      ...baseCtx,
      recentRawSummary: "[USER] Tell me about auth\n[ASSISTANT] Auth uses JWT...",
    });
    expect(prompt).toContain("[USER] Tell me about auth");
  });

  test("tags identity fact candidates with [identity]", () => {
    const prompt = buildSelectorPrompt({
      ...baseCtx,
      identityFactIds: new Set([42]),
      preComputedRecall: [
        { id: 42, content: "I value clean code", salience: 0.85, created_at: Date.now(), last_accessed: Date.now(), access_count: 0, type: "fact", archived_at: null, score: 100 },
        { id: 10, content: "Project uses PostgreSQL", salience: 0.70, created_at: Date.now(), last_accessed: Date.now(), access_count: 0, type: "fact", archived_at: null, score: 1.5 },
      ],
    });
    expect(prompt).toContain("[id:42] [identity]");
    expect(prompt).not.toContain("[id:10] [identity]");
    expect(prompt).toContain("[id:10]");
  });

  test("identity facts not tagged when identityFactIds is empty", () => {
    const prompt = buildSelectorPrompt({
      ...baseCtx,
      identityFactIds: new Set(),
      preComputedRecall: [
        { id: 10, content: "Project uses PostgreSQL", salience: 0.70, created_at: Date.now(), last_accessed: Date.now(), access_count: 0, type: "fact", archived_at: null, score: 1.5 },
      ],
    });
    expect(prompt).not.toContain("[identity]");
  });

  test("instructions mention identity-tagged candidates", () => {
    const prompt = buildSelectorPrompt(baseCtx);
    expect(prompt).toContain("Identity-tagged candidates");
  });
});

describe("SELECTOR_TOOLS", () => {
  test("has 4 tools defined", () => {
    expect(SELECTOR_TOOLS.length).toBe(4);
  });

  test("each tool has name, description, and input_schema", () => {
    for (const tool of SELECTOR_TOOLS) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(tool.input_schema).toBeDefined();
      expect(tool.input_schema.type).toBe("object");
    }
  });

  test("tool names match expected set", () => {
    const names = SELECTOR_TOOLS.map(t => t.name);
    expect(names).toContain("recall");
    expect(names).toContain("get_context_bundle");
    expect(names).toContain("get_active_state");
    expect(names).toContain("get_recent_raw");
  });
});
