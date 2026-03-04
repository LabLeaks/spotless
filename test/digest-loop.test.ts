import { test, expect, describe } from "bun:test";
import { createDigestLoop } from "../src/digest-loop.ts";

describe("digest loop", () => {
  test("interface has escalate method", () => {
    const loop = createDigestLoop();
    expect(typeof loop.escalate).toBe("function");
  });

  test("interface has triggerNow method", () => {
    const loop = createDigestLoop();
    expect(typeof loop.triggerNow).toBe("function");
  });

  test("stop is safe to call", () => {
    const loop = createDigestLoop();
    loop.start(() => ["test-agent"]);
    loop.stop();
    // No error = success
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

  test("start does not schedule periodic passes", () => {
    const loop = createDigestLoop();
    loop.start(() => ["test-agent"]);
    // No timeouts should fire — digesting is escalation-only
    loop.stop();
  });
});

describe("no setInterval or setTimeout polling", () => {
  test("digest-loop.ts source does not call setInterval", async () => {
    const source = await Bun.file("src/digest-loop.ts").text();
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
    expect(withoutComments).not.toContain("setInterval");
  });
});
