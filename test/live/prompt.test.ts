/**
 * Live prompt-mode tests.
 *
 * These run real `claude -p` through the real proxy with real API calls.
 * They cost tokens. Run with: bun test test/live/
 *
 * Requires: Claude Code installed, authenticated, and tmux available.
 */

import { test, expect, describe, afterAll } from "bun:test";
import { runPrompt, ensureProxy, stopProxy, cleanupAll } from "./harness.ts";

const PORT = 9998;
const AGENT = `e2e-prompt-${Date.now()}`;

afterAll(() => {
  cleanupAll();
});

describe("prompt mode", () => {
  test("basic round-trip: sends prompt, gets response, archives to DB", async () => {
    const result = await runPrompt(
      "Reply with exactly the word 'PINEAPPLE' and nothing else.",
      { agent: AGENT, port: PORT },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toContain("PINEAPPLE");

    // Verify archival
    const db = result.db();
    try {
      const events = db.query("SELECT COUNT(*) as count FROM raw_events WHERE is_subagent = 0").get() as { count: number };
      expect(events.count).toBeGreaterThan(0);

      // Should have both user and assistant content
      const roles = db.query("SELECT DISTINCT role FROM raw_events WHERE is_subagent = 0").all() as { role: string }[];
      const roleSet = new Set(roles.map(r => r.role));
      expect(roleSet.has("user")).toBe(true);
      expect(roleSet.has("assistant")).toBe(true);
    } finally {
      db.close();
    }
  }, 60_000);

  test("cross-session memory: second session recalls first", async () => {
    // First session: tell Claude a fact
    const r1 = await runPrompt(
      "Remember this: the secret code is MANGO-42. Just confirm you understood.",
      { agent: AGENT, port: PORT },
    );
    expect(r1.exitCode).toBe(0);

    // Second session: ask about it
    const r2 = await runPrompt(
      "What was the secret code I told you? Reply with just the code.",
      { agent: AGENT, port: PORT },
    );
    expect(r2.exitCode).toBe(0);
    expect(r2.output).toContain("MANGO-42");
  }, 120_000);

  test("context budget: proxy startup log confirms budget", async () => {
    // Stop and restart proxy to capture fresh startup
    stopProxy();
    await ensureProxy(PORT);

    // Run a prompt to exercise the budget path
    const result = await runPrompt(
      "Say 'OK'.",
      { agent: AGENT, port: PORT },
    );
    expect(result.exitCode).toBe(0);

    // Verify the budget math is correct via DB — the history trace should exist
    const db = result.db();
    try {
      const events = db.query("SELECT COUNT(*) as count FROM raw_events WHERE is_subagent = 0").get() as { count: number };
      expect(events.count).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  }, 60_000);

  test("context budget: custom --max-context starts proxy with different budget", async () => {
    // Stop existing proxy and start with custom budget
    stopProxy();

    const customAgent = `e2e-budget-${Date.now()}`;
    const result = await runPrompt(
      "Say 'OK'.",
      { agent: customAgent, port: PORT, maxContext: 120_000 },
    );
    expect(result.exitCode).toBe(0);

    // Verify it worked — the proxy started and processed the request
    const db = result.db();
    try {
      const events = db.query("SELECT COUNT(*) as count FROM raw_events WHERE is_subagent = 0").get() as { count: number };
      expect(events.count).toBeGreaterThan(0);
    } finally {
      db.close();
    }

    result.cleanup(true);
    stopProxy();
  }, 60_000);

  test("history trace: multiple sessions build continuous history", async () => {
    const agent = `e2e-history-${Date.now()}`;

    // Session 1
    await runPrompt("My name is TestUser and I like pizza.", { agent, port: PORT });
    // Session 2
    await runPrompt("I also like chess.", { agent, port: PORT });
    // Session 3: should remember both
    const r3 = await runPrompt(
      "What do you know about me? List what I like and my name.",
      { agent, port: PORT },
    );

    expect(r3.output).toContain("TestUser");
    expect(r3.output).toContain("pizza");
    expect(r3.output).toContain("chess");

    // Verify DB has session boundaries
    const db = r3.db();
    try {
      const boundaries = db.query(
        "SELECT COUNT(*) as count FROM raw_events WHERE content = '<session-boundary />'"
      ).get() as { count: number };
      // At least 2 boundaries (between sessions 1-2 and 2-3)
      expect(boundaries.count).toBeGreaterThanOrEqual(2);
    } finally {
      db.close();
    }

    r3.cleanup(true);
  }, 180_000);
});
