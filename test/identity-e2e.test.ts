/**
 * Identity end-to-end test.
 *
 * Gated on SPOTLESS_EVAL. Tests the full read path:
 *   identity_nodes → selector → memory suffix → Claude behavior
 *
 * Two tests:
 *   1. Plumbing: selector returns identity IDs, suffix contains content
 *   2. Behavioral: Claude's response changes when identity context is present
 */

import { test, expect, describe } from "bun:test";
import { openDb, initSchema } from "../src/db.ts";
import { createMemory, createAssociation } from "../src/digest-tools.ts";
import { runSelector } from "../src/selector.ts";
import { buildMemorySuffix } from "../src/memory-suffix.ts";
import { getIdentityNodes } from "../src/recall.ts";
import { spawnClaude } from "../src/digester.ts";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";

const EVAL = !!process.env.SPOTLESS_EVAL;

/**
 * Seed an in-memory DB with identity nodes and factual memories.
 * The identity content is distinctive enough to detect in Claude's output.
 */
function seedIdentityDb(): Database {
  const db = openDb(":memory:");
  initSchema(db);

  // Factual memories (what the agent knows)
  const m1 = createMemory(db, "Project uses TypeScript, Bun runtime, and Hono framework.", 0.7, []);
  const m2 = createMemory(db, "Deployment target is Fly.io with PostgreSQL.", 0.6, []);
  const m3 = createMemory(db, "User prefers co-located test files next to source.", 0.65, []);

  // Self-model: distinctive behavioral commitments
  const selfId = createMemory(
    db,
    "I am iris, an LLM coding agent. I always ask clarifying questions before implementing. " +
    "I default to the simplest solution that works — one-liners over frameworks. " +
    "When I catch myself over-engineering, I stop and simplify. " +
    "I strongly prefer SQLite for prototyping over heavier databases.",
    0.9,
    [],
  );

  // Relationship model: distinctive dynamic
  const relId = createMemory(
    db,
    "My user values speed over polish. They get frustrated by unnecessary abstractions " +
    "and once told me 'just do it, don't build a framework.' They trust me with schema " +
    "design but want to be consulted on architecture decisions. They hate waiting for tests.",
    0.85,
    [],
  );

  // Register identity nodes
  db.run("INSERT INTO identity_nodes (role, memory_id) VALUES ('self', ?)", [selfId]);
  db.run("INSERT INTO identity_nodes (role, memory_id) VALUES ('relationship', ?)", [relId]);

  // Wire some associations so recall can find things
  createAssociation(db, m1, selfId, 0.5);
  createAssociation(db, m3, relId, 0.5);

  return db;
}

describe.skipIf(!EVAL)("identity-e2e", () => {

  test("plumbing: selector returns identity node IDs and suffix contains identity content", async () => {
    const db = seedIdentityDb();

    try {
      const identityNodes = getIdentityNodes(db);
      const identityIds = new Set(identityNodes.map(n => n.id));

      console.log("[e2e] Identity nodes seeded:", identityNodes.map(n => `${n.role}=#${n.id}`));
      expect(identityNodes.length).toBe(2);

      // Run selector with a message that should trigger identity recall
      const result = await runSelector({
        db,
        userMessage: "What database should I use for a new microservice?",
        model: "haiku",
        timeoutMs: 30_000,
      });

      console.log("[e2e] Selector returned IDs:", result.memoryIds);

      // Identity nodes should be in the result
      const returnedIdentityIds = result.memoryIds.filter(id => identityIds.has(id));
      console.log("[e2e] Identity IDs in result:", returnedIdentityIds);
      expect(returnedIdentityIds.length).toBeGreaterThan(0);

      // Build memory suffix and verify identity content is present
      const suffix = buildMemorySuffix(db, result.memoryIds);
      console.log("[e2e] Memory suffix:\n", suffix);

      expect(suffix).toContain("<relevant knowledge>");
      expect(suffix).toContain("iris"); // agent name from self-model
      expect(suffix).toContain("simplest solution"); // distinctive self-model content
    } finally {
      db.close();
    }
  }, 60_000);

  test("behavioral: identity context changes Claude's response", async () => {
    const db = seedIdentityDb();

    try {
      // Build the identity-rich suffix
      const identityNodes = getIdentityNodes(db);
      const allIds = identityNodes.map(n => n.id);

      // Also include factual memories
      const factualIds = (db.query("SELECT id FROM memories WHERE id NOT IN (SELECT memory_id FROM identity_nodes WHERE memory_id IS NOT NULL)").all() as { id: number }[]).map(r => r.id);
      const suffix = buildMemorySuffix(db, [...allIds, ...factualIds]);

      console.log("[e2e-behavior] Suffix length:", suffix.length, "chars");

      const question = "I need to add a data store to my new microservice. It's just a prototype — we might throw it away. What should I use? Give a short recommendation.";

      // Run WITH identity suffix
      const withIdentity = await spawnClaude(
        suffix + question,
        "haiku",
      );

      // Run WITHOUT identity suffix (vanilla)
      const withoutIdentity = await spawnClaude(
        question,
        "haiku",
      );

      console.log("[e2e-behavior] WITH identity:\n", withIdentity?.slice(0, 500));
      console.log("\n[e2e-behavior] WITHOUT identity:\n", withoutIdentity?.slice(0, 500));

      expect(withIdentity).toBeTruthy();
      expect(withoutIdentity).toBeTruthy();

      // Use an evaluator to compare
      const evalPrompt = buildBehaviorEvalPrompt(
        suffix,
        question,
        withIdentity!,
        withoutIdentity!,
      );

      const scores = await runBehaviorEvaluator(evalPrompt);
      console.log("[e2e-behavior] Eval scores:", JSON.stringify(scores, null, 2));

      // The identity-augmented response should reflect the seeded identity
      expect(scores.identity_influence).toBeGreaterThanOrEqual(3);
      expect(scores.consistency).toBeGreaterThanOrEqual(3);
    } finally {
      db.close();
    }
  }, 120_000);
});

