import { test, expect, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb, initSchema } from "../src/db.ts";
import {
  getPressureLevel,
  getIntervalForPressure,
  buildPressureSignal,
  getWatermark,
  getConsolidationPressure,
  getConsolidationStatus,
  PRESSURE_MODERATE,
  PRESSURE_HIGH,
  DIGEST_INTERVAL_RELAXED,
  DIGEST_INTERVAL_NORMAL,
  DIGEST_INTERVAL_AGGRESSIVE,
} from "../src/consolidation.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

function tempDb(): { db: Database; path: string } {
  const path = join(tmpdir(), `spotless-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = openDb(path);
  initSchema(db);
  return { db, path };
}

describe("pressure level", () => {
  test("returns 'none' for pressure < 0.6", () => {
    expect(getPressureLevel(0)).toBe("none");
    expect(getPressureLevel(0.3)).toBe("none");
    expect(getPressureLevel(0.59)).toBe("none");
  });

  test("returns 'moderate' for pressure 0.6-0.85", () => {
    expect(getPressureLevel(0.6)).toBe("moderate");
    expect(getPressureLevel(0.7)).toBe("moderate");
    expect(getPressureLevel(0.84)).toBe("moderate");
  });

  test("returns 'high' for pressure >= 0.85", () => {
    expect(getPressureLevel(0.85)).toBe("high");
    expect(getPressureLevel(0.95)).toBe("high");
    expect(getPressureLevel(1.2)).toBe("high");
  });
});

describe("interval for pressure", () => {
  test("returns relaxed for low pressure", () => {
    expect(getIntervalForPressure(0)).toBe(DIGEST_INTERVAL_RELAXED);
    expect(getIntervalForPressure(0.1)).toBe(DIGEST_INTERVAL_RELAXED);
    expect(getIntervalForPressure(0.29)).toBe(DIGEST_INTERVAL_RELAXED);
  });

  test("returns normal for moderate-low pressure", () => {
    expect(getIntervalForPressure(0.3)).toBe(DIGEST_INTERVAL_NORMAL);
    expect(getIntervalForPressure(0.5)).toBe(DIGEST_INTERVAL_NORMAL);
    expect(getIntervalForPressure(0.59)).toBe(DIGEST_INTERVAL_NORMAL);
  });

  test("returns aggressive for moderate-high pressure", () => {
    expect(getIntervalForPressure(0.6)).toBe(DIGEST_INTERVAL_AGGRESSIVE);
    expect(getIntervalForPressure(0.7)).toBe(DIGEST_INTERVAL_AGGRESSIVE);
    expect(getIntervalForPressure(0.84)).toBe(DIGEST_INTERVAL_AGGRESSIVE);
  });

  test("returns 0 (immediate) for high pressure", () => {
    expect(getIntervalForPressure(0.85)).toBe(0);
    expect(getIntervalForPressure(1.0)).toBe(0);
  });
});

describe("pressure signal", () => {
  test("returns empty string for low pressure", () => {
    expect(buildPressureSignal(0.3, 40000)).toBe("");
    expect(buildPressureSignal(0.59, 80000)).toBe("");
  });

  test("returns moderate signal for moderate pressure", () => {
    const signal = buildPressureSignal(0.7, 100000);
    expect(signal).toContain('<memory-pressure level="moderate">');
    expect(signal).toContain("100k tokens");
    expect(signal).toContain("</memory-pressure>");
  });

  test("returns high signal for high pressure", () => {
    const signal = buildPressureSignal(0.9, 130000);
    expect(signal).toContain('<memory-pressure level="high">');
    expect(signal).toContain("130k tokens");
    expect(signal).toContain("slow down");
    expect(signal).toContain("</memory-pressure>");
  });

  test("signal token count rounds to nearest k", () => {
    const signal = buildPressureSignal(0.7, 85500);
    expect(signal).toContain("86k tokens");
  });
});

describe("watermark", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const p of cleanup) {
      try { unlinkSync(p); } catch {}
      try { unlinkSync(p + "-wal"); } catch {}
      try { unlinkSync(p + "-shm"); } catch {}
    }
    cleanup.length = 0;
  });

  test("returns null when no events consolidated", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    db.run(
      "INSERT INTO raw_events (timestamp, message_group, role, content_type, content) VALUES (?, ?, ?, ?, ?)",
      [Date.now(), 1, "user", "text", "hello"]
    );

    expect(getWatermark(db)).toBeNull();
    db.close();
  });

  test("returns null on empty db", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    expect(getWatermark(db)).toBeNull();
    db.close();
  });

  test("returns correct group when some consolidated", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const now = Date.now();
    db.run(
      "INSERT INTO raw_events (timestamp, message_group, role, content_type, content, consolidated) VALUES (?, ?, ?, ?, ?, 1)",
      [now, 5, "user", "text", "consolidated event"]
    );
    db.run(
      "INSERT INTO raw_events (timestamp, message_group, role, content_type, content, consolidated) VALUES (?, ?, ?, ?, ?, 1)",
      [now, 10, "user", "text", "also consolidated"]
    );
    db.run(
      "INSERT INTO raw_events (timestamp, message_group, role, content_type, content) VALUES (?, ?, ?, ?, ?)",
      [now, 15, "user", "text", "not consolidated"]
    );

    expect(getWatermark(db)).toBe(10);
    db.close();
  });

  test("ignores subagent events", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const now = Date.now();
    db.run(
      "INSERT INTO raw_events (timestamp, message_group, role, content_type, content, consolidated, is_subagent) VALUES (?, ?, ?, ?, ?, 1, 1)",
      [now, 100, "user", "text", "subagent consolidated"]
    );
    db.run(
      "INSERT INTO raw_events (timestamp, message_group, role, content_type, content, consolidated) VALUES (?, ?, ?, ?, ?, 1)",
      [now, 5, "user", "text", "main consolidated"]
    );

    expect(getWatermark(db)).toBe(5);
    db.close();
  });
});

describe("consolidation pressure", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const p of cleanup) {
      try { unlinkSync(p); } catch {}
      try { unlinkSync(p + "-wal"); } catch {}
      try { unlinkSync(p + "-shm"); } catch {}
    }
    cleanup.length = 0;
  });

  test("pressure is 0 when everything consolidated", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    db.run(
      "INSERT INTO raw_events (timestamp, message_group, role, content_type, content, consolidated) VALUES (?, ?, ?, ?, ?, 1)",
      [Date.now(), 1, "user", "text", "all consolidated"]
    );

    const { pressure, unconsolidatedTokens } = getConsolidationPressure(db);
    expect(pressure).toBe(0);
    expect(unconsolidatedTokens).toBe(0);
    db.close();
  });

  test("pressure is 0 on empty db", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const { pressure } = getConsolidationPressure(db);
    expect(pressure).toBe(0);
    db.close();
  });

  test("pressure > 0 when unconsolidated events exist", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    db.run(
      "INSERT INTO raw_events (timestamp, message_group, role, content_type, content) VALUES (?, ?, ?, ?, ?)",
      [Date.now(), 1, "user", "text", "unconsolidated content here"]
    );

    const { pressure, unconsolidatedTokens } = getConsolidationPressure(db);
    expect(pressure).toBeGreaterThan(0);
    expect(unconsolidatedTokens).toBeGreaterThan(0);
    db.close();
  });

  test("uses float division (not integer truncation)", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    // Insert content with exactly 11 chars → 11/4.0 = 2.75 tokens
    db.run(
      "INSERT INTO raw_events (timestamp, message_group, role, content_type, content) VALUES (?, ?, ?, ?, ?)",
      [Date.now(), 1, "user", "text", "hello world"]  // 11 chars
    );

    const { unconsolidatedTokens } = getConsolidationPressure(db);
    // Float division: 11/4.0 = 2.75, NOT integer division 11/4 = 2
    expect(unconsolidatedTokens).toBe(2.75);
    db.close();
  });

  test("excludes thinking blocks", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    db.run(
      "INSERT INTO raw_events (timestamp, message_group, role, content_type, content) VALUES (?, ?, ?, ?, ?)",
      [Date.now(), 1, "user", "text", "visible"]
    );
    db.run(
      "INSERT INTO raw_events (timestamp, message_group, role, content_type, content) VALUES (?, ?, ?, ?, ?)",
      [Date.now(), 1, "assistant", "thinking", "a]very long thinking block that should not count"]
    );

    const { unconsolidatedTokens } = getConsolidationPressure(db);
    // Only "visible" (7 chars → 1.75 tokens) should count
    expect(unconsolidatedTokens).toBe(1.75);
    db.close();
  });

  test("excludes subagent events", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    db.run(
      "INSERT INTO raw_events (timestamp, message_group, role, content_type, content) VALUES (?, ?, ?, ?, ?)",
      [Date.now(), 1, "user", "text", "main"]
    );
    db.run(
      "INSERT INTO raw_events (timestamp, message_group, role, content_type, content, is_subagent) VALUES (?, ?, ?, ?, ?, 1)",
      [Date.now(), 2, "user", "text", "subagent content should not count"]
    );

    const { unconsolidatedTokens } = getConsolidationPressure(db);
    // Only "main" (4 chars → 1.0 token) should count
    expect(unconsolidatedTokens).toBe(1.0);
    db.close();
  });

  test("pressure updates after marking events consolidated", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    db.run(
      "INSERT INTO raw_events (timestamp, message_group, role, content_type, content) VALUES (?, ?, ?, ?, ?)",
      [Date.now(), 1, "user", "text", "some content"]
    );

    const before = getConsolidationPressure(db);
    expect(before.pressure).toBeGreaterThan(0);

    db.run("UPDATE raw_events SET consolidated = 1");

    const after = getConsolidationPressure(db);
    expect(after.pressure).toBe(0);
    expect(after.unconsolidatedTokens).toBe(0);
    db.close();
  });

  test("excludes session boundaries from pressure", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    db.run(
      "INSERT INTO raw_events (timestamp, message_group, role, content_type, content) VALUES (?, ?, ?, ?, ?)",
      [Date.now(), 1, "user", "text", "real content"]
    );
    db.run(
      "INSERT INTO raw_events (timestamp, message_group, role, content_type, content) VALUES (?, ?, ?, ?, ?)",
      [Date.now(), 2, "user", "text", "<session-boundary />"]
    );

    const { unconsolidatedTokens } = getConsolidationPressure(db);
    // Only "real content" (12 chars → 3.0 tokens) should count
    expect(unconsolidatedTokens).toBe(3.0);
    db.close();
  });

  test("excludes system reminders from pressure", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    db.run(
      "INSERT INTO raw_events (timestamp, message_group, role, content_type, content) VALUES (?, ?, ?, ?, ?)",
      [Date.now(), 1, "user", "text", "real content"]
    );
    db.run(
      "INSERT INTO raw_events (timestamp, message_group, role, content_type, content) VALUES (?, ?, ?, ?, ?)",
      [Date.now(), 2, "user", "text", "<system-reminder>some internal CC metadata that should not count</system-reminder>"]
    );

    const { unconsolidatedTokens } = getConsolidationPressure(db);
    // Only "real content" (12 chars → 3.0 tokens) should count
    expect(unconsolidatedTokens).toBe(3.0);
    db.close();
  });

  test("queries use idx_raw_consolidated index", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const plan = db.query(
      "EXPLAIN QUERY PLAN SELECT SUM(LENGTH(content)) / 4.0 FROM raw_events WHERE consolidated = 0 AND is_subagent = 0 AND content_type != 'thinking'"
    ).all() as { detail: string }[];

    const usesIndex = plan.some(row => row.detail.includes("idx_raw_consolidated"));
    expect(usesIndex).toBe(true);
    db.close();
  });
});

describe("consolidation status", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const p of cleanup) {
      try { unlinkSync(p); } catch {}
      try { unlinkSync(p + "-wal"); } catch {}
      try { unlinkSync(p + "-shm"); } catch {}
    }
    cleanup.length = 0;
  });

  test("returns full status with all fields", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const now = Date.now();
    db.run(
      "INSERT INTO raw_events (timestamp, message_group, role, content_type, content, consolidated) VALUES (?, ?, ?, ?, ?, 1)",
      [now, 1, "user", "text", "consolidated"]
    );
    db.run(
      "INSERT INTO raw_events (timestamp, message_group, role, content_type, content) VALUES (?, ?, ?, ?, ?)",
      [now, 2, "user", "text", "not consolidated"]
    );

    const status = getConsolidationStatus(db);
    expect(status.watermark).toBe(1);
    expect(status.pressure).toBeGreaterThan(0);
    expect(status.unconsolidatedTokens).toBeGreaterThan(0);
    expect(status.totalGroups).toBe(2);
    expect(status.consolidatedGroups).toBe(1);
    db.close();
  });
});

describe("post-pass marking integration", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const p of cleanup) {
      try { unlinkSync(p); } catch {}
      try { unlinkSync(p + "-wal"); } catch {}
      try { unlinkSync(p + "-shm"); } catch {}
    }
    cleanup.length = 0;
  });

  test("marking groups updates consolidated flag and drops pressure", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const now = Date.now();
    // Insert events across 3 groups
    for (let g = 1; g <= 3; g++) {
      db.run(
        "INSERT INTO raw_events (timestamp, message_group, role, content_type, content) VALUES (?, ?, ?, ?, ?)",
        [now + g, g, "user", "text", "content for group " + g],
      );
    }

    // All unconsolidated initially
    const before = getConsolidationPressure(db);
    expect(before.pressure).toBeGreaterThan(0);
    expect(before.unconsolidatedTokens).toBeGreaterThan(0);

    // Simulate digester marking groups 1 and 2 as consolidated
    const groupIds = [1, 2];
    const placeholders = groupIds.map(() => "?").join(",");
    db.run(
      `UPDATE raw_events SET consolidated = 1 WHERE message_group IN (${placeholders}) AND is_subagent = 0`,
      groupIds,
    );

    // Pressure should drop (only group 3 remains unconsolidated)
    const after = getConsolidationPressure(db);
    expect(after.pressure).toBeLessThan(before.pressure);
    expect(after.unconsolidatedTokens).toBeLessThan(before.unconsolidatedTokens);

    // Watermark should advance to group 2
    expect(getWatermark(db)).toBe(2);

    // queryRawEvents with unconsolidatedOnly should only return group 3
    const { queryRawEvents } = require("../src/digest-tools.ts");
    const groups = queryRawEvents(db, { unconsolidatedOnly: true });
    expect(groups.length).toBe(1);
    expect(groups[0].message_group).toBe(3);

    db.close();
  });

  test("marking all groups brings pressure to zero", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const now = Date.now();
    db.run(
      "INSERT INTO raw_events (timestamp, message_group, role, content_type, content) VALUES (?, ?, ?, ?, ?)",
      [now, 1, "user", "text", "some content"],
    );

    const before = getConsolidationPressure(db);
    expect(before.pressure).toBeGreaterThan(0);

    db.run("UPDATE raw_events SET consolidated = 1");

    const after = getConsolidationPressure(db);
    expect(after.pressure).toBe(0);
    expect(after.unconsolidatedTokens).toBe(0);

    db.close();
  });
});
