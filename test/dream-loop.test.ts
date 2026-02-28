import { test, expect, describe } from "bun:test";
import { createDreamLoop } from "../src/dream-loop.ts";
import type { DreamLoop } from "../src/dream-loop.ts";
import {
  DREAM_INTERVAL_RELAXED,
  DREAM_INTERVAL_NORMAL,
  DREAM_INTERVAL_AGGRESSIVE,
  getIntervalForPressure,
} from "../src/consolidation.ts";

describe("dream loop", () => {
  test("interface has escalate method", () => {
    const loop = createDreamLoop();
    expect(typeof loop.escalate).toBe("function");
  });

  test("interface has triggerNow method", () => {
    const loop = createDreamLoop();
    expect(typeof loop.triggerNow).toBe("function");
  });

  test("stop cancels all pending timeouts", () => {
    const loop = createDreamLoop();
    loop.start(() => ["test-agent"]);
    loop.stop();
    // No error = success (timeouts cleared, no lingering timers)
  });

  test("escalate before start is no-op", () => {
    const loop = createDreamLoop();
    // Should not throw when not running
    loop.escalate("test-agent");
  });

  test("start is idempotent", () => {
    const loop = createDreamLoop();
    loop.start(() => ["test-agent"]);
    loop.start(() => ["test-agent"]); // second call should be no-op
    loop.stop();
  });
});

describe("interval for pressure", () => {
  test("low pressure → relaxed interval (10min)", () => {
    expect(getIntervalForPressure(0)).toBe(DREAM_INTERVAL_RELAXED);
    expect(getIntervalForPressure(0.29)).toBe(DREAM_INTERVAL_RELAXED);
  });

  test("moderate-low pressure → normal interval (3min)", () => {
    expect(getIntervalForPressure(0.3)).toBe(DREAM_INTERVAL_NORMAL);
    expect(getIntervalForPressure(0.59)).toBe(DREAM_INTERVAL_NORMAL);
  });

  test("moderate-high pressure → aggressive interval (1min)", () => {
    expect(getIntervalForPressure(0.6)).toBe(DREAM_INTERVAL_AGGRESSIVE);
    expect(getIntervalForPressure(0.84)).toBe(DREAM_INTERVAL_AGGRESSIVE);
  });

  test("high pressure → immediate (0)", () => {
    expect(getIntervalForPressure(0.85)).toBe(0);
    expect(getIntervalForPressure(1.0)).toBe(0);
  });
});

describe("no setInterval", () => {
  test("dream-loop.ts source does not call setInterval", async () => {
    const source = await Bun.file("src/dream-loop.ts").text();
    // Remove comments before checking — setInterval may appear in doc comments
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
    expect(withoutComments).not.toContain("setInterval");
  });
});
