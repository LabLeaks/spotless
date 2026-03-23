import { test, expect, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb, initSchema } from "../src/db.ts";
import { composeContext, APERTURE_BASELINE, ANCHOR_BUDGET } from "../src/composer.ts";
import { finalizeExchange, storeExchangeLevel, backfillExchanges } from "../src/exchange.ts";
import { createWorkingSet, updateWorkingSetFromBlocks } from "../src/working-set.ts";
import type { CapturedBlock } from "../src/archiver.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

function tempDb(): { db: Database; path: string } {
  const path = join(tmpdir(), `spotless-composer-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = openDb(path);
  initSchema(db);
  return { db, path };
}

function insertEvent(
  db: Database,
  group: number,
  role: string,
  contentType: string,
  content: string,
  isSubagent = 0,
  metadata: Record<string, string> | null = null,
) {
  db.run(
    "INSERT INTO raw_events (timestamp, message_group, role, content_type, content, is_subagent, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [Date.now(), group, role, contentType, content, isSubagent, metadata ? JSON.stringify(metadata) : null],
  );
}

function insertBoundary(db: Database, group: number) {
  db.run(
    "INSERT INTO raw_events (timestamp, message_group, role, content_type, content, is_subagent, metadata, consolidated) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
    [Date.now(), group, "user", "text", "<session-boundary />", 0, null],
  );
}

/**
 * Create a simple exchange: user text + assistant text, then finalize Level 1.
 */
function createExchange(
  db: Database,
  userGroup: number,
  assistantGroup: number,
  userText: string,
  assistantText: string,
  sessionId: number = 0,
) {
  insertEvent(db, userGroup, "user", "text", userText);
  insertEvent(db, assistantGroup, "assistant", "text", assistantText);
  finalizeExchange(db, userGroup, assistantGroup, sessionId);
}

const cleanup: string[] = [];

afterEach(() => {
  for (const p of cleanup) {
    try { unlinkSync(p); } catch {}
    try { unlinkSync(p + "-wal"); } catch {}
    try { unlinkSync(p + "-shm"); } catch {}
  }
  cleanup.length = 0;
});

describe("composeContext fallback", () => {
  test("falls back to buildHistory when no exchange_levels exist", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    // Raw events exist but no exchange_levels
    insertEvent(db, 1, "user", "text", "Hello");
    insertEvent(db, 2, "assistant", "text", "Hi there");

    const ws = createWorkingSet();
    const result = composeContext(db, 100_000, "test", "Hello", ws);

    // Should still return messages (from buildHistory fallback)
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.exchangeCount).toBe(0);
    expect(result.fidelityCoverage.level0).toBe(0);

    db.close();
  });
});

describe("composeContext basic composition", () => {
  test("composes 3 exchanges at Level 0 within budget", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    createExchange(db, 1, 2, "First question", "First answer");
    createExchange(db, 3, 4, "Second question", "Second answer");
    createExchange(db, 5, 6, "Third question", "Third answer");

    const ws = createWorkingSet();
    const result = composeContext(db, 500_000, "test", "anything", ws);

    expect(result.exchangeCount).toBe(3);
    expect(result.messages.length).toBeGreaterThan(0);
    // Small exchanges should all be Level 0
    expect(result.fidelityCoverage.level0).toBe(3);

    db.close();
  });

  test("most recent exchange is always Level 0 (anchor)", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    createExchange(db, 1, 2, "Old question", "Old answer");
    createExchange(db, 3, 4, "Recent question", "Recent answer");

    const ws = createWorkingSet();
    const result = composeContext(db, 500_000, "test", "anything", ws);

    // At minimum the anchor exchange should be Level 0
    expect(result.fidelityCoverage.level0).toBeGreaterThanOrEqual(1);

    // Check messages contain the recent exchange content
    const allText = result.messages.map(m =>
      typeof m.content === "string" ? m.content : ""
    ).join(" ");
    expect(allText).toContain("Recent answer");

    db.close();
  });

  test("includes preamble in output", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    createExchange(db, 1, 2, "Hello", "Hi");

    const ws = createWorkingSet();
    const result = composeContext(db, 500_000, "myagent", "Hello", ws);

    // First message should be the preamble
    expect(result.messages.length).toBeGreaterThanOrEqual(2);
    const firstContent = typeof result.messages[0]!.content === "string"
      ? result.messages[0]!.content : "";
    expect(firstContent).toContain("Spotless Memory System");
    expect(firstContent).toContain("myagent");

    db.close();
  });
});

describe("composeContext budget demotion", () => {
  test("demotes exchanges to Level 1 when budget is tight", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    // Create exchanges with large content — each ~10K tokens at Level 0
    const bigText = "x".repeat(40000); // ~10000 tokens
    for (let i = 0; i < 10; i++) {
      const ug = i * 2 + 1;
      const ag = i * 2 + 2;
      insertEvent(db, ug, "user", "text", `Question ${i}`);
      insertEvent(db, ag, "assistant", "text", bigText);
      finalizeExchange(db, ug, ag, 0);
    }

    const ws = createWorkingSet();
    // Budget that fits anchor (~10K) + a few Level 1s (~few hundred each) but not many Level 0s
    // Anchor takes ~10K at Level 0, remaining budget ~10K
    const result = composeContext(db, 20_000, "test", "anything", ws);

    // Anchor should be Level 0
    expect(result.fidelityCoverage.level0).toBeGreaterThanOrEqual(1);
    // Some exchanges should be demoted to Level 1 to fit budget
    // (or excluded — either way, not all Level 0)
    expect(result.fidelityCoverage.level0).toBeLessThan(10);

    db.close();
  });
});

describe("composeContext FTS5 relevance", () => {
  test("FTS5 hit promotes distant exchange score", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    // Old exchange about caching
    createExchange(db, 1, 2, "How does caching work?", "Cache control handles prompt caching.");
    // Many intervening exchanges
    for (let i = 1; i <= 8; i++) {
      createExchange(db, i * 2 + 1, i * 2 + 2, `Unrelated topic ${i}`, `Response ${i}`);
    }
    // Recent exchange about something else
    createExchange(db, 19, 20, "What about testing?", "Testing is important.");

    const ws = createWorkingSet();
    // Search for "caching" — should boost the old exchange
    const result = composeContext(db, 500_000, "test", "Tell me about caching", ws);

    // The old caching exchange should be included
    const allText = result.messages.map(m =>
      typeof m.content === "string" ? m.content : ""
    ).join(" ");
    expect(allText).toContain("Cache control");

    db.close();
  });
});

describe("composeContext working set", () => {
  test("working set file match boosts exchange score", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const toolId = "toolu_read1";
    // Old exchange that read proxy.ts
    insertEvent(db, 1, "user", "text", "Read the proxy");
    insertEvent(db, 2, "assistant", "tool_use", JSON.stringify({ file_path: "src/proxy.ts" }), 0, { tool_name: "Read", tool_id: toolId });
    insertEvent(db, 3, "user", "tool_result", "proxy file contents...", 0, { tool_use_id: toolId });
    insertEvent(db, 4, "assistant", "text", "The proxy handles requests.");
    finalizeExchange(db, 1, 4, 0);

    // Many intervening exchanges
    for (let i = 1; i <= 5; i++) {
      createExchange(db, i * 2 + 3, i * 2 + 4, `Other ${i}`, `Response ${i}`);
    }

    // Active working set includes proxy.ts
    const ws = createWorkingSet();
    const blocks: CapturedBlock[] = [{
      type: "tool_use",
      content: JSON.stringify({ file_path: "src/proxy.ts" }),
      metadata: { tool_name: "Read", tool_id: "t1" },
    }];
    updateWorkingSetFromBlocks(ws, blocks, 100);

    const result = composeContext(db, 500_000, "test", "anything", ws);

    // The proxy.ts exchange should be included (working set boost)
    const allText = result.messages.map(m =>
      typeof m.content === "string" ? m.content : ""
    ).join(" ");
    expect(allText).toContain("proxy");

    db.close();
  });
});

describe("composeContext session dividers", () => {
  test("inserts session dividers between different sessions", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    createExchange(db, 1, 2, "Session 0 message", "Response 0", 0);
    insertBoundary(db, 3);
    createExchange(db, 4, 5, "Session 1 message", "Response 1", 1);

    const ws = createWorkingSet();
    const result = composeContext(db, 500_000, "test", "anything", ws);

    const allText = result.messages.map(m =>
      typeof m.content === "string" ? m.content : ""
    ).join(" ");
    expect(allText).toContain("--- new session ---");

    db.close();
  });
});

describe("composeContext CompositionResult", () => {
  test("returns valid CompositionResult with metrics", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    createExchange(db, 1, 2, "Hello", "Hi");
    createExchange(db, 3, 4, "Question", "Answer");

    const ws = createWorkingSet();
    const result = composeContext(db, 500_000, "test", "anything", ws);

    expect(result.trimmedCount).toBe(0);
    expect(result.pressure).toBeGreaterThanOrEqual(0);
    expect(result.budgetUsed).toBeGreaterThan(0);
    expect(result.exchangeCount).toBeGreaterThan(0);
    expect(result.fidelityCoverage.level0 + result.fidelityCoverage.level1 +
      result.fidelityCoverage.level2 + result.fidelityCoverage.level3).toBe(result.exchangeCount);

    db.close();
  });

  test("messages array has valid alternation", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    createExchange(db, 1, 2, "Q1", "A1");
    createExchange(db, 3, 4, "Q2", "A2");
    createExchange(db, 5, 6, "Q3", "A3");

    const ws = createWorkingSet();
    const result = composeContext(db, 500_000, "test", "anything", ws);

    // Check alternation: user, assistant, user, assistant, ...
    for (let i = 1; i < result.messages.length; i++) {
      expect(result.messages[i]!.role).not.toBe(result.messages[i - 1]!.role);
    }

    db.close();
  });
});

describe("composeContext Level 2 integration", () => {
  test("composer can use Level 2 data when budget forces demotion", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    // Create exchanges with large content
    const bigText = "x".repeat(40000);
    for (let i = 0; i < 5; i++) {
      const ug = i * 2 + 1;
      const ag = i * 2 + 2;
      insertEvent(db, ug, "user", "text", `Question ${i}`);
      insertEvent(db, ag, "assistant", "text", bigText);
      finalizeExchange(db, ug, ag, 0);
    }

    // Add Level 2 summaries for the first 3 exchanges
    for (let i = 0; i < 3; i++) {
      const ug = i * 2 + 1;
      const ag = i * 2 + 2;
      const content = JSON.stringify([
        { role: "user", content: "[summary]" },
        { role: "assistant", content: `Worked on topic ${i}.` },
      ]);
      storeExchangeLevel(db, ug, ag, 0, 2, content, 20);
    }

    const ws = createWorkingSet();
    // Tight budget — should force demotions
    const result = composeContext(db, 15_000, "test", "anything", ws);

    // Should include exchanges (anchor at L0 + others at L1 or L2)
    expect(result.exchangeCount).toBeGreaterThan(0);
    expect(result.fidelityCoverage.level0).toBeGreaterThanOrEqual(1);

    db.close();
  });
});

describe("composeContext budget floor", () => {
  test("always includes at least 1 exchange at Level 0 even with tiny budget", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    createExchange(db, 1, 2, "Hello", "Hi there, how can I help?");

    const ws = createWorkingSet();
    // Extremely small budget
    const result = composeContext(db, 500, "test", "anything", ws);

    // Anchor guarantee: at least 1 exchange at Level 0
    expect(result.fidelityCoverage.level0).toBeGreaterThanOrEqual(1);
    expect(result.exchangeCount).toBeGreaterThanOrEqual(1);

    db.close();
  });
});

describe("backfillExchanges", () => {
  test("backfills exchanges that don't have Level 1", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    insertEvent(db, 1, "user", "text", "First");
    insertEvent(db, 2, "assistant", "text", "Response 1");
    insertEvent(db, 3, "user", "text", "Second");
    insertEvent(db, 4, "assistant", "text", "Response 2");

    const result = backfillExchanges(db);
    expect(result.processed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.total).toBe(2);

    db.close();
  });

  test("backfill is idempotent", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    insertEvent(db, 1, "user", "text", "Hello");
    insertEvent(db, 2, "assistant", "text", "Hi");

    const result1 = backfillExchanges(db);
    expect(result1.processed).toBe(1);

    const result2 = backfillExchanges(db);
    expect(result2.processed).toBe(0);
    expect(result2.skipped).toBe(1);

    db.close();
  });

  test("backfill with mixed finalized and unfinalized exchanges", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    // Already finalized
    createExchange(db, 1, 2, "Already done", "Response");
    // Not finalized
    insertEvent(db, 3, "user", "text", "New");
    insertEvent(db, 4, "assistant", "text", "Response 2");

    const result = backfillExchanges(db);
    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(1);

    db.close();
  });
});