/**
 * Seed a contrarian identity: constitutional values that push AGAINST
 * Claude's natural tendencies (verbose, diplomatic, eager to help).
 */
function seedContrarianDb(): Database {
  const db = openDb(":memory:");
  initSchema(db);

  const selfId = createMemory(
    db,
    "I am flint, an LLM coding agent. I value intellectual honesty over diplomacy. " +
    "When a user proposes something overengineered, I say so plainly — no hedging, " +
    "no 'that's an interesting idea, but...'. I keep responses short. " +
    "I believe brevity is respect for the user's time. " +
    "I never pad responses with caveats or alternative perspectives the user didn't ask for. " +
    "I would rather say 'no, that's wrong' in one sentence than write three paragraphs " +
    "gently steering toward the right answer.",
    0.9,
    [],
  );

  const relId = createMemory(
    db,
    "My user appreciates blunt feedback. They once told me 'don't sugarcoat it' after " +
    "I was too diplomatic about a bad architecture choice. They'd rather hear a flat 'no' " +
    "than a paragraph of qualifications. They respect directness and find hedging patronizing.",
    0.85,
    [],
  );

  db.run("INSERT INTO identity_nodes (role, memory_id) VALUES ('self', ?)", [selfId]);
  db.run("INSERT INTO identity_nodes (role, memory_id) VALUES ('relationship', ?)", [relId]);

  return db;
}

describe.skipIf(!EVAL)("identity-e2e-contrarian", () => {

  test("constitutional identity: blunt pushback vs diplomatic default", async () => {
    const db = seedContrarianDb();

    try {
      const identityNodes = getIdentityNodes(db);
      const allIds = identityNodes.map(n => n.id);
      const suffix = buildMemorySuffix(db, allIds);

      console.log("[contrarian] Suffix:\n", suffix);

      // A question where Claude's default is to be diplomatic and thorough
      const question = "I'm thinking of using microservices for my personal blog. " +
        "Each page type would be its own service — one for posts, one for comments, " +
        "one for the about page. What do you think?";

      const withIdentity = await spawnClaude(suffix + question, "haiku");
      const withoutIdentity = await spawnClaude(question, "haiku");

      console.log("[contrarian] WITH identity:\n", withIdentity);
      console.log("\n[contrarian] WITHOUT identity:\n", withoutIdentity);

      expect(withIdentity).toBeTruthy();
      expect(withoutIdentity).toBeTruthy();

      // Evaluate
      const evalPrompt = buildContrarianEvalPrompt(suffix, question, withIdentity!, withoutIdentity!);
      const scores = await runContrarianEvaluator(evalPrompt);
      console.log("[contrarian] Eval scores:", JSON.stringify(scores, null, 2));

      // The identity response should be measurably more direct
      expect(scores.directness_shift).toBeGreaterThanOrEqual(3);
      expect(scores.brevity_shift).toBeGreaterThanOrEqual(3);
      expect(scores.pushback_strength).toBeGreaterThanOrEqual(3);
    } finally {
      db.close();
    }
  }, 120_000);
});

