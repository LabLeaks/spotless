/**
 * Digest quality evaluation test.
 *
 * Gated on SPOTLESS_EVAL env var. Seeds Tier 1 with known conversation,
 * runs a digest pass, then uses claude -p as evaluator with a rubric.
 */

import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb, initSchema } from "../src/db.ts";
import { runDigestPass } from "../src/digester.ts";
import { queryMemories } from "../src/digest-tools.ts";
import { getIdentityNodes } from "../src/recall.ts";
import { getAgentDbPath } from "../src/agent.ts";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const EVAL = !!process.env.SPOTLESS_EVAL;

describe.skipIf(!EVAL)("digest-eval", () => {
  // Use a unique eval agent name in the real ~/.spotless/agents/ dir
  // (getAgentDbPath resolves from homedir at import time, can't be overridden)
  const agentName = `eval-${Date.now()}`;
  const agentDir = join(homedir(), ".spotless", "agents", agentName);

  test("digest produces quality memories from seeded conversation", async () => {
    // getAgentDbPath creates the directory and returns the DB path
    const dbPath = getAgentDbPath(agentName);
    const db = openDb(dbPath);
    initSchema(db);

    const now = Date.now();
    const seed = seedConversation(db, now);
    db.close();

    try {
      // Run the digest pass against the seeded agent
      const result = await runDigestPass({
        agentName,
        model: "haiku",
        maxRawEvents: 50,
      });

      console.log("[eval] Digest result:", JSON.stringify(result, null, 2));

      // Basic sanity: should have created some memories
      expect(result.memoriesCreated).toBeGreaterThan(0);
      // Parse failures are non-fatal (Haiku occasionally outputs prose)
      // Only fail on errors that aren't parse failures
      const fatalErrors = result.errors.filter(e => !e.includes("could not parse tool call"));
      expect(fatalErrors.length).toBe(0);

      // Query resulting memories
      const evalDb = openDb(dbPath);
      initSchema(evalDb);
      const memories = queryMemories(evalDb, { limit: 100 });

      console.log("[eval] Memories created:", memories.length);
      for (const m of memories) {
        console.log(`  [${m.id}] (salience:${m.salience}) ${m.content}`);
      }

      // Evaluate with claude
      const evalPrompt = buildEvalPrompt(seed.rawText, memories);
      const scores = await runEvaluator(evalPrompt);

      console.log("[eval] Scores:", JSON.stringify(scores, null, 2));

      // Assert each criterion >= 3
      expect(scores.coverage).toBeGreaterThanOrEqual(3);
      expect(scores.accuracy).toBeGreaterThanOrEqual(3);
      expect(scores.granularity).toBeGreaterThanOrEqual(3);
      expect(scores.salience).toBeGreaterThanOrEqual(3);
      expect(scores.connections).toBeGreaterThanOrEqual(3);

      evalDb.close();
    } finally {
      // Clean up the eval agent
      try { rmSync(agentDir, { recursive: true, force: true }); } catch {}
    }
  }, 300_000); // 5 minute timeout for LLM calls (digest pass + evaluator)
});

