import { test, expect, describe } from "bun:test";
import {
  createWorkingSet,
  updateWorkingSetFromBlocks,
  updateWorkingSetFromUserMessage,
  decayWorkingSet,
  getWorkingSetFiles,
  getWorkingSetConcepts,
  WORKING_SET_MAX_AGE,
} from "../src/working-set.ts";
import type { CapturedBlock } from "../src/archiver.ts";

function makeToolBlock(toolName: string, input: Record<string, unknown>): CapturedBlock {
  return {
    type: "tool_use",
    content: JSON.stringify(input),
    metadata: { tool_name: toolName, tool_id: `toolu_${Math.random().toString(36).slice(2)}` },
  };
}

describe("createWorkingSet", () => {
  test("creates empty working set", () => {
    const ws = createWorkingSet();
    expect(ws.files.size).toBe(0);
    expect(ws.concepts.size).toBe(0);
    expect(ws.lastUpdatedTurn).toBe(0);
  });
});

describe("updateWorkingSetFromBlocks", () => {
  test("extracts Read file path", () => {
    const ws = createWorkingSet();
    const blocks: CapturedBlock[] = [
      makeToolBlock("Read", { file_path: "src/proxy.ts" }),
    ];
    updateWorkingSetFromBlocks(ws, blocks, 5);
    expect(getWorkingSetFiles(ws)).toEqual(["src/proxy.ts"]);
    expect(ws.files.get("src/proxy.ts")!.action).toBe("read");
  });

  test("extracts Edit file path as edit action", () => {
    const ws = createWorkingSet();
    const blocks: CapturedBlock[] = [
      makeToolBlock("Edit", { file_path: "src/db.ts", old_string: "a", new_string: "b" }),
    ];
    updateWorkingSetFromBlocks(ws, blocks, 5);
    expect(ws.files.get("src/db.ts")!.action).toBe("edit");
  });

  test("extracts Write file path as edit action", () => {
    const ws = createWorkingSet();
    const blocks: CapturedBlock[] = [
      makeToolBlock("Write", { file_path: "test/new.ts", content: "hello" }),
    ];
    updateWorkingSetFromBlocks(ws, blocks, 5);
    expect(ws.files.get("test/new.ts")!.action).toBe("edit");
  });

  test("extracts Grep pattern as concept", () => {
    const ws = createWorkingSet();
    const blocks: CapturedBlock[] = [
      makeToolBlock("Grep", { pattern: "cache_control" }),
    ];
    updateWorkingSetFromBlocks(ws, blocks, 5);
    expect(getWorkingSetConcepts(ws)).toContain("cache_control");
  });

  test("extracts Glob pattern as concept", () => {
    const ws = createWorkingSet();
    const blocks: CapturedBlock[] = [
      makeToolBlock("Glob", { pattern: "**/*.ts" }),
    ];
    updateWorkingSetFromBlocks(ws, blocks, 5);
    expect(getWorkingSetConcepts(ws)).toContain("**/*.ts");
  });

  test("extracts Bash command first word as concept", () => {
    const ws = createWorkingSet();
    const blocks: CapturedBlock[] = [
      makeToolBlock("Bash", { command: "git status --short" }),
    ];
    updateWorkingSetFromBlocks(ws, blocks, 5);
    expect(getWorkingSetConcepts(ws)).toContain("git");
  });

  test("ignores Bash commands shorter than 3 chars", () => {
    const ws = createWorkingSet();
    const blocks: CapturedBlock[] = [
      makeToolBlock("Bash", { command: "ls" }),
    ];
    updateWorkingSetFromBlocks(ws, blocks, 5);
    expect(getWorkingSetConcepts(ws)).not.toContain("ls");
  });

  test("handles multiple tool blocks in one response", () => {
    const ws = createWorkingSet();
    const blocks: CapturedBlock[] = [
      makeToolBlock("Read", { file_path: "a.ts" }),
      makeToolBlock("Edit", { file_path: "b.ts" }),
      makeToolBlock("Grep", { pattern: "foo" }),
    ];
    updateWorkingSetFromBlocks(ws, blocks, 5);
    expect(getWorkingSetFiles(ws).sort()).toEqual(["a.ts", "b.ts"]);
    expect(getWorkingSetConcepts(ws)).toContain("foo");
  });

  test("skips non-tool_use blocks", () => {
    const ws = createWorkingSet();
    const blocks: CapturedBlock[] = [
      { type: "text", content: "some text" },
      { type: "thinking", content: "thinking..." },
    ];
    updateWorkingSetFromBlocks(ws, blocks, 5);
    expect(getWorkingSetFiles(ws)).toHaveLength(0);
    expect(getWorkingSetConcepts(ws).length).toBe(0);
  });

  test("updates lastTurn on repeated reads of same file", () => {
    const ws = createWorkingSet();
    updateWorkingSetFromBlocks(ws, [makeToolBlock("Read", { file_path: "a.ts" })], 5);
    expect(ws.files.get("a.ts")!.lastTurn).toBe(5);
    updateWorkingSetFromBlocks(ws, [makeToolBlock("Read", { file_path: "a.ts" })], 10);
    expect(ws.files.get("a.ts")!.lastTurn).toBe(10);
  });

  test("handles malformed tool content gracefully", () => {
    const ws = createWorkingSet();
    const blocks: CapturedBlock[] = [{
      type: "tool_use",
      content: "not json",
      metadata: { tool_name: "Read", tool_id: "t1" },
    }];
    // Should not throw
    updateWorkingSetFromBlocks(ws, blocks, 5);
    expect(getWorkingSetFiles(ws)).toHaveLength(0);
  });
});

