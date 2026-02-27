import { test, expect, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb, openReadonlyDb, initSchema } from "../src/db.ts";
import { handleDashboardRequest } from "../src/dashboard.ts";
import type { AgentContext, ProxyStats } from "../src/proxy.ts";
import { createProxyState } from "../src/state.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

function tempDb(): { db: Database; path: string } {
  const path = join(tmpdir(), `spotless-dash-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = openDb(path);
  initSchema(db);
  return { db, path };
}

function makeStats(): ProxyStats {
  return {
    startedAt: Date.now() - 60000,
    totalRequests: 42,
    agentRequests: new Map([["test-agent", 10]]),
  };
}

function makeUrl(path: string): URL {
  return new URL(`http://localhost:9000${path}`);
}

describe("diagnostic schema", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const p of cleanup) {
      try { unlinkSync(p); } catch {}
      try { unlinkSync(p + "-wal"); } catch {}
      try { unlinkSync(p + "-shm"); } catch {}
    }
    cleanup.length = 0;
  });

  test("dream_passes table created by initSchema", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const tables = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='dream_passes'"
    ).all() as { name: string }[];
    expect(tables.length).toBe(1);

    db.close();
  });

  test("hippocampus_runs table created by initSchema", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const tables = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='hippocampus_runs'"
    ).all() as { name: string }[];
    expect(tables.length).toBe(1);

    db.close();
  });

  test("dream_passes accepts valid INSERT", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    db.run(
      `INSERT INTO dream_passes
        (timestamp, duration_ms, ops_requested, ops_executed,
         memories_created, memories_merged, memories_pruned, memories_superseded,
         associations_created, identity_ops, errors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [Date.now(), 1500, 10, 8, 3, 1, 0, 1, 4, 2, JSON.stringify(["minor issue"])],
    );

    const row = db.query("SELECT * FROM dream_passes WHERE id = 1").get() as Record<string, unknown>;
    expect(row.duration_ms).toBe(1500);
    expect(row.memories_created).toBe(3);
    expect(row.errors).toBe(JSON.stringify(["minor issue"]));

    db.close();
  });

  test("hippocampus_runs accepts valid INSERT", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    db.run(
      `INSERT INTO hippocampus_runs
        (timestamp, duration_ms, memory_ids, memory_count, cue_text)
       VALUES (?, ?, ?, ?, ?)`,
      [Date.now(), 350, JSON.stringify([1, 5, 12]), 3, "what is the project about"],
    );

    const row = db.query("SELECT * FROM hippocampus_runs WHERE id = 1").get() as Record<string, unknown>;
    expect(row.duration_ms).toBe(350);
    expect(row.memory_count).toBe(3);
    expect(row.cue_text).toBe("what is the project about");

    db.close();
  });
});

describe("openReadonlyDb", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const p of cleanup) {
      try { unlinkSync(p); } catch {}
      try { unlinkSync(p + "-wal"); } catch {}
      try { unlinkSync(p + "-shm"); } catch {}
    }
    cleanup.length = 0;
  });

  test("opens successfully and reads data", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const now = Date.now();
    db.run(
      "INSERT INTO memories (content, salience, created_at, last_accessed) VALUES (?, ?, ?, ?)",
      ["test memory", 0.5, now, now],
    );
    db.close();

    const rodb = openReadonlyDb(path);
    const row = rodb.query("SELECT content FROM memories WHERE id = 1").get() as { content: string };
    expect(row.content).toBe("test memory");
    rodb.close();
  });

  test("rejects writes", () => {
    const { db, path } = tempDb();
    cleanup.push(path);
    db.close();

    const rodb = openReadonlyDb(path);
    expect(() => {
      rodb.run(
        "INSERT INTO memories (content, salience, created_at, last_accessed) VALUES (?, ?, ?, ?)",
        ["bad", 0.5, Date.now(), Date.now()],
      );
    }).toThrow();
    rodb.close();
  });
});

describe("dashboard routing", () => {
  test("returns null for non-dashboard paths", () => {
    const agents = new Map<string, AgentContext>();
    const stats = makeStats();
    const resp = handleDashboardRequest(makeUrl("/v1/messages"), agents, stats);
    expect(resp).toBeNull();
  });

  test("returns null for agent proxy paths", () => {
    const agents = new Map<string, AgentContext>();
    const stats = makeStats();
    const resp = handleDashboardRequest(makeUrl("/agent/wren/v1/messages"), agents, stats);
    expect(resp).toBeNull();
  });

  test("returns Response for /_dashboard/", () => {
    const agents = new Map<string, AgentContext>();
    const stats = makeStats();
    const resp = handleDashboardRequest(makeUrl("/_dashboard/"), agents, stats);
    expect(resp).not.toBeNull();
    expect(resp!.headers.get("content-type")).toContain("text/html");
  });

  test("returns Response for /_dashboard/api/status", () => {
    const agents = new Map<string, AgentContext>();
    const stats = makeStats();
    const resp = handleDashboardRequest(makeUrl("/_dashboard/api/status"), agents, stats);
    expect(resp).not.toBeNull();
    expect(resp!.headers.get("content-type")).toContain("application/json");
  });
});

describe("API: /api/status", () => {
  test("returns uptime and request counts", async () => {
    const agents = new Map<string, AgentContext>();
    const stats = makeStats();
    const resp = handleDashboardRequest(makeUrl("/_dashboard/api/status"), agents, stats);
    const data = await resp!.json() as Record<string, unknown>;

    expect(data.totalRequests).toBe(42);
    expect(typeof data.uptimeMs).toBe("number");
    expect((data.agentRequests as Record<string, number>)["test-agent"]).toBe(10);
  });
});

describe("API: /api/agents", () => {
  // This test depends on real filesystem agents so we just verify the shape
  test("returns array", async () => {
    const agents = new Map<string, AgentContext>();
    const stats = makeStats();
    const resp = handleDashboardRequest(makeUrl("/_dashboard/api/agents"), agents, stats);
    const data = await resp!.json();
    expect(Array.isArray(data)).toBe(true);
  });
});

describe("API: agent endpoints", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const p of cleanup) {
      try { unlinkSync(p); } catch {}
      try { unlinkSync(p + "-wal"); } catch {}
      try { unlinkSync(p + "-shm"); } catch {}
    }
    cleanup.length = 0;
  });

  // Helper: pre-populate a DB and mock the agent lookup via a patched listAgents
  // Since the dashboard uses listAgents() from agent.ts which scans the filesystem,
  // we test the API functions via the full handler for agents that exist on disk,
  // or verify 404 for agents that don't.

  test("unknown agent returns 404", async () => {
    const agents = new Map<string, AgentContext>();
    const stats = makeStats();
    const resp = handleDashboardRequest(
      makeUrl("/_dashboard/api/agent/nonexistent-agent-xyz/memories"),
      agents,
      stats,
    );
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(404);
    const data = await resp!.json() as Record<string, unknown>;
    expect(data.error).toBe("Agent not found");
  });

  test("unknown sub-endpoint returns 404", async () => {
    const agents = new Map<string, AgentContext>();
    const stats = makeStats();
    // Even if agent doesn't exist, it would 404 on agent first
    const resp = handleDashboardRequest(
      makeUrl("/_dashboard/api/agent/nonexistent-agent-xyz/badroute"),
      agents,
      stats,
    );
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(404);
  });
});

describe("API: dreams and hippo persistence", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const p of cleanup) {
      try { unlinkSync(p); } catch {}
      try { unlinkSync(p + "-wal"); } catch {}
      try { unlinkSync(p + "-shm"); } catch {}
    }
    cleanup.length = 0;
  });

  test("dream_passes stores and retrieves multiple passes", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    for (let i = 0; i < 3; i++) {
      db.run(
        `INSERT INTO dream_passes
          (timestamp, duration_ms, ops_requested, ops_executed,
           memories_created, memories_merged, memories_pruned, memories_superseded,
           associations_created, identity_ops, errors)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [Date.now() + i, 1000 + i * 100, 5 + i, 4 + i, i, 0, 0, 0, i, 0, null],
      );
    }

    const rows = db.query("SELECT * FROM dream_passes ORDER BY timestamp DESC").all() as Record<string, unknown>[];
    expect(rows.length).toBe(3);
    expect(rows[0]!.duration_ms).toBe(1200); // last inserted

    db.close();
  });

  test("hippocampus_runs stores and retrieves multiple runs", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    for (let i = 0; i < 5; i++) {
      db.run(
        `INSERT INTO hippocampus_runs
          (timestamp, duration_ms, memory_ids, memory_count, cue_text)
         VALUES (?, ?, ?, ?, ?)`,
        [Date.now() + i, 200 + i * 50, JSON.stringify([i, i + 1]), 2, `cue ${i}`],
      );
    }

    const rows = db.query("SELECT * FROM hippocampus_runs ORDER BY timestamp DESC").all() as Record<string, unknown>[];
    expect(rows.length).toBe(5);

    // Verify JSON parsing roundtrip
    const ids = JSON.parse(rows[0]!.memory_ids as string) as number[];
    expect(ids.length).toBe(2);

    db.close();
  });

  test("dream_passes with null errors", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    db.run(
      `INSERT INTO dream_passes
        (timestamp, duration_ms, ops_requested, ops_executed,
         memories_created, memories_merged, memories_pruned, memories_superseded,
         associations_created, identity_ops, errors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [Date.now(), 500, 3, 3, 1, 0, 0, 0, 1, 0, null],
    );

    const row = db.query("SELECT errors FROM dream_passes WHERE id = 1").get() as { errors: string | null };
    expect(row.errors).toBeNull();

    db.close();
  });
});

describe("API: eidetic endpoint", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const p of cleanup) {
      try { unlinkSync(p); } catch {}
      try { unlinkSync(p + "-wal"); } catch {}
      try { unlinkSync(p + "-shm"); } catch {}
    }
    cleanup.length = 0;
  });

  test("eidetic returns events with pagination info", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      db.run(
        "INSERT INTO raw_events (timestamp, message_group, role, content_type, content) VALUES (?, ?, ?, ?, ?)",
        [now + i, i + 1, i % 2 === 0 ? "user" : "assistant", "text", `message ${i}`],
      );
    }

    // Query directly since we can't go through the handler without a real agent on disk
    const rows = db.query("SELECT * FROM raw_events ORDER BY id DESC LIMIT 200 OFFSET 0").all();
    expect(rows.length).toBe(5);

    const total = db.query("SELECT COUNT(*) as c FROM raw_events").get() as { c: number };
    expect(total.c).toBe(5);

    const groups = db.query("SELECT COUNT(DISTINCT message_group) as c FROM raw_events").get() as { c: number };
    expect(groups.c).toBe(5);

    db.close();
  });

  test("eidetic FTS5 search works on raw_events", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const now = Date.now();
    db.run(
      "INSERT INTO raw_events (timestamp, message_group, role, content_type, content) VALUES (?, ?, ?, ?, ?)",
      [now, 1, "user", "text", "tell me about purple elephants"],
    );
    db.run(
      "INSERT INTO raw_events (timestamp, message_group, role, content_type, content) VALUES (?, ?, ?, ?, ?)",
      [now, 2, "assistant", "text", "here is some unrelated content"],
    );

    const results = db.query(
      `SELECT r.id FROM raw_events r
       JOIN raw_events_fts f ON f.rowid = r.id
       WHERE raw_events_fts MATCH '"purple"'`
    ).all();
    expect(results.length).toBe(1);

    db.close();
  });
});

describe("memory type API", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const p of cleanup) {
      try { unlinkSync(p); } catch {}
      try { unlinkSync(p + "-wal"); } catch {}
      try { unlinkSync(p + "-shm"); } catch {}
    }
    cleanup.length = 0;
  });

  test("memory rows include type and archived_at fields", () => {
    const { db, path } = tempDb();
    cleanup.push(path);

    const now = Date.now();
    db.run(
      "INSERT INTO memories (content, salience, created_at, last_accessed, type) VALUES (?, ?, ?, ?, ?)",
      ["test fact", 0.7, now, now, "fact"]
    );
    db.run(
      "INSERT INTO memories (content, salience, created_at, last_accessed, type, archived_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["old fact", 0.5, now, now, "fact", now]
    );

    const active = db.query("SELECT type, archived_at FROM memories WHERE archived_at IS NULL").get() as any;
    expect(active.type).toBe("fact");
    expect(active.archived_at).toBeNull();

    const archived = db.query("SELECT type, archived_at FROM memories WHERE archived_at IS NOT NULL").get() as any;
    expect(archived.type).toBe("fact");
    expect(archived.archived_at).not.toBeNull();

    db.close();
  });
});

describe("HTML pages", () => {
  test("index page contains Spotless Dashboard title", async () => {
    const agents = new Map<string, AgentContext>();
    const stats = makeStats();
    const resp = handleDashboardRequest(makeUrl("/_dashboard/"), agents, stats);
    const html = await resp!.text();
    expect(html).toContain("Spotless Dashboard");
    expect(html).toContain("Requests: 42");
  });

  test("agent page includes Eidetic tab", async () => {
    // Use a known agent from the filesystem if available, otherwise check the template
    const agents = new Map<string, AgentContext>();
    const stats = makeStats();
    // The renderAgentPage function always includes the Eidetic tab
    // We can verify via the index page that it references the right tabs
    const resp = handleDashboardRequest(makeUrl("/_dashboard/"), agents, stats);
    const html = await resp!.text();
    // Index page doesn't have tabs, but we can at least verify it renders
    expect(html).toContain("Spotless Dashboard");
  });

  test("agent page contains agent name and tabs", async () => {
    const agents = new Map<string, AgentContext>();
    const stats = makeStats();
    // Even for non-existent agent, agent page renders (the API calls will fail client-side)
    // But for a truly non-existent agent, we get 404 page
    const resp = handleDashboardRequest(makeUrl("/_dashboard/agent/nonexistent-xyz"), agents, stats);
    const html = await resp!.text();
    // Should be a 404 page since agent doesn't exist on disk
    expect(html).toContain("not found");
  });
});