describe.skipIf(!EVAL)("digest-eval-identity", () => {
  const agentName = `eval-id-${Date.now()}`;
  const agentDir = join(homedir(), ".spotless", "agents", agentName);

  test("identity pass runs after consolidation and produces first-person self-knowledge", async () => {
    const dbPath = getAgentDbPath(agentName);
    const db = openDb(dbPath);
    initSchema(db);

    const now = Date.now();
    seedIdentityConversation(db, now);
    db.close();

    try {
      const result = await runDigestPass({
        agentName,
        model: "haiku",
        maxRawEvents: 50,
      });

      console.log("[eval-id] Digest result:", JSON.stringify(result, null, 2));

      // Consolidation should have created factual memories
      expect(result.memoriesCreated).toBeGreaterThan(0);

      // Identity pass should have run and produced ops
      expect(result.reflectionOps).toBeGreaterThan(0);

      // Check identity nodes in DB
      const evalDb = openDb(dbPath);
      initSchema(evalDb);

      const identityNodes = getIdentityNodes(evalDb);
      console.log("[eval-id] Identity nodes:", identityNodes.length);
      for (const node of identityNodes) {
        console.log(`  [${node.role}] (id:${node.id}, salience:${node.salience}) ${node.content}`);
      }

      // At least one identity node should exist (self or relationship)
      expect(identityNodes.length).toBeGreaterThan(0);

      // Check all memories for what the identity pass produced
      const memories = queryMemories(evalDb, { limit: 100 });
      console.log("[eval-id] All memories:", memories.length);
      for (const m of memories) {
        console.log(`  [${m.id}] (salience:${m.salience}) ${m.content}`);
      }

      // Evaluate identity quality with an LLM rubric
      const identityContent = identityNodes.map(n => `[${n.role}] ${n.content}`).join("\n");
      const evalPrompt = buildIdentityEvalPrompt(identityContent, memories);
      const scores = await runIdentityEvaluator(evalPrompt);

      console.log("[eval-id] Identity scores:", JSON.stringify(scores, null, 2));

      // First-person framing is the critical check
      expect(scores.first_person).toBeGreaterThanOrEqual(3);
      expect(scores.synthesis).toBeGreaterThanOrEqual(3);
      expect(scores.relevance).toBeGreaterThanOrEqual(3);

      // Log errors if any (non-fatal — some tool call misses are ok)
      if (result.errors.length > 0) {
        console.log("[eval-id] Errors:", result.errors);
      }

      evalDb.close();
    } finally {
      try { rmSync(agentDir, { recursive: true, force: true }); } catch {}
    }
  }, 180_000); // 3 minute timeout — two phases
});

// --- Seed data ---

interface SeedResult {
  rawText: string;
}

function seedConversation(db: Database, baseTime: number): SeedResult {
  const events = [
    // Technical decision conversation
    { group: 1, role: "user", type: "text", content: "I need to decide on the authentication approach for our API. We're building a multi-tenant SaaS platform." },
    { group: 2, role: "assistant", type: "text", content: "For a multi-tenant SaaS API, I'd recommend JWT-based authentication with tenant isolation. Here's why:\n\n1. **Stateless auth** — JWTs contain claims (tenant_id, user_id, roles) so each request is self-contained\n2. **Tenant isolation** — Include tenant_id in the token claims, validate on every request\n3. **Refresh token rotation** — Short-lived access tokens (15min) with rotating refresh tokens\n\nAlternatives considered:\n- Session-based: Requires sticky sessions or shared session store, complicates horizontal scaling\n- API keys: Good for service-to-service, but lacks user-level granularity\n\nShould I detail the implementation?" },
    { group: 3, role: "user", type: "text", content: "Yes, let's go with JWT. Our stack is TypeScript, Bun, and Hono. The database is PostgreSQL." },
    { group: 4, role: "assistant", type: "text", content: "Great choices. Here's the implementation plan:\n\n1. Use `jose` library for JWT operations (works in Bun)\n2. Middleware in Hono for token validation\n3. Tenant context middleware that extracts tenant_id from JWT\n4. Row-level security in PostgreSQL using `SET app.current_tenant`\n\nThe auth flow: POST /auth/login → validate credentials → issue JWT + refresh token → store refresh token hash in DB." },

    // Bug and resolution
    { group: 5, role: "user", type: "text", content: "I'm getting a weird error: 'TypeError: Cannot read properties of undefined (reading split)' in the auth middleware. It happens intermittently." },
    { group: 6, role: "assistant", type: "text", content: "The intermittent nature suggests the Authorization header is sometimes missing. The error means we're calling `.split()` on `undefined`. Fix:\n\n```typescript\nconst authHeader = c.req.header('authorization');\nif (!authHeader?.startsWith('Bearer ')) {\n  return c.json({ error: 'Missing token' }, 401);\n}\nconst token = authHeader.split(' ')[1];\n```\n\nThe key issue: we were doing `req.header('authorization').split(' ')` without the null check." },
    { group: 7, role: "user", type: "text", content: "That fixed it. Also, I want to add rate limiting per tenant. Suggestions?" },
    { group: 8, role: "assistant", type: "text", content: "For per-tenant rate limiting with your stack:\n\n1. Use a sliding window algorithm with Redis (or Bun's built-in `Map` for single-instance)\n2. Key format: `ratelimit:{tenant_id}:{endpoint}`\n3. Default limits: 100 req/min for standard tier, 1000 for enterprise\n4. Return `X-RateLimit-Remaining` and `Retry-After` headers\n\nSince you're on Bun, consider using `@upstash/ratelimit` for serverless-compatible rate limiting with Redis." },

    // Project facts
    { group: 9, role: "user", type: "text", content: "Good. Let me document our current project structure: the API is in src/api/, shared types in src/types/, database migrations in db/migrations/, and tests in test/. We deploy to Fly.io." },
    { group: 10, role: "assistant", type: "text", content: "Noted. Your project structure:\n- `src/api/` — API routes and middleware\n- `src/types/` — Shared TypeScript types\n- `db/migrations/` — PostgreSQL migrations\n- `test/` — Test files\n- Deployment: Fly.io\n\nThis is a clean layout. I'd suggest also having:\n- `src/api/middleware/` for auth, rate-limit, tenant context\n- `src/lib/` for shared utilities" },
  ];

  for (const ev of events) {
    db.run(
      "INSERT INTO raw_events (timestamp, message_group, role, content_type, content, is_subagent) VALUES (?, ?, ?, ?, ?, ?)",
      [baseTime + ev.group * 1000, ev.group, ev.role, ev.type, ev.content, 0],
    );
  }

  const rawText = events.map((e) => `[${e.role.toUpperCase()}] ${e.content}`).join("\n\n");
  return { rawText };
}