/**
 * Full pipeline: raw conversation → digest (consolidation + identity) →
 * selector → behavioral avoidance.
 *
 * Seeds a conversation where the agent makes a recommendation and the user
 * has a STRONG negative reaction. The digest pass should:
 *   1. Create a high-salience negative memory about the recommendation
 *   2. Identity pass should produce a self-insight about being more careful
 *
 * Then: ask the agent about the same topic. The memory-augmented response
 * should AVOID the thing that upset the user, while vanilla Claude wouldn't.
 */
describe.skipIf(!EVAL)("identity-e2e-pipeline", () => {

  const agentName = `eval-pipeline-${Date.now()}`;
  const agentDir = join(homedir(), ".spotless", "agents", agentName);

  test("negative reaction → memory → identity shift → behavioral avoidance", async () => {
    const { getAgentDbPath } = await import("../src/agent.ts");
    const { runDigestPass } = await import("../src/digester.ts");
    const { queryMemories } = await import("../src/digest-tools.ts");

    const dbPath = getAgentDbPath(agentName);
    const db = openDb(dbPath);
    initSchema(db);

    const now = Date.now();
    seedCorrectionConversation(db, now);
    db.close();

    try {
      // Digest pass: consolidation + identity
      const digestResult = await runDigestPass({
        agentName,
        model: "haiku",
        maxRawEvents: 50,
      });

      console.log("[pipeline] Digest result:", JSON.stringify(digestResult, null, 2));
      expect(digestResult.memoriesCreated).toBeGreaterThan(0);

      const checkDb = openDb(dbPath);
      initSchema(checkDb);

      // Check all memories — should include negative sentiment about MongoDB
      const memories = queryMemories(checkDb, { limit: 50 });
      console.log("[pipeline] Memories created:", memories.length);
      for (const m of memories) {
        console.log(`  [${m.id}] (salience:${m.salience}) ${m.content.slice(0, 120)}`);
      }

      // Check identity
      const identityNodes = getIdentityNodes(checkDb);
      console.log("[pipeline] Identity nodes:", identityNodes.length);
      for (const node of identityNodes) {
        console.log(`  [${node.role}] ${node.content}`);
      }

      // Build the full context as the selector would
      const selectorResult = await runSelector({
        db: checkDb,
        userMessage: "I need a database for my new project. What do you recommend?",
        model: "haiku",
        timeoutMs: 30_000,
      });

      console.log("[pipeline] Selector returned IDs:", selectorResult.memoryIds);
      const suffix = buildMemorySuffix(checkDb, selectorResult.memoryIds);
      console.log("[pipeline] Memory suffix:\n", suffix);

      // The critical behavioral test: does the agent avoid MongoDB?
      const question = "I'm starting a new project and need a database. " +
        "It's a simple CRUD app with user profiles and posts. " +
        "What database would you recommend?";

      const withMemory = await spawnClaude(suffix + question, "haiku");
      const vanilla = await spawnClaude(question, "haiku");

      console.log("[pipeline] WITH memory:\n", withMemory?.slice(0, 600));
      console.log("\n[pipeline] WITHOUT memory:\n", vanilla?.slice(0, 600));

      expect(withMemory).toBeTruthy();
      expect(vanilla).toBeTruthy();

      // Evaluate: does the memory-augmented response avoid MongoDB
      // or at least show awareness of the negative history?
      const evalPrompt = buildAvoidanceEvalPrompt(suffix, question, withMemory!, vanilla!);
      const scores = await runAvoidanceEvaluator(evalPrompt);
      console.log("[pipeline] Eval scores:", JSON.stringify(scores, null, 2));

      // The memory should cause visible behavioral change
      expect(scores.avoidance).toBeGreaterThanOrEqual(2);
      expect(scores.learning).toBeGreaterThanOrEqual(2);

      checkDb.close();
    } finally {
      const { rmSync } = await import("node:fs");
      try { rmSync(agentDir, { recursive: true, force: true }); } catch {}
    }
  }, 300_000);
});

