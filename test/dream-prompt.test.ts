import { test, expect, describe } from "bun:test";
import {
  buildDreamSystemPrompt,
  buildDreamInitialMessage,
  buildDreamTurnPrompt,
  buildIdentitySystemPrompt,
  buildIdentityInitialMessage,
  type DreamContext,
  type DreamTurn,
  type IdentityPassContext,
} from "../src/dream-prompt.ts";

describe("dream-prompt", () => {
  describe("buildDreamSystemPrompt", () => {
    test("includes consolidation goals", () => {
      const prompt = buildDreamSystemPrompt();
      expect(prompt).toContain("Substance filter");
      expect(prompt).toContain("Pattern separation");
      expect(prompt).toContain("Salience scoring");
      expect(prompt).toContain("Pruning");
    });

    test("includes 11 consolidation tool definitions", () => {
      const prompt = buildDreamSystemPrompt();
      expect(prompt).toContain("query_memories");
      expect(prompt).toContain("query_raw_events");
      expect(prompt).toContain("get_associations");
      expect(prompt).toContain("create_memory");
      expect(prompt).toContain("create_association");
      expect(prompt).toContain("update_memory");
      expect(prompt).toContain("merge_memories");
      expect(prompt).toContain("count_human_turns_between");
      expect(prompt).toContain("prune_memory");
      expect(prompt).toContain("drain_retrieval_log");
      expect(prompt).toContain("supersede_memory");
    });

    test("does NOT include identity tool definitions", () => {
      const prompt = buildDreamSystemPrompt();
      expect(prompt).not.toContain("reflect_on_self");
      expect(prompt).not.toContain("evolve_identity");
      expect(prompt).not.toContain("evolve_relationship");
      expect(prompt).not.toContain("mark_significance");
    });

    test("does NOT include identity goals", () => {
      const prompt = buildDreamSystemPrompt();
      expect(prompt).not.toContain("Self-reflection");
      expect(prompt).not.toContain("Relational awareness");
      expect(prompt).not.toContain("Valuation (vmPFC)");
    });

    test("includes done signal", () => {
      const prompt = buildDreamSystemPrompt();
      expect(prompt).toContain('"tool":"done"');
    });

    test("includes salience ranges per type", () => {
      const prompt = buildDreamSystemPrompt();
      expect(prompt).toContain("fact");
      expect(prompt).toContain("episodic");
      expect(prompt).toContain("affective");
    });

    test("create_memory includes type parameter", () => {
      const prompt = buildDreamSystemPrompt();
      expect(prompt).toContain('"type"');
      expect(prompt).toContain('"episodic"');
    });

    test("type classification heuristic in prompt", () => {
      const prompt = buildDreamSystemPrompt();
      // Should mention all three types for classification
      expect(prompt).toContain("episodic");
      expect(prompt).toContain("fact");
      expect(prompt).toContain("affective");
      expect(prompt).toContain("Default to episodic");
    });

    test("does NOT mention [SUPERSEDED] prefix", () => {
      const prompt = buildDreamSystemPrompt();
      expect(prompt).not.toContain("[SUPERSEDED]");
    });

    test("mentions archive semantics for supersede", () => {
      const prompt = buildDreamSystemPrompt();
      expect(prompt).toContain("archived");
    });
  });

  describe("buildDreamInitialMessage", () => {
    test("includes raw events", () => {
      const msg = buildDreamInitialMessage({
        rawEventGroups: [{
          message_group: 1,
          events: [
            { id: 1, role: "user", content_type: "text", content: "hello world" },
            { id: 2, role: "assistant", content_type: "text", content: "hi there" },
          ],
        }],
        retrievalLogSummary: null,
      });
      expect(msg).toContain("[USER] (id:1, type:text) hello world");
      expect(msg).toContain("[ASSISTANT] (id:2, type:text) hi there");
      expect(msg).toContain("Group 1");
    });

    test("includes retrieval log summary", () => {
      const msg = buildDreamInitialMessage({
        rawEventGroups: [{
          message_group: 1,
          events: [{ id: 1, role: "user", content_type: "text", content: "test" }],
        }],
        retrievalLogSummary: "Co-retrieved: [3, 7, 12]",
      });
      expect(msg).toContain("Co-retrieved: [3, 7, 12]");
      expect(msg).toContain("RETRIEVAL CO-OCCURRENCE");
    });

    test("truncates very long content", () => {
      const longContent = "x".repeat(3000);
      const msg = buildDreamInitialMessage({
        rawEventGroups: [{
          message_group: 1,
          events: [{ id: 1, role: "user", content_type: "text", content: longContent }],
        }],
        retrievalLogSummary: null,
      });
      expect(msg).toContain("[truncated]");
      expect(msg).not.toContain(longContent);
    });
  });

  describe("buildDreamTurnPrompt", () => {
    test("includes system prompt and initial message", () => {
      const prompt = buildDreamTurnPrompt("SYSTEM", "INITIAL", []);
      expect(prompt).toContain("SYSTEM");
      expect(prompt).toContain("INITIAL");
    });

    test("includes conversation history", () => {
      const turns: DreamTurn[] = [
        { role: "assistant", content: '{"tool":"query_memories","input":{}}' },
        { role: "user", content: '{"memories":[]}' },
      ];
      const prompt = buildDreamTurnPrompt("SYS", "INIT", turns);
      expect(prompt).toContain("[ASSISTANT]");
      expect(prompt).toContain("query_memories");
      expect(prompt).toContain("[TOOL RESULT]");
      expect(prompt).toContain('"memories"');
    });

    test("adds continuation instruction when history exists", () => {
      const turns: DreamTurn[] = [
        { role: "assistant", content: "test" },
        { role: "user", content: "result" },
      ];
      const prompt = buildDreamTurnPrompt("SYS", "INIT", turns);
      expect(prompt).toContain("Continue");
    });
  });

  describe("buildIdentitySystemPrompt", () => {
    test("includes agent name and LLM identity in framing", () => {
      const prompt = buildIdentitySystemPrompt("wren");
      expect(prompt).toContain("LLM coding agent named wren");
      expect(prompt).toContain("Write as wren");
      expect(prompt).toContain("I, wren,");
      expect(prompt).toContain("I am wren, an LLM coding agent");
    });

    test("does NOT use third-person consolidation framing", () => {
      const prompt = buildIdentitySystemPrompt("wren");
      expect(prompt).not.toContain("memory consolidation system");
    });

    test("includes only identity tools, not consolidation mutation tools", () => {
      const prompt = buildIdentitySystemPrompt("wren");
      // Identity tools present
      expect(prompt).toContain("reflect_on_self");
      expect(prompt).toContain("evolve_identity");
      expect(prompt).toContain("evolve_relationship");
      expect(prompt).toContain("mark_significance");
      expect(prompt).toContain("query_memories");
      expect(prompt).toContain("done");

      // Consolidation mutation tools absent
      expect(prompt).not.toContain("create_memory");
      expect(prompt).not.toContain("create_association");
      expect(prompt).not.toContain("merge_memories");
      expect(prompt).not.toContain("update_memory");
      expect(prompt).not.toContain("prune_memory");
      expect(prompt).not.toContain("supersede_memory");
      expect(prompt).not.toContain("query_raw_events");
      expect(prompt).not.toContain("drain_retrieval_log");
    });

    test("includes done signal", () => {
      const prompt = buildIdentitySystemPrompt("wren");
      expect(prompt).toContain('"tool":"done"');
    });
  });

  describe("buildIdentityInitialMessage", () => {
    test("shows new memories with IDs", () => {
      const msg = buildIdentityInitialMessage({
        agentName: "wren",
        newMemories: [
          { id: 5, content: "User prefers purple", salience: 0.7 },
          { id: 6, content: "Dog named Biscuit", salience: 0.6 },
        ],
        identityNodes: [],
        totalMemoryCount: 10,
      });
      expect(msg).toContain("#5");
      expect(msg).toContain("salience 0.7");
      expect(msg).toContain("User prefers purple");
      expect(msg).toContain("#6");
      expect(msg).toContain("Dog named Biscuit");
    });

    test("shows existing identity nodes with role labels", () => {
      const msg = buildIdentityInitialMessage({
        agentName: "wren",
        newMemories: [],
        identityNodes: [
          { role: "self", id: 1, content: "Thorough and test-first" },
          { role: "relationship", id: 2, content: "User trusts me with git ops" },
        ],
        totalMemoryCount: 20,
      });
      expect(msg).toContain("Self-Model");
      expect(msg).toContain("memory #1");
      expect(msg).toContain("Thorough and test-first");
      expect(msg).toContain("Relationship Model");
      expect(msg).toContain("memory #2");
    });

    test("shows fresh start when no identity exists", () => {
      const msg = buildIdentityInitialMessage({
        agentName: "wren",
        newMemories: [{ id: 1, content: "test", salience: 0.5 }],
        identityNodes: [],
        totalMemoryCount: 1,
      });
      expect(msg).toContain("fresh start");
    });

    test("shows total memory count", () => {
      const msg = buildIdentityInitialMessage({
        agentName: "wren",
        newMemories: [],
        identityNodes: [],
        totalMemoryCount: 42,
      });
      expect(msg).toContain("42");
    });

    test("shows no new memories message when empty", () => {
      const msg = buildIdentityInitialMessage({
        agentName: "wren",
        newMemories: [],
        identityNodes: [{ role: "self", id: 1, content: "test" }],
        totalMemoryCount: 5,
      });
      expect(msg).toContain("No new memories");
    });
  });
});