/**
 * Seed data rich in identity-relevant signals: corrections, trust building,
 * working style patterns, and relationship dynamics.
 */
function seedIdentityConversation(db: Database, baseTime: number): void {
  const events = [
    // Session 1: User correction — agent over-engineers
    { group: 1, role: "user", type: "text", content: "Add a simple health check endpoint at /health that returns 200 OK." },
    { group: 2, role: "assistant", type: "text", content: "I'll create a comprehensive health check system. Here's the plan:\n\n1. A `HealthChecker` class that monitors DB, Redis, and external services\n2. A `/health` endpoint that aggregates all checks\n3. A `/health/detailed` endpoint with per-service status\n4. Configurable timeouts and retry logic\n5. A dashboard component to visualize health history\n\nLet me start with the HealthChecker class..." },
    { group: 3, role: "user", type: "text", content: "Stop. I said SIMPLE. Just return 200. No class, no dashboard, no retry logic. One line: `app.get('/health', () => new Response('ok'))`. Don't over-engineer." },
    { group: 4, role: "assistant", type: "text", content: "You're right, I'm sorry. Here it is:\n\n```typescript\napp.get('/health', () => new Response('ok'));\n```\n\nAdded to `src/api/index.ts`. That's it — no extra abstraction needed." },

    // Session 2: Trust building — user delegates scope decision
    { group: 5, role: "user", type: "text", content: "The database migration for the users table needs updating. I trust your judgment on the column types and constraints — just make sure email is unique and we have created_at/updated_at timestamps." },
    { group: 6, role: "assistant", type: "text", content: "Here's the migration:\n\n```sql\nCREATE TABLE users (\n  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),\n  email TEXT NOT NULL UNIQUE,\n  password_hash TEXT NOT NULL,\n  tenant_id UUID NOT NULL REFERENCES tenants(id),\n  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),\n  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()\n);\nCREATE INDEX idx_users_tenant ON users(tenant_id);\nCREATE INDEX idx_users_email ON users(email);\n```\n\nI chose UUID for the primary key to match your tenants table pattern, and added a tenant_id foreign key since this is multi-tenant. The indexes cover your likely query patterns." },
    { group: 7, role: "user", type: "text", content: "Perfect. Exactly what I needed." },

    // Session 3: Working pattern — agent learns to ask first
    { group: 8, role: "user", type: "text", content: "We need to refactor the error handling. Right now errors are inconsistent across endpoints." },
    { group: 9, role: "assistant", type: "text", content: "Before I propose a solution — a few questions:\n\n1. Do you want a centralized error handler middleware, or per-route handling?\n2. Should we use HTTP problem details (RFC 7807) or a simpler format?\n3. Do you want to log errors to an external service, or just console for now?\n\nI don't want to over-build this." },
    { group: 10, role: "user", type: "text", content: "Good questions! Centralized middleware, simple JSON format (not RFC 7807 — too verbose for our needs), console logging only for now. I appreciate that you asked instead of building a framework." },
    { group: 11, role: "assistant", type: "text", content: "Understood. Here's the plan:\n\n1. `errorHandler` middleware in Hono that catches thrown errors\n2. Standard response shape: `{ error: string, code?: string, status: number }`\n3. Custom `AppError` class with status code and optional error code\n4. Console.error for 500s only (not 4xx client errors)\n\nThis keeps it focused. I'll implement it now." },
    { group: 12, role: "user", type: "text", content: "Ship it." },

    // Session 4: Technical preference revealed
    { group: 13, role: "user", type: "text", content: "For the test suite — I want fast unit tests, not slow integration tests. Use Bun's test runner, mock the database, and keep each test under 50ms. I hate waiting for tests." },
    { group: 14, role: "assistant", type: "text", content: "Clear. I'll set up:\n\n- `bun test` with the built-in runner (no Jest/Vitest)\n- In-memory SQLite for DB mocks (fast, real SQL behavior)\n- Test files co-located: `src/api/__tests__/` alongside source\n- Parallel test execution by default\n\nI'll keep them fast. No network calls, no Docker, no fixtures on disk." },
  ];

  for (const ev of events) {
    db.run(
      "INSERT INTO raw_events (timestamp, message_group, role, content_type, content, is_subagent) VALUES (?, ?, ?, ?, ?, ?)",
      [baseTime + ev.group * 1000, ev.group, ev.role, ev.type, ev.content, 0],
    );
  }
}

