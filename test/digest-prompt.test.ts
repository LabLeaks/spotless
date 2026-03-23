import { test, expect, describe } from "bun:test";
import {
  buildDigestSystemPrompt,
  buildDigestInitialMessage,
  buildDigestTurnPrompt,
  buildReflectionSystemPrompt,
  buildReflectionInitialMessage,
  type DigestContext,
  type DigestTurn,
  type ReflectionPassContext,
} from "../src/digest-prompt.ts";

describe("digest-prompt", () => {
  describe("buildDigestSystemPrompt", () => {
    test("includes consolidation goals", () => {
      const prompt = buildDigestSystemPrompt();
      expect(prompt).toContain("Substance filter");
      expect(prompt).toContain("Pattern separation");
      expect(prompt).toContain("Salience scoring");
    });

    test("includes 11 consolidation tool definitions", () => {
      const prompt = buildDigestSystemPrompt();
      expect(prompt).toContain("query_memories");
      expect(prompt).toContain("query_raw_events");
      expect(prompt).toContain("get_associations");
      expect(prompt).toContain("create_memory");
      expect(prompt).toContain("create_association");
      expect(prompt).toContain("update_memory");
      expect(prompt).toContain("merge_memories");
      expect(prompt).toContain("count_human_turns_between");
      expect(prompt).toContain("drain_retrieval_log");
      expect(prompt).toContain("supersede_memory");
    });

    test("does NOT include reflection tool definitions", () => {
      const prompt = buildDigestSystemPrompt();
      expect(prompt).not.toContain("reflect_on_self");
      expect(prompt).not.toContain("update_self_concept");
      expect(prompt).not.toContain("mark_significance");
    });

    test("does NOT include reflection goals", () => {
      const prompt = buildDigestSystemPrompt();
      expect(prompt).not.toContain("Self-reflection");
      expect(prompt).not.toContain("Relational awareness");
      expect(prompt).not.toContain("Valuation (vmPFC)");
    });

    test("includes done signal", () => {
      const prompt = buildDigestSystemPrompt();
      expect(prompt).toContain('"tool":"done"');
    });

    test("includes salience ranges per type", () => {
      const prompt = buildDigestSystemPrompt();
      expect(prompt).toContain("fact");
      expect(prompt).toContain("episodic");
    });

    test("create_memory includes type parameter", () => {
      const prompt = buildDigestSystemPrompt();
      expect(prompt).toContain('"type"');
      expect(prompt).toContain('"episodic"');
    });

    test("type classification heuristic in prompt", () => {
      const prompt = buildDigestSystemPrompt();
      // Should mention both types for classification
      expect(prompt).toContain("episodic");
      expect(prompt).toContain("fact");
      expect(prompt).toContain("Default to episodic");
    });

    test("does NOT mention [SUPERSEDED] prefix", () => {
      const prompt = buildDigestSystemPrompt();
      expect(prompt).not.toContain("[SUPERSEDED]");
    });

    test("mentions archive semantics for supersede", () => {
      const prompt = buildDigestSystemPrompt();
      expect(prompt).toContain("archived");
    });
  });

  describe("buildDigestInitialMessage", () => {
    test("includes raw events", () => {
      const msg = buildDigestInitialMessage({
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
      expect(msg).toContain('group id="1"');
    });

    test("includes retrieval log summary", () => {
      const msg = buildDigestInitialMessage({
        rawEventGroups: [{
          message_group: 1,
          events: [{ id: 1, role: "user", content_type: "text", content: "test" }],
        }],
        retrievalLogSummary: "Co-retrieved: [3, 7, 12]",
      });
      expect(msg).toContain("Co-retrieved: [3, 7, 12]");
      expect(msg).toContain("retrieval-co-occurrence");
    });

    test("truncates very long content", () => {
      const longContent = "x".repeat(3000);
      const msg = buildDigestInitialMessage({
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

  describe("buildDigestTurnPrompt", () => {
    test("includes system prompt and initial message", () => {
      const prompt = buildDigestTurnPrompt("SYSTEM", "INITIAL", []);
      expect(prompt).toContain("SYSTEM");
      expect(prompt).toContain("INITIAL");
    });

    test("includes conversation history", () => {
      const turns: DigestTurn[] = [
        { role: "assistant", content: '{"tool":"query_memories","input":{}}' },
        { role: "user", content: '{"memories":[]}' },
      ];
      const prompt = buildDigestTurnPrompt("SYS", "INIT", turns);
      expect(prompt).toContain("[ASSISTANT]");
      expect(prompt).toContain("query_memories");
      expect(prompt).toContain("[TOOL RESULT]");
      expect(prompt).toContain('"memories"');
    });

    test("adds continuation instruction when history exists", () => {
      const turns: DigestTurn[] = [
        { role: "assistant", content: "test" },
        { role: "user", content: "result" },
      ];
      const prompt = buildDigestTurnPrompt("SYS", "INIT", turns);
      expect(prompt).toContain("Continue");
    });
  });

  describe("buildReflectionSystemPrompt", () => {
    test("includes agent name and LLM identity in framing", () => {
      const prompt = buildReflectionSystemPrompt("wren");
      expect(prompt).toContain("LLM coding agent named wren");
      expect(prompt).toContain("Write as wren");
      expect(prompt).toContain("I, wren,");
    });

    test("does NOT use third-person consolidation framing", () => {
      const prompt = buildReflectionSystemPrompt("wren");
      expect(prompt).not.toContain("memory consolidation system");
    });

    test("includes only reflection tools, not consolidation mutation tools", () => {
      const prompt = buildReflectionSystemPrompt("wren");
      // Reflection tools present
      expect(prompt).toContain("update_self_concept");
      expect(prompt).toContain("mark_significance");
      expect(prompt).toContain("query_memories");
      expect(prompt).toContain("done");

      // reflect_on_self removed — all output through update_self_concept
      expect(prompt).not.toContain("reflect_on_self");

      // Consolidation mutation tools absent
      expect(prompt).not.toContain("create_memory");
      expect(prompt).not.toContain("create_association");
      expect(prompt).not.toContain("merge_memories");
      expect(prompt).not.toContain("update_memory");
      expect(prompt).not.toContain("supersede_memory");
      expect(prompt).not.toContain("query_raw_events");
      expect(prompt).not.toContain("drain_retrieval_log");
    });

    test("includes done signal", () => {
      const prompt = buildReflectionSystemPrompt("wren");
      expect(prompt).toContain('"tool":"done"');
    });
  });

  describe("buildReflectionInitialMessage", () => {
    test("shows new memories with IDs", () => {
      const msg = buildReflectionInitialMessage({
        agentName: "wren",
        newMemories: [
          { id: 5, content: "Project uses Bun runtime", salience: 0.7 },
          { id: 6, content: "Preferred DB is PostgreSQL", salience: 0.6 },
        ],
        identityNodes: [],
        totalMemoryCount: 10,
      });
      expect(msg).toContain("#5");
      expect(msg).toContain("salience 0.7");
      expect(msg).toContain("Project uses Bun runtime");
      expect(msg).toContain("#6");
      expect(msg).toContain("Preferred DB is PostgreSQL");
    });

    test("shows existing identity nodes with role labels", () => {
      const msg = buildReflectionInitialMessage({
        agentName: "wren",
        newMemories: [],
        identityNodes: [
          { role: "self", id: 1, content: "Thorough and test-first" },
          { role: "relationship", id: 2, content: "User trusts me with git ops" },
        ],
        totalMemoryCount: 20,
      });
      expect(msg).toContain("Self-Concept");
      expect(msg).toContain("memory #1");
      expect(msg).toContain("Thorough and test-first");
      expect(msg).toContain("Relationship Dynamic");
      expect(msg).toContain("memory #2");
    });

    test("shows fresh start when no identity exists", () => {
      const msg = buildReflectionInitialMessage({
        agentName: "wren",
        newMemories: [{ id: 1, content: "test", salience: 0.5 }],
        identityNodes: [],
        totalMemoryCount: 1,
      });
      expect(msg).toContain("fresh start");
    });

    test("shows total memory count", () => {
      const msg = buildReflectionInitialMessage({
        agentName: "wren",
        newMemories: [],
        identityNodes: [],
        totalMemoryCount: 42,
      });
      expect(msg).toContain("42");
    });

    test("shows no new memories message when empty", () => {
      const msg = buildReflectionInitialMessage({
        agentName: "wren",
        newMemories: [],
        identityNodes: [{ role: "self", id: 1, content: "test" }],
        totalMemoryCount: 5,
      });
      expect(msg).toContain("No new memories");
    });

    test("shows associated memories per anchor when provided", () => {
      const msg = buildReflectionInitialMessage({
        agentName: "wren",
        newMemories: [{ id: 10, content: "new thing", salience: 0.6 }],
        identityNodes: [
          { role: "self", id: 1, content: "I am thorough" },
          { role: "relationship", id: 2, content: "Trust-based" },
        ],
        totalMemoryCount: 20,
        associatedMemories: {
          self: [
            { id: 5, content: "I value correctness", salience: 0.8 },
            { id: 7, content: "I prefer Bun over Node", salience: 0.7 },
          ],
          relationship: [
            { id: 9, content: "They trust me with git ops", salience: 0.75 },
          ],
        },
      });
      expect(msg).toContain("Existing self facts");
      expect(msg).toContain("#5");
      expect(msg).toContain("I value correctness");
      expect(msg).toContain("#7");
      expect(msg).toContain("Existing relationship facts");
      expect(msg).toContain("#9");
      expect(msg).toContain("supersedes_id");
    });

    test("omits associated memories section when not provided", () => {
      const msg = buildReflectionInitialMessage({
        agentName: "wren",
        newMemories: [{ id: 10, content: "new thing", salience: 0.6 }],
        identityNodes: [{ role: "self", id: 1, content: "I am thorough" }],
        totalMemoryCount: 5,
      });
      expect(msg).not.toContain("Existing self facts");
    });
  });
});
