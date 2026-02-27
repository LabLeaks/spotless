/**
 * Integration test: full pass-through + archival pipeline with agent routing.
 *
 * Requires ANTHROPIC_API_KEY in environment. Skips if not set.
 * Sends a real multi-turn conversation through the proxy via /agent/<name>/
 * and verifies raw_events are correctly populated.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { startProxy } from "../src/proxy.ts";
import { openDb } from "../src/db.ts";
import { getAgentDbPath } from "../src/agent.ts";
import { rmSync } from "node:fs";
import { dirname } from "node:path";

const API_KEY = process.env.ANTHROPIC_API_KEY;
const TEST_PORT = 9098;
const TEST_AGENT = "test-integration";

// System prompt that looks like Claude Code's
const SYSTEM_PROMPT = `You are Claude, an AI assistant. You have access to tools.

Primary working directory: /tmp/spotless-integration-test

Contents of CLAUDE.md:
# Test Project`;

describe.skipIf(!API_KEY)("integration: agent-routed pass-through + archival", () => {
  let proxy: ReturnType<typeof startProxy>;
  let agentDbPath: string;

  beforeAll(() => {
    // Clean up any previous test agent DB
    agentDbPath = getAgentDbPath(TEST_AGENT);
    try { rmSync(dirname(agentDbPath), { recursive: true }); } catch {}

    proxy = startProxy({ port: TEST_PORT });
  });

  afterAll(() => {
    proxy?.stop();
    // Clean up test agent DB
    try { rmSync(dirname(agentDbPath), { recursive: true }); } catch {}
  });

  test("simple conversation is proxied and archived via agent URL", async () => {
    // Send through /agent/<name>/v1/messages
    const response = await fetch(`http://localhost:${TEST_PORT}/agent/${TEST_AGENT}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 50,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: "Reply with exactly: SPOTLESS_OK" }],
        stream: true,
      }),
    });

    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    // Read the full SSE stream
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let fullResponse = "";
    let sawDone = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      fullResponse += chunk;
      if (chunk.includes("[DONE]")) sawDone = true;
    }

    expect(sawDone).toBe(true);
    expect(fullResponse).toContain("SPOTLESS_OK");

    // Wait a moment for archival to complete (flush happens on stream end)
    await new Promise((r) => setTimeout(r, 200));

    // Check the database at the agent path
    const db = openDb(agentDbPath);

    // Should have at least: 1 user message + 1 assistant response (possibly with thinking)
    const rows = db.query("SELECT * FROM raw_events ORDER BY id").all() as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThanOrEqual(2);

    // First row should be the user message
    const userRow = rows[0]!;
    expect(userRow.role).toBe("user");
    expect(userRow.content_type).toBe("text");
    expect(userRow.content).toContain("SPOTLESS_OK");

    // Should have an assistant text response somewhere
    const assistantText = rows.find(
      (r) => r.role === "assistant" && r.content_type === "text"
    );
    expect(assistantText).toBeDefined();
    expect(assistantText!.content as string).toContain("SPOTLESS_OK");

    // FTS5 should work
    const ftsHits = db.query(
      "SELECT rowid FROM raw_events_fts WHERE raw_events_fts MATCH 'SPOTLESS_OK'"
    ).all();
    expect(ftsHits.length).toBeGreaterThanOrEqual(1);

    // Message groups should be assigned
    expect(userRow.message_group).toBe(1);
    expect(assistantText!.message_group).toBe(2);

    db.close();
  }, 30000);

  test("bare /v1/messages passes through without archival", async () => {
    // Send WITHOUT /agent/ prefix — should pass through with no archival
    const response = await fetch(`http://localhost:${TEST_PORT}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 50,
        system: "You are a helpful assistant.",
        messages: [{ role: "user", content: "Reply with exactly: BARE_OK" }],
        stream: true,
      }),
    });

    expect(response.ok).toBe(true);

    // Consume the stream
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let fullResponse = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fullResponse += decoder.decode(value);
    }

    expect(fullResponse).toContain("BARE_OK");
  }, 30000);
});
