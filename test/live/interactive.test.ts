/**
 * Live interactive-mode tests.
 *
 * These run real Claude Code in interactive mode inside tmux sessions.
 * Full Playwright-for-terminals: type, wait, capture, assert.
 *
 * Requires: Claude Code installed, authenticated, tmux available.
 */

import { test, expect, describe, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { createLiveSession, cleanupAll, detectState } from "./harness.ts";
import type { LiveSession } from "./harness.ts";

const PORT = 9998;

// Skip live tests if claude CLI or tmux is not available (e.g. CI)
const hasClaude = spawnSync("which", ["claude"], { encoding: "utf-8" }).status === 0;
const hasTmux = spawnSync("which", ["tmux"], { encoding: "utf-8" }).status === 0;
const describeLive = (hasClaude && hasTmux) ? describe : describe.skip;

afterAll(() => {
  if (hasClaude) cleanupAll();
});

describeLive("interactive mode", () => {
  test("start session, send message, get response", async () => {
    const session = await createLiveSession({
      agent: `e2e-interactive-${Date.now()}`,
      port: PORT,
      claudeArgs: ["--dangerously-skip-permissions"],
    });

    try {
      // Should start in idle state
      expect(session.state()).toBe("idle");

      // Send a message
      session.type("Reply with exactly the word 'COCONUT' and nothing else.");
      session.submit();

      // Wait for response
      await session.waitForIdle(60_000);

      // Capture and verify
      const output = session.capture();
      expect(output).toContain("COCONUT");

      // Verify archival
      const db = session.db();
      try {
        const events = db.query("SELECT COUNT(*) as count FROM raw_events WHERE is_subagent = 0").get() as { count: number };
        expect(events.count).toBeGreaterThan(0);
      } finally {
        db.close();
      }
    } finally {
      session.cleanup();
    }
  }, 90_000);

  test("multi-turn conversation maintains context", async () => {
    const session = await createLiveSession({
      agent: `e2e-multiturn-${Date.now()}`,
      port: PORT,
      claudeArgs: ["--dangerously-skip-permissions"],
    });

    try {
      // Turn 1: establish a fact
      session.type("I'm going to tell you a secret word. The word is STARFISH. Just say 'got it'.");
      session.submit();
      await session.waitForIdle(60_000);

      // Turn 2: verify it remembers within the session
      session.type("What was the secret word I just told you?");
      session.submit();
      await session.waitForIdle(60_000);

      const output = session.capture();
      expect(output).toContain("STARFISH");
    } finally {
      session.cleanup();
    }
  }, 120_000);

  test("session state detection works correctly", async () => {
    const session = await createLiveSession({
      agent: `e2e-state-${Date.now()}`,
      port: PORT,
      claudeArgs: ["--dangerously-skip-permissions"],
    });

    try {
      // Should be idle after startup
      expect(session.state()).toBe("idle");

      // Send a message that will take a moment to process
      session.type("Write a haiku about the ocean.");
      session.submit();

      // Should transition to working (might be fast, so allow for immediate idle too)
      let sawWorking = false;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const state = session.state();
        if (state === "working") {
          sawWorking = true;
          break;
        }
        if (state === "idle") {
          // Response was very fast — still valid
          break;
        }
        await new Promise(r => setTimeout(r, 100));
      }

      // Wait for idle
      await session.waitForIdle(60_000);
      expect(session.state()).toBe("idle");
    } finally {
      session.cleanup();
    }
  }, 90_000);

  // Escape behavior is Claude Code TUI-specific — not testing it here.

  test("exit command terminates session gracefully", async () => {
    const session = await createLiveSession({
      agent: `e2e-exit-${Date.now()}`,
      port: PORT,
      claudeArgs: ["--dangerously-skip-permissions"],
    });

    try {
      // Send exit command
      session.type("/exit");
      session.submit();

      // Should exit
      await session.waitForExit(15_000);
    } finally {
      session.cleanup();
    }
  }, 30_000);
});

describe("detectState", () => {
  // Unit tests for the state detection function (no tmux needed)
  test("detects idle from prompt character", () => {
    expect(detectState("Some output\n\n❯ ")).toBe("idle");
    expect(detectState("Hello\n\n> ")).toBe("idle");
  });

  test("detects working from interrupt message", () => {
    expect(detectState("Thinking...\nPress ctrl+c to interrupt")).toBe("working");
    expect(detectState("output\nesc to cancel")).toBe("working");
  });

  test("detects permission prompts", () => {
    expect(detectState("Run this command? [y/n]")).toBe("permission");
    expect(detectState("Allow this action?")).toBe("permission");
  });

  test("returns unknown for ambiguous content", () => {
    expect(detectState("just some random text")).toBe("unknown");
  });
});