describe("updateWorkingSetFromUserMessage", () => {
  test("extracts keywords from user message", () => {
    const ws = createWorkingSet();
    updateWorkingSetFromUserMessage(ws, "Check the proxy module for caching issues", 5);
    const concepts = getWorkingSetConcepts(ws);
    expect(concepts).toContain("check");
    expect(concepts).toContain("proxy");
    expect(concepts).toContain("module");
    expect(concepts).toContain("caching");
    expect(concepts).toContain("issues");
  });

  test("filters stopwords", () => {
    const ws = createWorkingSet();
    updateWorkingSetFromUserMessage(ws, "the quick brown fox jumps over the lazy dog", 5);
    const concepts = getWorkingSetConcepts(ws);
    expect(concepts).not.toContain("the");
    expect(concepts).not.toContain("over");
    expect(concepts).toContain("quick");
    expect(concepts).toContain("brown");
    expect(concepts).toContain("fox");
  });

  test("filters words shorter than 3 chars", () => {
    const ws = createWorkingSet();
    updateWorkingSetFromUserMessage(ws, "go to db and fix it", 5);
    const concepts = getWorkingSetConcepts(ws);
    expect(concepts).not.toContain("go");
    expect(concepts).not.toContain("to");
    expect(concepts).not.toContain("db");
    expect(concepts).toContain("fix");
  });

  test("limits to 10 keywords", () => {
    const ws = createWorkingSet();
    updateWorkingSetFromUserMessage(
      ws,
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu",
      5,
    );
    expect(getWorkingSetConcepts(ws).length).toBeLessThanOrEqual(10);
  });

  test("deduplicates words", () => {
    const ws = createWorkingSet();
    updateWorkingSetFromUserMessage(ws, "proxy proxy proxy caching caching", 5);
    const concepts = getWorkingSetConcepts(ws);
    expect(concepts).toContain("proxy");
    expect(concepts).toContain("caching");
  });
});

describe("decayWorkingSet", () => {
  test("removes files older than maxAge", () => {
    const ws = createWorkingSet();
    updateWorkingSetFromBlocks(ws, [makeToolBlock("Read", { file_path: "old.ts" })], 1);
    updateWorkingSetFromBlocks(ws, [makeToolBlock("Read", { file_path: "new.ts" })], 15);

    decayWorkingSet(ws, 15, WORKING_SET_MAX_AGE);
    expect(getWorkingSetFiles(ws)).toEqual(["new.ts"]);
  });

  test("keeps recent files", () => {
    const ws = createWorkingSet();
    updateWorkingSetFromBlocks(ws, [makeToolBlock("Read", { file_path: "a.ts" })], 8);
    updateWorkingSetFromBlocks(ws, [makeToolBlock("Read", { file_path: "b.ts" })], 10);

    decayWorkingSet(ws, 15, WORKING_SET_MAX_AGE);
    expect(getWorkingSetFiles(ws).sort()).toEqual(["a.ts", "b.ts"]);
  });

  test("clears concepts when working set is stale", () => {
    const ws = createWorkingSet();
    updateWorkingSetFromUserMessage(ws, "proxy caching module", 1);
    expect(getWorkingSetConcepts(ws).length).toBeGreaterThan(0);

    decayWorkingSet(ws, 20, WORKING_SET_MAX_AGE);
    expect(getWorkingSetConcepts(ws).length).toBe(0);
  });

  test("keeps concepts when working set is recent", () => {
    const ws = createWorkingSet();
    updateWorkingSetFromUserMessage(ws, "proxy caching module", 12);

    decayWorkingSet(ws, 15, WORKING_SET_MAX_AGE);
    expect(getWorkingSetConcepts(ws).length).toBeGreaterThan(0);
  });
});