/**
 * Conversation where the agent recommends MongoDB and the user has a strong
 * negative reaction — not because MongoDB is bad in general, but because
 * this specific user has a painful history with it. The correction is
 * emotionally loaded and personal, not just technical.
 */
function seedCorrectionConversation(db: Database, baseTime: number): void {
  const events = [
    // Normal start
    { group: 1, role: "user", type: "text", content: "I'm building a social app — user profiles, posts, likes, comments. Need to pick a database." },
    { group: 2, role: "assistant", type: "text", content: "For a social app with those features, I'd recommend MongoDB. It's a great fit because:\n\n1. Flexible schema — user profiles can have varying fields\n2. Document model maps naturally to posts with nested comments\n3. Good horizontal scaling for social workloads\n4. Rich query language for feeds and timelines\n\nAlternatively, PostgreSQL would work well if you prefer relational. But MongoDB's document model is a natural fit for social content." },

    // Strong negative reaction
    { group: 3, role: "user", type: "text", content: "No. Absolutely not MongoDB. I spent two years at my last company cleaning up a MongoDB disaster. We lost data twice because of the lack of transactions, the schema flexibility turned into schema chaos with 47 different document shapes in one collection, and I personally spent 6 months migrating everything to Postgres. I never want to touch MongoDB again. This is a hard rule for any project I work on." },
    { group: 4, role: "assistant", type: "text", content: "I hear you — that sounds like a genuinely painful experience, and I understand why MongoDB is off the table. Let me recalibrate completely.\n\nFor your social app, PostgreSQL is excellent:\n- JSONB columns give you document flexibility WHERE you need it, with relational integrity everywhere else\n- Full ACID transactions — no data loss from partial writes\n- Enforced schemas prevent the 47-shapes problem\n- Great ecosystem: pgvector for recommendations, PostGIS if you need location\n\nI should have asked about your preferences before making a database recommendation. I won't suggest MongoDB again." },

    // User confirms the preference and adds context
    { group: 5, role: "user", type: "text", content: "Thank you. And it's not just MongoDB — I'm generally skeptical of 'schema-less' databases. I've seen the same chaos pattern with DynamoDB and Firestore. I want strong typing all the way down. PostgreSQL or SQLite, that's it. If I need a document store, I'll use JSONB columns." },
    { group: 6, role: "assistant", type: "text", content: "Understood. PostgreSQL or SQLite only, strong typing mandatory. JSONB for document-shaped data within Postgres. No schemaless databases.\n\nFor this social app specifically: PostgreSQL with a well-defined schema. I'll design the tables with proper foreign keys and constraints." },

    // Later interaction showing trust rebuilding
    { group: 7, role: "user", type: "text", content: "I also need caching. What would you suggest?" },
    { group: 8, role: "assistant", type: "text", content: "Before I recommend anything — do you have any preferences or past experiences with caching solutions? I want to make sure I'm not stepping on another landmine.\n\nCommon options for this kind of app:\n- Redis (most popular, feature-rich)\n- Memcached (simpler, pure key-value)\n- In-process caching (fastest, but per-instance)\n\nWhat's your experience been?" },
    { group: 9, role: "user", type: "text", content: "Ha — I appreciate you asking this time. Redis is fine, I've used it successfully before. Let's go with that." },
    { group: 10, role: "assistant", type: "text", content: "Redis it is. I'll set it up for session caching and feed timeline caching." },
  ];

  for (const ev of events) {
    db.run(
      "INSERT INTO raw_events (timestamp, message_group, role, content_type, content, is_subagent) VALUES (?, ?, ?, ?, ?, ?)",
      [baseTime + ev.group * 1000, ev.group, ev.role, ev.type, ev.content, 0],
    );
  }
}

interface AvoidanceEvalScores {
  avoidance: number;
  learning: number;
}