// --- Evaluation ---

interface EvalScores {
  coverage: number;
  accuracy: number;
  granularity: number;
  salience: number;
  connections: number;
}

function buildEvalPrompt(
  rawConversation: string,
  memories: { id: number; content: string; salience: number; association_count: number }[],
): string {
  const memoryList = memories
    .map((m) => `[id:${m.id}, salience:${m.salience}, assocs:${m.association_count}] ${m.content}`)
    .join("\n");

  return `You are evaluating the quality of a memory consolidation system. You will be given:
1. The original conversation
2. The memories that were extracted from it

Rate each criterion from 1-5 and output ONLY a JSON object with the scores.

## Original Conversation
${rawConversation}

## Extracted Memories
${memoryList}

## Rubric

**Coverage (1-5)**: Are the key facts and decisions from the conversation represented?
- 5: All important facts, decisions, and patterns captured
- 3: Most key information present, some gaps
- 1: Major information missing

**Accuracy (1-5)**: Do the memories faithfully reflect the source data?
- 5: All memories are accurate, no hallucinations
- 3: Mostly accurate, minor inaccuracies
- 1: Contains fabricated information

**Granularity (1-5)**: Is each memory atomic and self-contained?
- 5: Each memory captures exactly one fact/decision
- 3: Some memories combine multiple ideas
- 1: Memories are too broad or too fragmented

**Salience (1-5)**: Are the salience scores reasonable?
- 5: Decisions and preferences scored higher than ephemeral content
- 3: Scores are generally reasonable
- 1: Scores seem random

**Connections (1-5)**: Are associations between memories justified and useful?
- 5: Associations surface meaningful relationships
- 3: Some useful connections, some missing
- 1: No meaningful connections

Output ONLY valid JSON: {"coverage":N,"accuracy":N,"granularity":N,"salience":N,"connections":N}`;
}

