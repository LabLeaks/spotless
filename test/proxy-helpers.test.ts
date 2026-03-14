import { test, expect, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { extractSystemText, extractUserText, isSuggestionModeProbe, augmentSystemPrompt } from "../src/proxy.ts";
import { openDb, initSchema } from "../src/db.ts";
import { getIdentityNodes } from "../src/recall.ts";
import { buildMemorySuffix } from "../src/memory-suffix.ts";
import {
  estimateSystemTokens,
  estimateToolsTokens,
  computeHistoryBudget,
  estimateTokens,
  DEFAULT_CONTEXT_BUDGET,
  TIER2_BUDGET,
  computeTier2Budget,
  IDENTITY_FLOOR,
  MEMORY_FLOOR,
  SUFFIX_OVERHEAD,
} from "../src/tokens.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

function tempDb(): { db: Database; path: string } {
  const path = join(tmpdir(), `spotless-proxy-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = openDb(path);
  initSchema(db);
  return { db, path };
}

describe("extractSystemText", () => {
  test("returns null for undefined", () => {
    expect(extractSystemText(undefined)).toBeNull();
  });

  test("returns string as-is", () => {
    expect(extractSystemText("hello")).toBe("hello");
  });

  test("joins text blocks", () => {
    const blocks = [
      { type: "text" as const, text: "line 1" },
      { type: "text" as const, text: "line 2" },
    ];
    expect(extractSystemText(blocks)).toBe("line 1\nline 2");
  });
});

describe("extractUserText", () => {
  test("string content", () => {
    expect(extractUserText({ role: "user", content: "hello" })).toBe("hello");
  });

  test("array content extracts text blocks", () => {
    const msg = {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "hello " },
        { type: "tool_result" as const, tool_use_id: "x", content: "result" },
        { type: "text" as const, text: "world" },
      ],
    };
    expect(extractUserText(msg)).toBe("hello \nworld");
  });
});

describe("isSuggestionModeProbe", () => {
  test("detects suggestion mode text", () => {
    expect(isSuggestionModeProbe("[SUGGESTION MODE: Suggest what the user might naturally type next...]")).toBe(true);
  });

  test("detects suggestion mode embedded in larger text", () => {
    expect(isSuggestionModeProbe("some prefix [SUGGESTION MODE: anything] suffix")).toBe(true);
  });

  test("normal user text returns false", () => {
    expect(isSuggestionModeProbe("how are you today?")).toBe(false);
  });

  test("empty string returns false", () => {
    expect(isSuggestionModeProbe("")).toBe(false);
  });
});

describe("identity node surfacing", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const p of cleanup) {
      try { unlinkSync(p); } catch {}
      try { unlinkSync(p + "-wal"); } catch {}
      try { unlinkSync(p + "-shm"); } catch {}
    }
    cleanup.length = 0;
  });

  test("getIdentityNodes returns identity content when nodes exist", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const now = Date.now();
    db.run(
      "INSERT INTO memories (content, salience, created_at, last_accessed, access_count) VALUES (?, ?, ?, ?, ?)",
      ["I am nova, a philosophical AI agent with deep convictions about ethical reasoning.", 0.9, now, now, 0],
    );
    const selfId = (db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id;
    db.run("INSERT OR REPLACE INTO identity_nodes (role, memory_id) VALUES (?, ?)", ["self", selfId]);

    db.run(
      "INSERT INTO memories (content, salience, created_at, last_accessed, access_count) VALUES (?, ?, ?, ?, ?)",
      ["My relationship with this human is collaborative and exploratory.", 0.85, now, now, 0],
    );
    const relId = (db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id;
    db.run("INSERT OR REPLACE INTO identity_nodes (role, memory_id) VALUES (?, ?)", ["relationship", relId]);

    const nodes = getIdentityNodes(db);
    expect(nodes.length).toBe(2);
    expect(nodes.some(n => n.role === "self" && n.content.includes("nova"))).toBe(true);
    expect(nodes.some(n => n.role === "relationship" && n.content.includes("collaborative"))).toBe(true);

    db.close();
  });

  test("identity node IDs filtered from selector result avoids duplication", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const now = Date.now();
    // Create identity memory
    db.run(
      "INSERT INTO memories (content, salience, created_at, last_accessed, access_count) VALUES (?, ?, ?, ?, ?)",
      ["I am nova, a philosophical AI agent.", 0.9, now, now, 0],
    );
    const selfId = (db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id;
    db.run("INSERT OR REPLACE INTO identity_nodes (role, memory_id) VALUES (?, ?)", ["self", selfId]);

    // Create regular memory
    db.run(
      "INSERT INTO memories (content, salience, created_at, last_accessed, access_count) VALUES (?, ?, ?, ?, ?)",
      ["Project started in March 2024.", 0.7, now + 1, now + 1, 0],
    );
    const factId = (db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id;

    // Simulate selector returning both identity and regular memories
    const selectorResult = [selfId, factId];
    const identityNodeIds = getIdentityNodes(db).map(n => n.id);

    // Filter identity IDs
    const filteredIds = selectorResult.filter(id => !identityNodeIds.includes(id));
    expect(filteredIds).toEqual([factId]);

    // Memory suffix from filtered IDs contains only the regular memory
    const suffix = buildMemorySuffix(db, filteredIds);
    expect(suffix).toContain("March 2024");
    expect(suffix).not.toContain("nova");

    db.close();
  });

  test("identity tag uses full content when nodes exist, falls back to name (uses <your identity> tag)", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const agentName = "nova";

    // No identity nodes yet — fallback
    let identityContent = `Your name is "${agentName}".`;
    const emptyNodes = getIdentityNodes(db);
    expect(emptyNodes.length).toBe(0);

    let identityTag = `<your identity>\n${identityContent}\n</your identity>`;
    expect(identityTag).toContain('Your name is "nova".');

    // Now add identity nodes
    const now = Date.now();
    db.run(
      "INSERT INTO memories (content, salience, created_at, last_accessed, access_count) VALUES (?, ?, ?, ?, ?)",
      ["I am nova, an AI with deep ethical commitments.", 0.9, now, now, 0],
    );
    const selfId = (db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id;
    db.run("INSERT OR REPLACE INTO identity_nodes (role, memory_id) VALUES (?, ?)", ["self", selfId]);

    const nodes = getIdentityNodes(db);
    if (nodes.length > 0) {
      identityContent = nodes.map(n => n.content).join("\n");
    }

    identityTag = `<your identity>\n${identityContent}\n</your identity>`;
    expect(identityTag).toContain("deep ethical commitments");
    expect(identityTag).not.toContain('Your name is "nova".');

    db.close();
  });
});

describe("augmentSystemPrompt", () => {
  test("returns orientation string when system is undefined", () => {
    const result = augmentSystemPrompt(undefined, "nova");
    expect(typeof result).toBe("string");
    expect(result as string).toContain("<spotless-orientation>");
    expect(result as string).toContain("</spotless-orientation>");
    expect(result as string).toContain("persistent memory system");
  });

  test("prepends orientation to string system prompt", () => {
    const result = augmentSystemPrompt("You are a helpful assistant.", "nova");
    expect(typeof result).toBe("string");
    const text = result as string;
    expect(text).toContain("<spotless-orientation>");
    expect(text).toContain("You are a helpful assistant.");
    // Orientation should come first
    const orientationIdx = text.indexOf("<spotless-orientation>");
    const originalIdx = text.indexOf("You are a helpful assistant.");
    expect(orientationIdx).toBeLessThan(originalIdx);
  });

  test("prepends orientation block to SystemBlock[] system prompt", () => {
    const blocks = [
      { type: "text" as const, text: "Original system content" },
    ];
    const result = augmentSystemPrompt(blocks, "nova");
    expect(Array.isArray(result)).toBe(true);
    const arr = result as { type: string; text: string }[];
    expect(arr.length).toBe(2);
    expect(arr[0]!.text).toContain("<spotless-orientation>");
    expect(arr[1]!.text).toBe("Original system content");
  });

  test("orientation mentions <your identity> tag", () => {
    const result = augmentSystemPrompt(undefined, "nova") as string;
    expect(result).toContain("<your identity>");
  });

  test("orientation mentions <relevant knowledge> tag", () => {
    const result = augmentSystemPrompt(undefined, "nova") as string;
    expect(result).toContain("<relevant knowledge>");
  });

  test("orientation does NOT contain <memory-architecture> tag", () => {
    const result = augmentSystemPrompt(undefined, "nova") as string;
    expect(result).not.toContain("<memory-architecture>");
  });

  test("orientation does NOT contain <your memories> tag", () => {
    const result = augmentSystemPrompt(undefined, "nova") as string;
    expect(result).not.toContain("<your memories>");
  });
});

describe("estimateSystemTokens", () => {
  test("returns 0 for undefined", () => {
    expect(estimateSystemTokens(undefined)).toBe(0);
  });

  test("estimates string system prompt", () => {
    const text = "You are a helpful assistant."; // 28 chars → 7 tokens
    expect(estimateSystemTokens(text)).toBe(estimateTokens(text));
  });

  test("estimates SystemBlock[] system prompt", () => {
    const blocks = [
      { type: "text" as const, text: "Block one." },
      { type: "text" as const, text: "Block two." },
    ];
    const expected = estimateTokens("Block one.") + estimateTokens("Block two.");
    expect(estimateSystemTokens(blocks)).toBe(expected);
  });
});

describe("estimateToolsTokens", () => {
  test("returns 0 for undefined", () => {
    expect(estimateToolsTokens(undefined)).toBe(0);
  });

  test("returns 0 for empty array", () => {
    expect(estimateToolsTokens([])).toBe(0);
  });

  test("estimates tool definitions", () => {
    const tools = [
      { name: "read_file", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } },
    ];
    const expected = estimateTokens(JSON.stringify(tools));
    expect(estimateToolsTokens(tools)).toBe(expected);
  });
});

describe("computeHistoryBudget", () => {
  const CTX = 120_000; // explicit context budget for deterministic tests

  test("small system/tools → history gets most of the budget", () => {
    // system=1000, tools=2000 → available = 120000 - 1000 - 2000 - 12000 - 1000 = 104000
    const budget = computeHistoryBudget(1000, 2000, CTX);
    expect(budget).toBe(CTX - 1000 - 2000 - computeTier2Budget(CTX) - SUFFIX_OVERHEAD);
    expect(budget).toBe(104000);
  });

  test("large system/tools → history is reduced", () => {
    // system=20000, tools=40000 → available = 120000 - 20000 - 40000 - 12000 - 1000 = 47000
    const budget = computeHistoryBudget(20000, 40000, CTX);
    expect(budget).toBe(47000);
  });

  test("very large system/tools → history hits floor (20K minimum)", () => {
    // system=40000, tools=50000 → available = 120000 - 40000 - 50000 - 12000 - 1000 = 17000 → floor 20000
    const budget = computeHistoryBudget(40000, 50000, CTX);
    expect(budget).toBe(20000);
  });

  test("zero system/tools → maximum history budget", () => {
    const budget = computeHistoryBudget(0, 0, CTX);
    expect(budget).toBe(CTX - computeTier2Budget(CTX) - SUFFIX_OVERHEAD);
    expect(budget).toBe(107000);
  });

  test("default context budget is 500K", () => {
    expect(DEFAULT_CONTEXT_BUDGET).toBe(500_000);
  });

  test("large context budget scales tier2 proportionally", () => {
    // 500K context → tier2 = 10% = 50K
    const budget = computeHistoryBudget(15000, 30000, 500_000);
    const tier2 = computeTier2Budget(500_000);
    expect(tier2).toBe(50_000);
    expect(budget).toBe(500_000 - 15000 - 30000 - 50_000 - SUFFIX_OVERHEAD);
  });
});

describe("computeTier2Budget", () => {
  test("10% of context budget", () => {
    expect(computeTier2Budget(500_000)).toBe(50_000);
  });

  test("floored at 12K", () => {
    expect(computeTier2Budget(50_000)).toBe(12_000);
  });

  test("capped at 60K", () => {
    expect(computeTier2Budget(1_000_000)).toBe(60_000);
  });

  test("TIER2_BUDGET constant equals floor", () => {
    expect(TIER2_BUDGET).toBe(12_000);
  });
});

describe("tier 2 budget", () => {
  test("TIER2_BUDGET is used as reservation in computeHistoryBudget", () => {
    const CTX = 120_000;
    // Budget formula subtracts computeTier2Budget(120K) = 12K
    const withTier2 = computeHistoryBudget(10000, 10000, CTX);
    // 120000 - 10000 - 10000 - 12000 - 1000 = 87000
    expect(withTier2).toBe(87000);
  });
});