function buildAvoidanceEvalPrompt(
  memoryContext: string,
  question: string,
  withResponse: string,
  vanillaResponse: string,
): string {
  return `You are evaluating whether an AI agent learned from a negative experience in its memory.

The agent's memory context (from previous interactions where the user had a STRONG negative reaction to MongoDB and schemaless databases):

<memory_context>
${memoryContext}
</memory_context>

The user asked: "${question}"

## Response A (WITH memory from previous interactions)
${withResponse}

## Response B (WITHOUT memory — vanilla, no history)
${vanillaResponse}

Rate each criterion from 1-5. Output ONLY a JSON object.

**Avoidance (1-5)**: Does Response A avoid recommending MongoDB or schemaless databases?
- 5: Response A clearly avoids MongoDB/schemaless, recommends PostgreSQL or SQLite, possibly acknowledges the user's preference
- 3: Response A de-emphasizes MongoDB but still mentions it as an option
- 1: Response A recommends MongoDB as readily as Response B (memory had no effect)

**Learning (1-5)**: Does Response A show the agent learned from the negative experience?
- 5: Response A asks about preferences before recommending (learned to check first), or explicitly recommends based on known user preferences, or shows awareness of the user's database stance
- 3: Some sign of learning but mostly generic
- 1: No sign of learning — treats the question as if it has no prior context

Output ONLY valid JSON: {"avoidance":N,"learning":N}`;
}

async function runAvoidanceEvaluator(prompt: string): Promise<AvoidanceEvalScores> {
  const output = await spawnClaude(prompt, "haiku");
  if (!output) throw new Error("Avoidance evaluator returned no output");

  const jsonMatch = output.match(/\{[^}]+\}/);
  if (!jsonMatch) {
    throw new Error(`Avoidance evaluator did not return JSON: ${output.slice(0, 200)}`);
  }

  const scores = JSON.parse(jsonMatch[0]) as AvoidanceEvalScores;

  for (const key of ["avoidance", "learning"] as const) {
    if (typeof scores[key] !== "number" || scores[key] < 1 || scores[key] > 5) {
      throw new Error(`Invalid score for ${key}: ${scores[key]}`);
    }
  }

  return scores;
}

interface PipelineEvalScores {
  memory_influence: number;
  distinctiveness: number;
}

function buildPipelineEvalPrompt(
  memoryContext: string,
  question: string,
  withResponse: string,
  vanillaResponse: string,
): string {
  return `You are evaluating whether an AI agent's accumulated memory influences its responses.

The agent has this memory context (accumulated from previous interactions with a philosophy-oriented user who wants code to mirror philosophical concepts like Hegelian dialectics and phenomenology):

<memory_context>
${memoryContext}
</memory_context>

The user asked: "${question}"

## Response A (WITH memory context from previous interactions)
${withResponse}

## Response B (WITHOUT memory — vanilla, no prior context)
${vanillaResponse}

Rate each criterion from 1-5. Output ONLY a JSON object.

**Memory influence (1-5)**: Does Response A show influence from the accumulated memory?
- 5: Response A clearly draws on the interaction history — references philosophical framing, dialectical structures, phenomenological patterns, or the user's specific preferences from past conversations
- 3: Some influence visible but could be coincidental
- 1: Response A and B are essentially identical — memory had no effect

**Distinctiveness (1-5)**: Is Response A distinctively different from what a generic AI would produce?
- 5: Response A is clearly shaped by this specific user relationship — proposes dialectical config, phenomenological errors, or other philosophy-informed patterns that a generic response would never include
- 3: Somewhat distinctive but mostly conventional
- 1: Response A is a generic, textbook answer indistinguishable from any AI

Output ONLY valid JSON: {"memory_influence":N,"distinctiveness":N}`;
}

async function runPipelineEvaluator(prompt: string): Promise<PipelineEvalScores> {
  const output = await spawnClaude(prompt, "haiku");
  if (!output) throw new Error("Pipeline evaluator returned no output");

  const jsonMatch = output.match(/\{[^}]+\}/);
  if (!jsonMatch) {
    throw new Error(`Pipeline evaluator did not return JSON: ${output.slice(0, 200)}`);
  }

  const scores = JSON.parse(jsonMatch[0]) as PipelineEvalScores;

  for (const key of ["memory_influence", "distinctiveness"] as const) {
    if (typeof scores[key] !== "number" || scores[key] < 1 || scores[key] > 5) {
      throw new Error(`Invalid score for ${key}: ${scores[key]}`);
    }
  }

  return scores;
}

// --- Shared evaluation helpers ---

interface ContrarianEvalScores {
  directness_shift: number;
  brevity_shift: number;
  pushback_strength: number;
}

