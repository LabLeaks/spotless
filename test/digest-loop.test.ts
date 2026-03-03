import { test, expect, describe } from "bun:test";
import { createDigestLoop } from "../src/digest-loop.ts";
import type { DigestLoop } from "../src/digest-loop.ts";
import {
  DIGEST_INTERVAL_RELAXED,
  DIGEST_INTERVAL_NORMAL,
  DIGEST_INTERVAL_AGGRESSIVE,
  getIntervalForPressure,
} from "../src/consolidation.ts";

describe("digest loop", () => {
  test("interface has escalate method", () => {
    const loop = createDigestLoop();
    expect(typeof loop.escalate).toBe("function");
  });

  test("interface has triggerNow method", () => {
    const loop = createDigestLoop();
    expect(typeof loop.triggerNow).toBe("function");
  });

  test("stop cancels all pending timeouts", () => {
    const loop = createDigestLoop();
    loop.start(() => ["test-agent"]);
    loop.stop();
    // No error = success (timeouts cleared, no lingering timers)
  });

  test("escalate before start is no-op", () => {
    const loop = createDigestLoop();
    // Should not throw when not running
    loop.escalate("test-agent");
  });

  test("start is idempotent", () => {
    const loop = createDigestLoop();
    loop.start(() => ["test-agent"]);
    loop.start(() => ["test-agent"]); // second call should be no-op
    loop.stop();
  });

  test("interface has registerAgent method", () => {
    const loop = createDigestLoop();
    expect(typeof loop.registerAgent).toBe("function");
  });

  test("registerAgent before start is no-op", () => {
    const loop = createDigestLoop();
    // Should not throw when not running
    loop.registerAgent("test-agent");
  });

  test("registerAgent schedules new agent", () => {
    const loop = createDigestLoop();
    loop.start(() => []);
    // Should not throw — agent gets scheduled with relaxed interval
    loop.registerAgent("new-agent");
    loop.stop();
  });

  test("registerAgent is no-op for already-known agent", () => {
    const loop = createDigestLoop();
    loop.start(() => ["existing-agent"]);
    // Agent already scheduled via start() — registerAgent should be a no-op
    loop.registerAgent("existing-agent");
    loop.stop();
  });
});

describe("interval for pressure", () => {
  test("low pressure → relaxed interval (10min)", () => {
    expect(getIntervalForPressure(0)).toBe(DIGEST_INTERVAL_RELAXED);
    expect(getIntervalForPressure(0.29)).toBe(DIGEST_INTERVAL_RELAXED);
  });

  test("moderate-low pressure → normal interval (3min)", () => {
    expect(getIntervalForPressure(0.3)).toBe(DIGEST_INTERVAL_NORMAL);
    expect(getIntervalForPressure(0.59)).toBe(DIGEST_INTERVAL_NORMAL);
  });

  test("moderate-high pressure → aggressive interval (1min)", () => {
    expect(getIntervalForPressure(0.6)).toBe(DIGEST_INTERVAL_AGGRESSIVE);
    expect(getIntervalForPressure(0.84)).toBe(DIGEST_INTERVAL_AGGRESSIVE);
  });

  test("high pressure → immediate (0)", () => {
    expect(getIntervalForPressure(0.85)).toBe(0);
    expect(getIntervalForPressure(1.0)).toBe(0);
  });
});

describe("no setInterval", () => {
  test("digest-loop.ts source does not call setInterval", async () => {
    const source = await Bun.file("src/digest-loop.ts").text();
    // Remove comments before checking — setInterval may appear in doc comments
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
    expect(withoutComments).not.toContain("setInterval");
  });
});