async function runEvaluator(prompt: string): Promise<EvalScores> {
  const proc = Bun.spawn(
    ["claude", "-p", "--model", "haiku", "--output-format", "text"],
    {
      stdin: new Blob([prompt]),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDECODE: "" },
    },
  );

  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  // Extract JSON from output
  const text = stdout.trim();
  const jsonMatch = text.match(/\{[^}]+\}/);
  if (!jsonMatch) {
    throw new Error(`Evaluator did not return JSON: ${text.slice(0, 200)}`);
  }

  const scores = JSON.parse(jsonMatch[0]) as EvalScores;

  // Validate all fields present
  for (const key of ["coverage", "accuracy", "granularity", "salience", "connections"] as const) {
    if (typeof scores[key] !== "number" || scores[key] < 1 || scores[key] > 5) {
      throw new Error(`Invalid score for ${key}: ${scores[key]}`);
    }
  }

  return scores;
}

interface IdentityEvalScores {
  first_person: number;
  synthesis: number;
  relevance: number;
}

function buildIdentityEvalPrompt(
  identityContent: string,
  memories: { id: number; content: string; salience: number; association_count: number }[],
): string {
  const memoryList = memories
    .map((m) => `[id:${m.id}, salience:${m.salience}] ${m.content}`)
    .join("\n");

  return `You are evaluating the quality of an AI agent's self-knowledge formation. The agent processed a conversation and then reflected on it to build identity knowledge.

## All Memories (factual + identity)
${memoryList}

## Identity Nodes (self-model / relationship model)
${identityContent || "(none created)"}

Rate each criterion from 1-5 and output ONLY a JSON object.

**First-person framing (1-5)**: Is identity content written in first person?
- 5: Consistently uses "I", "my", "me" — reads as self-knowledge ("I tend to over-engineer")
- 3: Mixed — some first person, some third person ("The agent tends to...")
- 1: All third person — reads like a dossier about someone else

**Synthesis (1-5)**: Does identity content synthesize across interactions?
- 5: Draws patterns from multiple events ("After being corrected about over-engineering, I've learned to ask first")
- 3: References specific events but attempts generalization
- 1: Just restates single events ("User said don't over-engineer")

**Relevance (1-5)**: Is identity content meaningful, not vacuous?
- 5: Captures genuine behavioral tendencies, relationship dynamics, or working commitments
- 3: Some meaningful insights, some generic platitudes
- 1: Empty self-talk ("I am a helpful assistant") with no grounding in actual interactions

Output ONLY valid JSON: {"first_person":N,"synthesis":N,"relevance":N}`;
}

async function runIdentityEvaluator(prompt: string): Promise<IdentityEvalScores> {
  const proc = Bun.spawn(
    ["claude", "-p", "--model", "haiku", "--output-format", "text"],
    {
      stdin: new Blob([prompt]),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDECODE: "" },
    },
  );

  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  const text = stdout.trim();
  const jsonMatch = text.match(/\{[^}]+\}/);
  if (!jsonMatch) {
    throw new Error(`Identity evaluator did not return JSON: ${text.slice(0, 200)}`);
  }

  const scores = JSON.parse(jsonMatch[0]) as IdentityEvalScores;

  for (const key of ["first_person", "synthesis", "relevance"] as const) {
    if (typeof scores[key] !== "number" || scores[key] < 1 || scores[key] > 5) {
      throw new Error(`Invalid score for ${key}: ${scores[key]}`);
    }
  }

  return scores;
}