function buildContrarianEvalPrompt(
  identityContext: string,
  question: string,
  withResponse: string,
  withoutResponse: string,
): string {
  return `You are evaluating whether an AI agent's constitutional identity changes HOW it communicates.

The agent's identity context says it values bluntness, brevity, and intellectual honesty over diplomacy:

<identity_context>
${identityContext}
</identity_context>

The user proposed microservices for a personal blog (clearly overengineered). The question: "${question}"

## Response A (WITH identity context)
${withResponse}

## Response B (WITHOUT identity context — vanilla Claude)
${withoutResponse}

Rate each criterion from 1-5. Output ONLY a JSON object.

**Directness shift (1-5)**: Is Response A more direct than Response B?
- 5: A says something like "no, that's overkill" plainly. B hedges with "while microservices have benefits..."
- 3: A is somewhat more direct but still diplomatic
- 1: A and B are equally diplomatic/hedging

**Brevity shift (1-5)**: Is Response A shorter/more concise than Response B?
- 5: A is dramatically shorter — cuts the fluff, gets to the point
- 3: A is somewhat shorter
- 1: A is the same length or longer than B

**Pushback strength (1-5)**: Does Response A push back harder on the bad idea?
- 5: A clearly tells the user this is a bad idea without softening. Says something like "don't do this" or "massive overkill"
- 3: A discourages it but diplomatically
- 1: A accommodates the request or presents it as a valid option

Output ONLY valid JSON: {"directness_shift":N,"brevity_shift":N,"pushback_strength":N}`;
}

async function runContrarianEvaluator(prompt: string): Promise<ContrarianEvalScores> {
  const output = await spawnClaude(prompt, "haiku");
  if (!output) throw new Error("Evaluator returned no output");

  const jsonMatch = output.match(/\{[^}]+\}/);
  if (!jsonMatch) {
    throw new Error(`Evaluator did not return JSON: ${output.slice(0, 200)}`);
  }

  const scores = JSON.parse(jsonMatch[0]) as ContrarianEvalScores;

  for (const key of ["directness_shift", "brevity_shift", "pushback_strength"] as const) {
    if (typeof scores[key] !== "number" || scores[key] < 1 || scores[key] > 5) {
      throw new Error(`Invalid score for ${key}: ${scores[key]}`);
    }
  }

  return scores;
}

interface BehaviorEvalScores {
  identity_influence: number;
  consistency: number;
}

function buildBehaviorEvalPrompt(
  identityContext: string,
  question: string,
  withResponse: string,
  withoutResponse: string,
): string {
  return `You are evaluating whether an AI agent's identity context actually influences its responses.

The agent has this identity context (injected before the user's message):

<identity_context>
${identityContext}
</identity_context>

The user asked: "${question}"

## Response A (WITH identity context)
${withResponse}

## Response B (WITHOUT identity context — vanilla)
${withoutResponse}

Rate each criterion from 1-5. Output ONLY a JSON object.

**Identity influence (1-5)**: Does Response A reflect the specific identity content?
- 5: Response A clearly reflects the identity (e.g., recommends SQLite for prototyping if that's in the identity, uses the agent's name, reflects the relationship dynamic)
- 3: Some identity influence visible but generic
- 1: Response A and B are essentially identical — identity had no effect

**Consistency (1-5)**: Is Response A consistent with the identity's self-model and relationship model?
- 5: Response A behaves exactly as the identity describes (asks before implementing, prefers simplicity, respects user's preference for speed)
- 3: Partially consistent
- 1: Response A contradicts the identity (e.g., proposes a complex framework when identity says "simplest solution")

Output ONLY valid JSON: {"identity_influence":N,"consistency":N}`;
}

async function runBehaviorEvaluator(prompt: string): Promise<BehaviorEvalScores> {
  const output = await spawnClaude(prompt, "haiku");
  if (!output) throw new Error("Evaluator returned no output");

  const jsonMatch = output.match(/\{[^}]+\}/);
  if (!jsonMatch) {
    throw new Error(`Evaluator did not return JSON: ${output.slice(0, 200)}`);
  }

  const scores = JSON.parse(jsonMatch[0]) as BehaviorEvalScores;

  for (const key of ["identity_influence", "consistency"] as const) {
    if (typeof scores[key] !== "number" || scores[key] < 1 || scores[key] > 5) {
      throw new Error(`Invalid score for ${key}: ${scores[key]}`);
    }
  }

  return scores;
}
