import { test, expect, describe } from "bun:test";
import {
  parseToolCall,
  shouldRunReflectionPass,
  loadNewMemories,
  getTotalMemoryCount,
  executeTool,
  CONSOLIDATION_TOOLS,
  REFLECTION_TOOLS,
} from "../src/digester.ts";
import type { DigestResult } from "../src/types.ts";
import { openDb, initSchema } from "../src/db.ts";
import { createMemory } from "../src/digest-tools.ts";
import { Database } from "bun:sqlite";

function createTestDb(): Database {
  const db = openDb(":memory:");
  initSchema(db);
  return db;
}

describe("digester", () => {
  describe("parseToolCall", () => {
    test("parses clean JSON tool call", () => {
      const call = parseToolCall('{"tool":"query_memories","input":{"query":"auth"}}');
      expect(call).toEqual({ tool: "query_memories", input: { query: "auth" } });
    });

    test("parses tool call with markdown fence", () => {
      const call = parseToolCall('```json\n{"tool":"create_memory","input":{"content":"test","salience":0.5,"source_event_ids":[1]}}\n```');
      expect(call?.tool).toBe("create_memory");
      expect(call?.input.content).toBe("test");
    });

    test("parses tool call embedded in prose", () => {
      const call = parseToolCall('I should check existing memories first.\n{"tool":"query_memories","input":{}}');
      expect(call?.tool).toBe("query_memories");
    });

    test("parses done signal", () => {
      const call = parseToolCall('{"tool":"done","input":{}}');
      expect(call).toEqual({ tool: "done", input: {} });
    });

    test("handles missing input field", () => {
      const call = parseToolCall('{"tool":"done"}');
      expect(call).toEqual({ tool: "done", input: {} });
    });

    test("returns null for garbage input", () => {
      expect(parseToolCall("this is not json")).toBeNull();
      expect(parseToolCall("")).toBeNull();
      expect(parseToolCall("[]")).toBeNull();
    });

    test("returns null for object without tool field", () => {
      expect(parseToolCall('{"not_a_tool": true}')).toBeNull();
    });

    test("parses create_association with new_N references", () => {
      const call = parseToolCall('{"tool":"create_association","input":{"memory_a":"new_0","memory_b":5,"strength":0.6}}');
      expect(call?.tool).toBe("create_association");
      expect(call?.input.memory_a).toBe("new_0");
      expect(call?.input.memory_b).toBe(5);
    });

    test("parses merge_memories call", () => {
      const call = parseToolCall('{"tool":"merge_memories","input":{"source_ids":[3,7],"content":"merged","salience":0.7}}');
      expect(call?.tool).toBe("merge_memories");
      expect(call?.input.source_ids).toEqual([3, 7]);
    });

    test("extracts first tool call when model hallucinates multi-turn", () => {
      const output = `{"tool":"create_association","input":{"memory_a":"new_0","memory_b":17,"strength":0.9}}

[TOOL_RESULT]
{"created_id":36}

{"tool":"create_association","input":{"memory_a":"new_0","memory_b":18,"strength":0.8}}`;
      const call = parseToolCall(output);
      expect(call?.tool).toBe("create_association");
      expect(call?.input.memory_a).toBe("new_0");
      expect(call?.input.memory_b).toBe(17);
      expect(call?.input.strength).toBe(0.9);
    });
  });

  describe("tool sets", () => {
    test("CONSOLIDATION_TOOLS does not contain identity tools", () => {
      expect(CONSOLIDATION_TOOLS.has("update_self_concept")).toBe(false);
      expect(CONSOLIDATION_TOOLS.has("evolve_identity")).toBe(false);
      expect(CONSOLIDATION_TOOLS.has("evolve_relationship")).toBe(false);
      expect(CONSOLIDATION_TOOLS.has("mark_significance")).toBe(false);
    });

    test("REFLECTION_TOOLS does not contain consolidation mutation tools", () => {
      expect(REFLECTION_TOOLS.has("create_memory")).toBe(false);
      expect(REFLECTION_TOOLS.has("create_association")).toBe(false);
      expect(REFLECTION_TOOLS.has("update_memory")).toBe(false);
      expect(REFLECTION_TOOLS.has("merge_memories")).toBe(false);
      expect(REFLECTION_TOOLS.has("supersede_memory")).toBe(false);
      expect(REFLECTION_TOOLS.has("query_raw_events")).toBe(false);
      expect(REFLECTION_TOOLS.has("drain_retrieval_log")).toBe(false);
    });

    test("REFLECTION_TOOLS contains query_memories for read-only context", () => {
      expect(REFLECTION_TOOLS.has("query_memories")).toBe(true);
    });

    test("both sets contain done", () => {
      expect(CONSOLIDATION_TOOLS.has("done")).toBe(true);
      expect(REFLECTION_TOOLS.has("done")).toBe(true);
    });
  });

  describe("shouldRunReflectionPass", () => {
    test("returns true when new memories were created", () => {
      expect(shouldRunReflectionPass([1, 2, 3])).toBe(true);
    });

    test("returns false when no new memories", () => {
      expect(shouldRunReflectionPass([])).toBe(false);
    });
  });

  describe("loadNewMemories", () => {
    test("loads memories by IDs", () => {
      const db = createTestDb();
      try {
        const id1 = createMemory(db, "first memory", 0.7, []);
        const id2 = createMemory(db, "second memory", 0.8, []);
        const loaded = loadNewMemories(db, [id1, id2]);
        expect(loaded).toHaveLength(2);
        expect(loaded.find(m => m.id === id1)?.content).toBe("first memory");
        expect(loaded.find(m => m.id === id2)?.salience).toBe(0.8);
      } finally {
        db.close();
      }
    });

    test("returns empty array for empty IDs", () => {
      const db = createTestDb();
      try {
        expect(loadNewMemories(db, [])).toEqual([]);
      } finally {
        db.close();
      }
    });
  });

  describe("getTotalMemoryCount", () => {
    test("returns count of all memories", () => {
      const db = createTestDb();
      try {
        expect(getTotalMemoryCount(db)).toBe(0);
        createMemory(db, "one", 0.5, []);
        createMemory(db, "two", 0.6, []);
        createMemory(db, "three", 0.7, []);
        expect(getTotalMemoryCount(db)).toBe(3);
      } finally {
        db.close();
      }
    });
  });

  describe("executeTool type passthrough", () => {
    function freshResult(): DigestResult {
      return {
        operationsRequested: 0, operationsExecuted: 0,
        memoriesCreated: 0, memoriesMerged: 0,
        memoriesSuperseded: 0, associationsCreated: 0, reflectionOps: 0,
        errors: [], durationMs: 0, groupsConsolidated: 0, pressure: 0,
      };
    }

    test("passes type through to createMemory", () => {
      const db = createTestDb();
      try {
        const result = freshResult();
        const newMemoryIds: number[] = [];
        const output = executeTool(db, { tool: "create_memory", input: {
          content: "project started in March 2024", salience: 0.7, type: "fact", source_event_ids: [],
        }}, newMemoryIds, result) as { created_id: number };

        const mem = db.query("SELECT type FROM memories WHERE id = ?").get(output.created_id) as any;
        expect(mem.type).toBe("fact");
      } finally {
        db.close();
      }
    });

    test("defaults to 'episodic' when type not specified", () => {
      const db = createTestDb();
      try {
        const result = freshResult();
        const newMemoryIds: number[] = [];
        const output = executeTool(db, { tool: "create_memory", input: {
          content: "something happened", salience: 0.5, source_event_ids: [],
        }}, newMemoryIds, result) as { created_id: number };

        const mem = db.query("SELECT type FROM memories WHERE id = ?").get(output.created_id) as any;
        expect(mem.type).toBe("episodic");
      } finally {
        db.close();
      }
    });

    test("rejects invalid type string", () => {
      const db = createTestDb();
      try {
        const result = freshResult();
        const newMemoryIds: number[] = [];
        expect(() => executeTool(db, { tool: "create_memory", input: {
          content: "test", salience: 0.5, type: "invalid_type", source_event_ids: [],
        }}, newMemoryIds, result)).toThrow("Invalid memory type");
      } finally {
        db.close();
      }
    });

    test("affective type is rejected", () => {
      const db = createTestDb();
      try {
        const result = freshResult();
        const newMemoryIds: number[] = [];
        expect(() => executeTool(db, { tool: "create_memory", input: {
          content: "that was tense", salience: 0.8, type: "affective", source_event_ids: [],
        }}, newMemoryIds, result)).toThrow("Invalid memory type");
      } finally {
        db.close();
      }
    });
  });
});
