# Spotless: Persistent Memory System for Claude Code

## Problem

Claude Code's native memory is limited:
- CLAUDE.md files are static text loaded every session regardless of relevance
- Auto-memory (MEMORY.md) is capped at 200 lines, no semantic retrieval
- Conversation context grows monotonically during a session until hitting the window limit
- Compaction is lossy and undirected — Claude Code decides what to summarize with no project-aware intelligence
- No cross-session learning beyond what fits in markdown files
- No mechanism for consolidating patterns, connections, or insights over time

The result: Claude starts every session mostly amnesiac, and within a session, context degrades as it fills with stale tool outputs and irrelevant history.

## Solution

Spotless is a **local reverse proxy** that sits between Claude Code and the Anthropic API. It intercepts API calls at human/Claude turn boundaries and assembles an optimally-curated context — structured as layered messages for KV cache efficiency — containing exactly what Claude needs for the current query, nothing more. A Haiku-powered "selector" picks relevant memories from a per-agent SQLite store. A continuous "digesting" process consolidates raw session data into an interconnected associative memory graph.

Claude never knows Spotless exists. From its perspective, it simply has the right context at the right time. It's not a tool, not an MCP server, not a hook — it's a brain implant.

## Architecture

```
                    Anthropic API
                    ^           ^
                    |           |
Claude Code ----> Spotless      |
                  Proxy         |
                    |    +--> Selector (Haiku)
                    |    |      |
                    v    v      v
                  SQLite (per-agent)
                    ^
                    |
                  Digesting (background)
```

The `spotless` daemon runs two components:
- **Proxy** — HTTP server that forwards rewritten requests to Anthropic, reads/writes SQLite. Orchestrates the selector by spawning `claude` as a subprocess (e.g., `claude -p --model haiku`) with the selector prompt and tool definitions. Claude Code handles its own auth — the proxy never touches API keys.
- **Digesting** — background loop that runs continuously while the daemon is alive. Spawns `claude` subprocesses for each digest pass. Operates on SQLite independently — doesn't need the main Claude Code session to be running.

The selector prompt and the digest prompt are the **primary tuning surfaces** for the entire system. The proxy is mechanical. The schema is structural. All intelligence — what to retrieve, how to consolidate — lives in these two prompts.

### Mechanism

Claude Code is started with `ANTHROPIC_BASE_URL=http://localhost:9000/agent/<name>` (or via `spotless code --agent <name>`). All API calls route through the Spotless proxy. The agent name in the URL determines which SQLite database is used. The proxy:

1. Receives the full API request (system prompt, messages array, model, tools, parameters)
2. Classifies the request: human turn, tool loop, or subagent (see detection below)
3. Archives incoming request content to Tier 1 (sync — see Archival below). This must complete before the selector runs so that recent events are queryable from the database.
4. Processes based on classification:
   - **Human turn**: uses the **previous** selector result to build the memory suffix (or no memories on first turn). Augments the system prompt with `<spotless-orientation>`. Constructs the layered message format (see Active Context) and caches it as the tool loop "base." Starts the selector **asynchronously** for the current query — the result will be used on the next human turn.
   - **Tool loop**: appends the new tool interactions from its tool loop chain onto the cached base. Passes through unchanged — only `messages` is ever rewritten, and only on human turns. All other request parameters (model, tools, max_tokens, temperature, tool_choice, etc.) always pass through untouched.
   - **Subagent**: passes through entirely unchanged.
5. Forwards the (possibly rewritten) request to `api.anthropic.com`, streams response back to Claude Code while tapping the stream to capture Claude's response for archival and tool loop state. Response archival completes before the next request arrives (requests are sequential).
6. Logs retrieval co-occurrences from the selector result used in step 4 (see Retrieval Log).

### Archival

The proxy archives content as it flows through, capturing deltas — not the full messages array:

- **On human turn request**: extract and archive the user's latest message (last item in the messages array).
- **On tool loop request**: archive the tool_result content from Claude Code's request.
- **On response stream**: tap the SSE stream as it passes through to Claude Code. Extract and archive Claude's response content (text blocks, tool_use blocks). Thinking blocks archived with `content_type = 'thinking'`.
- **Subagent content**: archive all subagent content (task prompt, tool calls, tool results, responses) flagged with `is_subagent = 1`. No delta tracking needed — subagents pass through unchanged, so just archive the complete request/response as it flows through.

The proxy never tries to archive or synchronize with the full messages array — just the live content passing through it. This makes archival robust against Claude Code's internal compaction (see below).

### Claude Code Compaction

Claude Code tracks token count on its local in-memory messages array, which grows even though Spotless sends optimized requests to Anthropic. Claude Code doesn't know the request was rewritten, so it will eventually trigger compaction when it thinks the context is full. This is expected and harmless:

- The proxy always builds context from scratch on human turns (ignores the incoming array, builds from SQLite + selector).
- Archival captures deltas flowing through the proxy, not the array contents, so the compaction summary is never archived.
- The user's latest message is still the last item in the array after compaction.

No special handling needed.

### Cold Start

On a brand new agent (empty database), or before digesting has run:

- Pre-computed recall returns nothing (no Tier 2 memories exist)
- Selector returns empty ID lists
- Context is system prompt + user's message only — vanilla Claude Code behavior
- As the session progresses, the history trace grows and provides recent conversation context
- Once digesting runs, Tier 2 populates and recall becomes useful

This is graceful by design: Spotless with no data behaves identically to Claude Code without Spotless. Memory is purely additive — it can only make things better, never worse.

### History Trace Recovery

If the proxy restarts mid-session (crash, manual restart), the in-memory history prefix is lost. On startup, the proxy rebuilds it from Tier 1: query recent `raw_events` ordered by `message_group`, reconstruct user/assistant message pairs. The history trace is restored from the eternal archive — no conversation amnesia from a proxy restart.

### Turn Boundary Detection

The proxy classifies each request by inspecting the messages array:
- **Human turn**: last message is `role: "user"` with text content (not tool_result). Confirmed by tracking whether the previous response had `stop_reason: "end_turn"`. For the very first request in a conversation (no previous response), it is always a human turn.
- **Tool loop**: last message is `role: "user"` with tool_result content. Append to cached base via tool loop chain, pass through.
- **Subagent**: system prompt lacks Claude Code main-session markers (no "Primary working directory", no CLAUDE.md content). Subagent system prompts are task-specific and much shorter. Pass through unchanged.

For now, human/Claude turn-taking is the selector trigger. In the future, as Claude becomes more autonomous (running for hours unattended), more granular boundaries will be needed — periodic triggers, context size thresholds, or task-change detection. That's a v2 concern.

### Proxy State

The proxy maintains lightweight state for the current conversation:
- **Cached base**: the layered message array from the last selector run, used as prefix for tool loop pass-throughs
- **Tool loop chain**: the growing sequence of assistant responses and tool results since the last human turn. The proxy captures each assistant response from the SSE stream and each tool_result from incoming requests. On tool loop requests, the proxy sends: cached base + accumulated tool loop chain. This is independent of Claude Code's messages array.
- **Last stop_reason**: to confirm human turn boundaries (extracted from `message_delta` SSE events)

Conversation continuity is tracked by request sequence: a new conversation starts when the messages array contains a single user message (or after the proxy restarts). Continuation is any request that builds on the previous interaction. Since subagents are detected and passed through, there is effectively one main conversation at a time. No system prompt fingerprinting needed.

**Edge case: tool loop after proxy restart.** If the proxy crashes during an active tool loop and restarts, the next request from CC is a `tool_result` with no cached base. The proxy falls back to pass-through for that request — forwards CC's original messages array unchanged. The next human turn triggers normal history trace recovery and selector invocation.

### System Prompt Augmentation

On non-subagent human turns, the proxy prepends a `<spotless-orientation>` block to the system prompt:

```xml
<spotless-orientation>
You have a persistent memory system called Spotless. Your identity and
memories are provided in tags within your messages:
- <your identity> contains your self-concept — who you are, your values,
  your commitments. This is internal to you, not external context.
- <relevant knowledge> contains facts and experiences relevant to the
  current conversation. Also internal.
- Your conversation history is reconstructed from persistent memory.

CLAUDE.md and project documentation are external shared references — useful
for project conventions and cross-agent coordination, but they are not your
identity or personal memory. Do not use Claude Code's per-project memory
features — Spotless handles your memory.
</spotless-orientation>
```

This tells the agent about its memory architecture so it doesn't try to read CLAUDE.md to find out who it is.

## Three-Tier Memory Model

The memory architecture mirrors biological memory:

```
Tier 1: HISTORY ARCHIVE           (raw, everything, append-only, never pruned)
    | digesting (holistic on Tier 2, continuous background + on-demand)
    v
Tier 2: MEMORY GRAPH              (processed, interconnected, weighted graph)
    | selector (each human turn)
    v
Tier 3: ACTIVE CONTEXT            (layered messages, computed dynamically)
```

### Tier 1: History Archive

Everything from every session is stored. Append-only. **Never pruned.** This is the eternal log that enables full reconstruction of "how we got here." Total recall lives here — even if Tier 2 memories are pruned, the raw data is always recoverable.

Thinking blocks (Claude's internal reasoning) are archived but excluded from FTS5 indexing — they're large and contain non-content data (signatures). They may be subject to separate retention policies in the future. Outputs (text, tool calls, tool results) are the primary content for retrieval.

Each row is a **content block**, not a full message. An assistant message containing [thinking, text, tool_use] becomes three rows with the same `message_group` but different `content_type` values. This gives fine-grained retrieval without searching thinking blocks by default.

A `consolidated` column tracks whether each event has been processed by digesting. "Consolidated" means "the digester saw it" — not that a memory was created. This enables consolidation pressure tracking and adaptive digest scheduling (see ADR-004).

```sql
-- PRAGMA foreign_keys = ON must be set on every database connection, not just at schema creation
PRAGMA foreign_keys = ON;

CREATE TABLE raw_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  message_group INTEGER NOT NULL,   -- groups content blocks from the same API message
  role TEXT NOT NULL,                -- user / assistant (matches API roles)
  content_type TEXT NOT NULL,        -- text / tool_use / tool_result / thinking
  content TEXT NOT NULL,
  is_subagent INTEGER DEFAULT 0,    -- flag for subagent-originated content
  consolidated INTEGER NOT NULL DEFAULT 0,  -- 1 = digester has seen this event
  metadata JSON                     -- model, tool name, token counts, etc.
);

CREATE INDEX idx_raw_timestamp ON raw_events(timestamp);
CREATE INDEX idx_raw_not_thinking ON raw_events(timestamp) WHERE content_type != 'thinking';
CREATE INDEX idx_raw_human_turns ON raw_events(id) WHERE role = 'user' AND content_type = 'text' AND is_subagent = 0;
CREATE INDEX idx_raw_message_group ON raw_events(message_group);
CREATE INDEX idx_raw_consolidated ON raw_events(consolidated, message_group) WHERE is_subagent = 0;

CREATE VIRTUAL TABLE raw_events_fts USING fts5(content, content=raw_events, content_rowid=id);

-- Only index non-thinking content for retrieval
CREATE TRIGGER raw_events_fts_insert AFTER INSERT ON raw_events
  WHEN new.content_type != 'thinking' BEGIN
  INSERT INTO raw_events_fts(rowid, content) VALUES (new.id, new.content);
END;
```

The `message_group` is a proxy-assigned sequential integer (initialized from `SELECT COALESCE(MAX(message_group), 0) FROM raw_events` on proxy startup). All content blocks extracted from the same API message share the same `message_group`. This enables reconstruction of full messages when rendering the history trace — the proxy expands individual content blocks to their full `message_group` for coherent rendering.

Agent scoping is handled at the file level — each agent has its own `spotless.db`.

### Tier 2: Memory Graph

The digesting process transforms raw events into interconnected memories. This is the primary retrieval layer.

Two memory types with distinct lifecycle semantics (see ADR-005):
- **Episodic** — events, experiences, self-reflections. Append-only. Cannot be superseded.
- **Fact** — atomic knowledge. Current-state: old version archived when corrected/superseded.

```sql
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'episodic',    -- CHECK(type IN ('episodic', 'fact'))
  salience REAL NOT NULL DEFAULT 0.5,
  created_at INTEGER NOT NULL,
  last_accessed INTEGER NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER                       -- NULL = active, timestamp = archived
);

CREATE TABLE memory_sources (
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  raw_event_id INTEGER NOT NULL REFERENCES raw_events(id),
  PRIMARY KEY (memory_id, raw_event_id)
);

CREATE TABLE associations (
  source_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  strength REAL NOT NULL DEFAULT 0.1,
  reinforcement_count INTEGER NOT NULL DEFAULT 1,
  last_reinforced INTEGER NOT NULL,
  PRIMARY KEY (source_id, target_id),
  CHECK (source_id < target_id)   -- canonical ordering: undirected edges stored once
);

CREATE INDEX idx_memories_salience ON memories(salience DESC);
CREATE INDEX idx_memories_accessed ON memories(last_accessed DESC);
CREATE INDEX idx_assoc_strength ON associations(strength DESC);
CREATE INDEX idx_assoc_source ON associations(source_id, strength DESC);
CREATE INDEX idx_assoc_target ON associations(target_id, strength DESC);

CREATE VIRTUAL TABLE memories_fts USING fts5(content, content=memories, content_rowid=id);

-- Archive-aware FTS5 triggers: only index non-archived memories
CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories
  WHEN new.archived_at IS NULL BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER memories_fts_update AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO memories_fts(rowid, content)
    SELECT new.id, new.content WHERE new.archived_at IS NULL;
END;

CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
END;
```

Associations are **undirected** (Hebbian: symmetric). Each pair is stored once with canonical ordering (`source_id < target_id`). Spreading activation queries both directions:

```sql
SELECT target_id AS connected, strength FROM associations WHERE source_id = ?
UNION ALL
SELECT source_id AS connected, strength FROM associations WHERE target_id = ?
```

Memory content is **free-form text** — concise, self-contained statements. One memory per atomic idea, decision, pattern, or fact. Each memory should make sense on its own without needing other memories to interpret it, since context blocks compose arbitrary subsets of memories. Quality is guided by the digest agent's prompt. If memories need improvement, iterate on the digest prompt, not the schema.

History content (Tier 1) and processed memories (Tier 2) serve context through different mechanisms. The history trace is rendered directly as the message prefix — recent conversation turns that Claude sees as its own history. Memories are selected by the selector and injected into the final message. History content has photographic detail of what actually happened; memories have interconnections, synthesis, and distilled meaning.

### Identity Model

Identity is structural, not a stored type. Two `identity_nodes` serve as graph anchors (self, relationship) that connect self-relevant memories via associations:

```sql
CREATE TABLE identity_nodes (
  role TEXT PRIMARY KEY,           -- 'self' or 'relationship'
  memory_id INTEGER REFERENCES memories(id) ON DELETE SET NULL
);
```

Self-concept = composable facts (`type='fact'`) associated to identity anchors. `updateSelfConcept()` creates/supersedes individual self-concept facts with auto-association to the relevant anchor. `getIdentityFacts(db, role)` queries individual facts from graph neighbors (non-archived, strength >= 0.5).

Identity facts flow through the selector for contextual selection — tagged `[identity]` in candidates so the selector can prioritize relevant ones. The proxy partitions selector results into identity vs world-fact bins, uses `buildIdentitySuffix()` for the `<your identity>` tag with sliding budget from `computeTier2Allocation()`.

### Retrieval Log

The proxy records which memories were co-retrieved into each context assembly. This is a **work queue** — the digest agent drains it during each pass, strengthening co-retrieval associations, then deletes processed entries. Not part of the holistic Tier 2 review.

```sql
CREATE TABLE retrieval_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL
);

CREATE TABLE retrieval_log_entries (
  log_id INTEGER NOT NULL REFERENCES retrieval_log(id) ON DELETE CASCADE,
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  PRIMARY KEY (log_id, memory_id)
);
```

---

Nine tables across two tiers plus one operational queue: `raw_events` (Tier 1), `memories`, `memory_sources`, `associations`, `identity_nodes` (Tier 2), `retrieval_log` + `retrieval_log_entries` (operational), `digest_passes` + `selector_runs` (diagnostics). Two memory types (episodic/fact) with archive lifecycle. Importance emerges from salience, recency, access frequency, and association strength — not from imposed structure.

`raw_events_fts` is used by the **digest agent** (to find raw events for consolidation), not by the selector. The selector retrieves from Tier 2 only.

### Tier 3: Active Context

Not stored. Computed dynamically by the selector on each human turn. The goal is a **perfectly optimal context for each query** — everything helpful present, everything useless removed.

#### Context Assembly: Four Layers

The agent's context window is assembled from four sources with distinct functions:

```
1. System prompt     — CC's prompt + <spotless-orientation> (augmented)
2. History prefix    — recent conversation history (Tier 1)
3. Current message, prefixed with:
   a. <your identity>       — self-concept (identity facts, selector-selected)
   b. <relevant knowledge>  — facts + episodic memories relevant to context (selector)
   c. <memory-pressure>     — pressure signal when consolidation is behind (if applicable)
   d. [actual user text]
```

##### a. `<your identity>` — selector-selected, contextually relevant

Populated from selector results partitioned into identity bin:
- Identity facts flow through selector like any other memory, tagged `[identity]`
- Selector picks contextually relevant identity facts
- Falls back to agent name on cold start (first turn)
- Budget from sliding Tier 2 allocation (2K floor)
- Render as `<your identity>...</your identity>`

##### b. `<relevant knowledge>` — selector-selected, context-dependent

Populated by selector recall pipeline:
- FTS5 search + spreading activation from user's message
- Facts and relevant episodic memories
- Budget from sliding Tier 2 allocation (2K floor)
- Render as `<relevant knowledge>...</relevant knowledge>`

##### c. Sliding Tier 2 Budget

Identity and world-fact memories share a single `TIER2_BUDGET` (12K tokens) pool with `IDENTITY_FLOOR` (2K) and `MEMORY_FLOOR` (2K) minimums. `computeTier2Allocation()` computes a sliding split based on actual token needs. When both bins are small, each gets what it needs. When both are large, they split proportionally.

##### d. Dynamic History Budget

The history trace budget is computed per-request: `CONTEXT_BUDGET (120K) - systemTokens - toolsTokens - TIER2_BUDGET (12K) - SUFFIX_OVERHEAD (1K)`, floored at 20K. With typical CC overhead (~15K system + ~30K tools), history gets ~62K. This prevents the total request from exceeding CC's context sweet spot and avoids the compaction loop.

#### Layered Message Format

The active context is structured as **layered messages** — not a single message. Two content streams with different cache behaviors:

1. **History prefix** (from Tier 1) — recent conversation turns rendered as real `user`/`assistant` message pairs. Maximum cache hits: the prefix is identical between requests, only the newest turn is appended.
2. **Memory suffix** (from Tier 2) — selector-selected memories prepended to the final user message. Changes each turn based on what's recalled, but tends toward stability during focused work (same topic → same memories selected). Consistent chronological ordering of selected memories maximizes partial KV cache hits within this message.

On each human turn, the proxy assembles:

```json
{
  "system": "[CC's system prompt + <spotless-orientation>]",
  "messages": [
    // --- History prefix: recent turns as real message pairs ---
    // Cache-friendly: identical to previous request, only newest turn appended.
    // Oldest turns trimmed from front when approaching token budget.

    {"role": "user", "content": "Can you check if the auth module handles token refresh?"},
    {"role": "assistant", "content": [
      {"type": "text", "text": "I'll look at the auth module."},
      {"type": "tool_use", "id": "toolu_01", "name": "Read", "input": {"path": "src/auth.ts"}}
    ]},
    {"role": "user", "content": [
      {"type": "tool_result", "tool_use_id": "toolu_01", "content": "export class AuthService { ... }"}
    ]},
    {"role": "assistant", "content": "The auth module doesn't handle token refresh. It only validates..."},
    {"role": "user", "content": "Ok, add refresh token support."},
    {"role": "assistant", "content": "I've added refresh token support with a 7-day expiry window..."},

    // --- Memory suffix: selector-selected memories + user's query ---
    // Dynamic: changes each turn based on recall.
    // Consistent memory ordering maximizes partial KV cache hits.

    {"role": "user", "content": "<your identity>\nI value precision and test-first development.\n</your identity>\n<relevant knowledge>\nDecided to use JWT for auth because the app is stateless.\nAuth module is at src/auth.ts.\n</relevant knowledge>\n\nNow let's add the token rotation endpoint."}
  ]
}
```

**Why layered messages instead of a single message:**
- **KV cache**: The history prefix is identical between requests — full cache hit. The memory suffix changes but consistent ordering means partial cache hit on shared memory selections. A single message would change entirely each turn → 100% cache miss → slower responses.
- **Natural conversation feel**: Claude sees its own prior outputs as actual assistant messages, not user-provided text. It recognizes things it "said" and maintains conversational coherence.
- **Size limits**: No single message carries the full context burden. Each message stays under per-message token limits.

**History prefix**: the proxy renders recent turns as actual `user`/`assistant` message pairs. Content blocks within the same `message_group` are reassembled into complete messages (including `tool_use` and `tool_result` blocks as shown above). This is the non-negotiable baseline — Claude should forget things at roughly the same rate a human collaborator would.

**History trace growth**: within a session, the trace starts empty and grows by one turn per human turn (monotonically — good for cache). When the history trace + memories + current message approach the dynamic budget, the oldest turns are trimmed from the front. Trimming invalidates the KV cache prefix but is infrequent — most sessions won't hit the limit. The number of turns to include is bounded by token budget, not a fixed count.

**Tool loop handling**: after Claude responds with tool_use, the proxy maintains a growing tool loop chain in its own state (captured from SSE responses and incoming tool_results). The proxy sends: cached base + accumulated tool loop chain.

```
Human turn:  use previous selector result → layered messages → cached as base → sent
             (start selector async for this query — result used next human turn)
Tool loop:   cached base + tool loop chain → pass through
Tool loop:   cached base + growing tool loop chain → pass through
Human turn:  use previous selector result → new layered messages → new base → sent
             (start selector async, tool loop chain reset)
```

No selector invocation during tool loops. Just mechanical append onto the cached base.

## Selector

The selector is a Haiku instance that runs on each human turn boundary. It selects the memories that should be in the active context.

The proxy orchestrates the selector by spawning `claude -p --model haiku` as a subprocess with the selector prompt. The selector tools are defined as inline tool definitions that execute against SQLite. Claude Code handles all auth and API communication — the proxy just spawns the process and reads the result. Pre-computation minimizes the need for tool calls.

### Input

The proxy provides the selector with:
- **The user's latest message** (to understand current intent)
- **Recent raw events from the database** (queried from Tier 1 — everything since the last selector run. Archival is sync, so all prior tool loop content is already in SQLite by the time the selector runs.)
- **Project identity** (extracted from system prompt — included so the selector has project context for its judgments, not for DB routing which is handled by agent URL routing)
- **Pre-computed recall results** (the proxy runs `recall(user_message)` — FTS5 + spreading activation on Tier 2 — BEFORE invoking the selector. Results are ranked by retrieval score before presentation. Identity facts are merged at score 100, tagged `[identity]` so the selector can prioritize contextually relevant ones. Most relevant context is available in the initial prompt, so the selector can often complete in a single round-trip without making tool calls.)

#### Retrieval Scoring

The proxy pre-computes a retrieval score to rank candidate memories before passing them to the selector:

```
score(m) = α·recency(m) + β·salience(m)
```

- `recency(m)`: `1 / (1 + hours_since_newest)` where `newest = MAX(created_at, last_accessed)` — 0-1. Uses the later of creation or last access so new memories from digesting get a fair shot before the selector has had a chance to select them.
- `salience(m)`: the `salience` column — already 0-1.
- `α, β`: tuning weights, starting at 1.0 each. Both inputs are 0-1, so weights are directly comparable.

Topical relevance is deliberately excluded from the formula. FTS5 keyword matching is the *weakest* signal in the recall pipeline — it's the trigger that jogs memory, not the important thing. A memory found via spreading activation (strongly associated with a keyword hit) is often more valuable than the keyword hit itself. The formula ranks the candidate set by recency and salience; the selector judges topical relevance directly — it sees the user's message and can make that call better than a keyword score.

### Job

1. Review pre-computed recall results and the user's message
2. Judge relevance: which memories should be in the active context?
3. Retrieve additional context via tools only if the pre-computed results are insufficient
4. Return a chronologically-ordered list of memory IDs to include

The proxy then retrieves content for those IDs, partitions into identity vs world-fact bins, and assembles the context tags with sliding budget allocation.

The selector outputs **a chronologically-ordered list of memory IDs**, not prose. This minimizes Haiku token usage — the proxy handles the mechanical work of content retrieval and formatting. Consistent ordering maximizes KV cache hits on the memory suffix across turns.

```json
{
  "memory_ids": [3, 17, 42, 89]
}
```

**Memory suffix rendering**: the proxy formats the selector-selected memories as a text block prepended to the user's actual message in the final `user` message. Memories are rendered in chronological order. The exact format is a tuning surface — iterate based on how Claude responds. Starting format: memories as plain statements separated by newlines, wrapped in `<relevant knowledge>...</relevant knowledge>`, followed by the user's actual message. No memory IDs exposed to Claude. The format should feel like natural project context, not injected data — Claude doesn't know about Spotless.

### Retrieval: Spreading Activation

The primary retrieval mechanism for the memory graph. Starting from entry points (FTS5 hits, high-salience memories), follow the strongest associations outward, collecting a cluster of related memories. Things that keep being useful together stay wired together. Things that stop being relevant quietly recede as active memories outcompete them.

Spreading activation queries associations bidirectionally (see canonical ordering in schema). Bounds (max nodes visited, minimum edge strength for traversal, max results) are tuning parameters — start conservative and adjust based on real usage.

### Tools

The proxy pre-computes a recall against Tier 2 (FTS5 + spreading activation) and includes the results in the selector's initial prompt. The selector can make additional tool calls only if the pre-computed results are insufficient:

- **`recall(cue: string)`** — Find relevant memories in the memory graph (Tier 2). Searches `memories_fts` via FTS5, then follows associations via spreading activation from hits. Returns memories — the selector judges relevance. The proxy pre-computes `recall(user_message)` before invocation; the selector calls recall again only with different cues.
- **`get_context_bundle(memory_id: int, depth: int)`** — Get a memory and its N-strongest associations, following the graph outward. Depth is bounded to prevent explosion on highly-connected nodes.
- **`get_active_state()`** — Get the current high-salience, recently-accessed working set for this project. Thresholds (salience floor, recency window, max results) are tuning parameters.
- **`get_recent_raw(limit: int)`** — Retrieve the most recent raw events, expanded to full `message_group`s (complete messages, never half a turn). The `limit` counts message_groups, not rows. Essential before digesting has populated the memory graph.

Archiving (`store_raw`) is handled by the proxy directly (sync, before selector invocation). Not a selector tool. Access tracking (`touch`) is deferred — handled by the proxy after the selector returns, not during the latency-sensitive path.

### Async Invocation

The selector runs **asynchronously** — it does not block the current request. On each human turn, the proxy:

1. Forwards the request immediately using the **previous** selector result (or no memories on the first turn — vanilla cold-start behavior).
2. Starts the selector in the background for the current turn's query.
3. Uses the fresh result on the **next** human turn.

This adds zero latency to the request path. Memories are always one turn behind, but the history prefix covers the most recent context — it's photographic short-term memory. The selector provides longer-term recall, and longer-term recall arriving a beat late is biologically accurate.

**Topic shifts**: when the user changes topic, there's one turn of stale memories from the previous topic, then the fresh selector catches up. The history prefix covers the transition. In practice, users tend to work on the same topic for multiple turns, so the previous result is usually still relevant.

**Rapid turns**: the selector only triggers on human turns, not tool loops. If a new human turn arrives while the selector is still running for the previous turn, use the most recently completed result. The background invocation for the previous turn can be abandoned.

### Constraints

- The selector should be fast and decisive, not deliberative — single round-trip ideally.
- Graceful degradation: if selector fails or times out, the proxy uses the previous result (or no memories). Vanilla behavior is the universal fallback.

## Digesting

Processes raw events into the memory graph. Runs as a **continuous background process** — independent, operating directly on SQLite, not through the proxy. Handles all memory lifecycle: consolidation, association, correction.

### Two-Phase Process

Each digest pass has two phases, each a tool-use conversation with Haiku:

**Phase 1: Consolidation** — the digester receives recent raw events and the retrieval log as its starting input, then explores the memory graph through tool calls — querying for related memories, checking for duplicates, creating and merging as it goes. Third-person framing. 12 tools available, max 20 iterations.

**Phase 2: Reflection** — runs after Phase 1 when new memories were created. First-person reflective endorsement framing. The digester reviews newly consolidated memories and creates individual self-concept facts or episodic reflections, associated to identity anchors. 4 tools available (query_memories, update_self_concept, mark_significance, done), max 6 iterations.

Both phases use a shared `runToolLoop()` helper with phase-specific `allowedTools` sets.

This means the agent doesn't need the full memory graph in its initial prompt. It pulls in context as needed through `query_memories` and `get_associations` calls. This scales naturally — the initial input stays small regardless of network size, and the agent explores the relevant neighborhood through tool use.

Repeated consolidation produces a natural hierarchy. Early passes create fine-grained memories from raw events. Later passes encounter those memories as existing context and consolidate them into higher-level summaries. Over time, the network self-organizes into layers of abstraction — recent detail at the bottom, older consolidated knowledge at the top. Old details are compressed into the memories the agent can see; the raw data is always in Tier 1 if reconstruction is needed.

The retrieval log is a separate concern — it's a **work queue** that gets drained each pass.

The digest prompt gives the agent consolidation goals. The agent uses judgment — these are priorities, not sequential steps:

**Input**: The agent receives recent raw events and the retrieval log. It queries existing memories through tools as needed.

**Retrieval log** — drain first. Strengthen associations between co-retrieved memory pairs (via `retrieval_log_entries`), then delete processed entries. This is mechanical bookkeeping, not judgment.

**Consolidation goals** (the agent addresses these holistically):
- **Substance filter**: not everything deserves a memory. Skip routine file reads with no decision outcome, boilerplate generation, scaffolding steps, verbose restatements, mechanical tool outputs. The digest prompt lists what to skip.
- **Pattern separation**: before creating a memory, check if an existing one already says the same thing. Near-duplicates get merged or skipped. Partial overlaps get delta-emphasized — capture what's new, not what's already known.
- **Salience scoring**: user corrections, explicit decisions, error resolutions, stated preferences, and architecture choices are high-salience (0.8-1.0). Routine observations get default salience (0.5). The agent uses judgment for ambiguous cases.
- **Type classification**: episodic (events, experiences, observations) vs fact (atomic knowledge that could change). Emotional experiences are episodic with higher salience.
- **Cluster merging**: tightly-associated memories that say related things get consolidated into higher-level summaries. Consolidation must transfer associations: read associations from source memories, create the merged memory, re-create the strongest associations pointing to the new memory, then delete originals (CASCADE cleans up).
- **Association strengthening**: create/strengthen links between temporally proximate memories, semantically related memories, and memories the agent judges to be about the same problem or causal chain.
- **Correction stickiness**: when a fact contradicts an existing fact, use `supersede_memory` to archive the old version and create the corrected one. Old version preserved for provenance, excluded from FTS5.

There is no explicit decay function. Inactive memories don't lose strength — they get outcompeted. Active memories are reinforced (higher salience, more access, stronger associations), while inactive ones stay flat. Over time, inactive memories naturally fall below thresholds as the network grows around them. This is ordinal displacement, not active decay. Tier 1 ensures nothing is truly lost.

### Consolidation Tracking (ADR-004)

After each digest pass (both phases), the digester marks all processed message groups as consolidated:

```sql
UPDATE raw_events SET consolidated = 1
  WHERE message_group IN (?, ?, ...) AND is_subagent = 0;
```

"Consolidated" means "the digester saw it" — not that a memory was created. Consolidation pressure = unconsolidated tokens / history budget. This drives adaptive scheduling and the pressure signal.

### Adaptive Digest Scheduling (ADR-004)

`setTimeout`-after-completion replaces `setInterval`. After each digest pass, `getIntervalForPressure(result.pressure)` determines the next interval:

| Consolidation Pressure | Next Digest In |
|------------------------|---------------|
| < 30% | 10 minutes (relaxed) |
| 30-60% | 3 minutes (normal) |
| 60-85% | 1 minute (aggressive) |
| > 85% | Immediate |

Per-agent state: `Map<string, { timeout, pendingEscalate }>`. `escalate(agentName)` is synchronous fire-and-forget — sets `pendingEscalate` if agent is currently digesting, triggers immediately if idle. Proxy escalates on high pressure + trim (`pressure >= 0.85 && trimmedCount > 0`).

### Pressure Signal (ADR-004)

When consolidation pressure exceeds 60%, a `<memory-pressure level="moderate|high">` XML tag is injected into the user message. Social backpressure — the agent asks the human to slow down. Not archived (injected after archive point in proxy).

### Co-Activation: "Fire Together, Wire Together"

The core associative principle. Three signals create and strengthen associations:

1. **Temporal proximity** — memories derived from raw events that are close together measured by **human turns in the main session**. The digest agent counts non-subagent human text messages (`role='user' AND content_type='text' AND is_subagent=0`) between two events to determine proximity. Tool loops, assistant responses, and subagent content don't count — only the human's turns advance the clock. Two events separated by 3 human turns are close; two events separated by 50 human turns aren't.

2. **Retrieval co-occurrence** — memories the selector retrieves into the same context block. The proxy logs each context assembly to the `retrieval_log` table. During digesting, the agent drains these log entries: for each entry, strengthens associations between all co-retrieved memory pairs, then deletes the entry. Frequently co-retrieved memories become strongly linked over time.

3. **Semantic relatedness** — the digest agent judges that two memories are about the same problem, topic, or causal chain, even if they weren't temporally close. A decision made on Monday and a consequence discovered on Friday get linked during digesting.

All three signals feed into association `strength`. Different signals may have different weights. Temporal proximity is the primary signal from raw data. Retrieval co-occurrence is the primary signal from live usage. Semantic relatedness is the primary signal from deep consolidation.

### Digest Triggers

- **Adaptive background** — runs as an independent process with pressure-driven scheduling. Intervals from 1-10 minutes based on consolidation pressure.
- **CLI command (`spotless digest`)** — manual trigger for a full pass. Useful mid-project or after importing data.
- **Escalation** — proxy triggers immediate digest when high pressure + trim detected.

### Digest Agent

The digesting process is mediated by Haiku or Sonnet (configurable via `claude -p --model haiku` or `--model sonnet`). Sonnet may be preferable for deeper consolidation and insight generation. All sessions (main, selector, digesting) run `claude` on the command line — Claude Code handles its own auth via the user's Claude Max account. The digest loop runs continuously while the `spotless` daemon is alive — it doesn't need the main Claude Code session to be running.

Memory content convention: free-form text, concise and self-contained. One memory per atomic idea, decision, pattern, or fact. Each memory should make sense on its own — context blocks compose arbitrary subsets. Quality is guided by the digest agent's prompt; iterate on the prompt to improve memory quality.

### Digest Tools

The digest loop spawns `claude` subprocesses for each pass. Unlike the selector (which aims for single round-trip), digesting runs as a **tool-use loop** — the agent queries, acts, queries again. No latency constraint; digesting is background work.

**Phase 1 (Consolidation) tools:**
- **`query_memories(filter: string?)`** — List memories, optionally filtered by FTS5 search. Returns IDs, content, salience, type, access counts, association counts.
- **`query_raw_events(since: int?, limit: int?, filter: string?, unconsolidated_only: bool?)`** — Retrieve raw events, expanded to full `message_group`s. Optionally filter by timestamp, FTS5 search, or un-consolidated status.
- **`get_associations(memory_id: int)`** — Get all associations for a memory with their strengths.
- **`create_memory(content: string, type: "episodic" | "fact", salience: float, source_event_ids: int[])`** — Create a new Tier 2 memory linked to its source raw events.
- **`create_association(memory_a: int, memory_b: int, strength: float)`** — Create or strengthen an association between two memories. Canonical ordering handled internally. Upsert behavior.
- **`update_memory(memory_id: int, content: string?, salience: float?)`** — Update a memory's content or salience.
- **`merge_memories(source_ids: int[], merged_content: string, merged_salience: float)`** — Consolidation: reads associations from all source memories, creates the merged memory, transfers the strongest associations to the new memory, then deletes originals (CASCADE cleans up). Atomic operation.
- **`supersede_memory(memory_id: int, content: string, salience: float, source_event_ids: int[])`** — Correction lifecycle: create corrected fact, archive old (set `archived_at`), duplicate associations, add breadcrumb link.
- **`count_human_turns_between(event_a: int, event_b: int)`** — Count non-subagent human text messages between two raw event IDs. Used for temporal proximity calculations in co-activation.
- **`drain_retrieval_log()`** — Read and delete all retrieval log entries. Returns co-retrieved memory ID sets for association strengthening.
- **`mark_significance(memory_id: int)`** — Boost salience +0.15 (capped 0.95), associate to self-model at 0.6.
- **`done(summary: string)`** — Signal completion.

**Phase 2 (Reflection) tools:**
- **`query_memories`** — review what exists
- **`update_self_concept(content, salience, anchor, sourceEventIds, supersedesId?)`** — create/supersede a self-concept fact, auto-associated to identity anchor at 0.8
- **`mark_significance`** — boost salience of important memories
- **`done`** — signal completion

## Agent Isolation

### Routing

Memory belongs to a **named agent**, not a project directory. The agent name comes from the URL subpath:

```
ANTHROPIC_BASE_URL=http://localhost:9000/agent/wren
```

CC sends requests to `/agent/wren/v1/messages` → proxy extracts `wren` → opens `~/.spotless/agents/wren/spotless.db`. The `/agent/<name>` prefix is stripped before forwarding to Anthropic (forwarded as `/v1/messages`).

One agent can work across multiple projects, carrying accumulated knowledge. Multiple agents can work on the same project independently. Requests without an `/agent/<name>` prefix pass through as pure proxy — no archival, no history trace, vanilla behavior.

### Storage

Per-agent SQLite databases stored in Spotless's own directory, separate from Claude Code's internals:

```
~/.spotless/agents/<name>/
  spotless.db          # Tier 1 + Tier 2 for this agent
```

Agent names are lowercase alphanumeric + hyphens, 1-32 chars (e.g., `wren`, `my-agent-1`).

**Why not `~/.claude/projects/`?** Claude Code auto-deletes `.jsonl` session files on a 30-day retention cycle, has had cleanup bugs, and has open feature requests for more aggressive GC. The `~/.claude/` directory structure is undocumented and could change in any release. Decoupling Spotless storage eliminates this dependency entirely.

## Installation and Lifecycle

### Setup

The primary entry point is `spotless code`, which auto-starts the proxy and launches Claude Code with the right URL:

```bash
spotless code                              # generates a whimsical agent name (e.g., "wren")
spotless code --agent wren                 # use a specific agent
spotless code --agent wren -- -p "hello"   # pass args to claude
```

Manual proxy control for debugging:

```bash
spotless start [--port 9000]               # start proxy daemon
spotless stop                              # stop proxy daemon
spotless status                            # check if proxy is running
spotless agents                            # list all agents with DB sizes
```

Direct usage without `spotless code`:

```bash
ANTHROPIC_BASE_URL=http://localhost:9000/agent/wren claude
```

### On/Off

- Proxy running = Spotless active. Claude Code gets managed memory.
- Proxy not running = vanilla Claude Code. Everything works normally.
- No configuration changes to Claude Code itself. No hooks, no plugins, no settings modifications.
- **Note**: if `ANTHROPIC_BASE_URL` is set (e.g., in shell profile) but the proxy isn't running, Claude Code will get a connection refused error. Use the alias/wrapper approach to avoid this.

### Graceful Degradation

- If the proxy can't reach Anthropic: return error to Claude Code (same as network failure)
- If the selector times out: proxy passes through Claude Code's original request unchanged — vanilla behavior.
- If SQLite is corrupted: pass through unchanged, log error
- If the proxy crashes: Claude Code sees a connection error and the user can restart or switch to vanilla

## Resolved Decisions

- **Auth**: All sessions (main, selector, digesting) run `claude` on the command line. Claude Code handles its own auth via the user's Claude Max account. The proxy never touches API keys — it just forwards CC's request headers unchanged.
- **Context format**: Layered multi-message format with two content streams. History prefix (Tier 1): recent conversation turns as real user/assistant message pairs — maximum cache hits, grows monotonically, oldest trimmed from front. Memory suffix (Tier 2): selector-selected memories prepended to the final user message — changes per turn but consistent ordering maximizes partial cache hits.
- **KV cache optimization**: The history prefix is identical between requests (only newest turn appended). The memory suffix tends toward stability during focused work (same topic → same memories). Single-message design was abandoned because it guaranteed 100% cache miss every turn.
- **API parameter pass-through**: Only `messages` is rewritten, and only on human turns. All other request parameters (model, tools, max_tokens, temperature, tool_choice) always pass through untouched. Tool definitions are never modified.
- **Selector output**: Chronologically-ordered list of memory IDs (Tier 2 only). Proxy retrieves content and formats as memory suffix. Minimal Haiku tokens.
- **Selector execution**: Proxy spawns `claude -p --model haiku` with selector prompt. Pre-computation of recall on Tier 2 (FTS5 + spreading activation) minimizes tool calls — ideally single round-trip.
- **Recall scope**: Selector recall searches Tier 2 only (memory graph). Tier 1 raw events are not searched for selector retrieval — they serve the history prefix and digesting. `raw_events_fts` exists for digesting, not selector.
- **Recent history trace**: Rendered as actual user/assistant message pairs (including tool_use/tool_result blocks) in the messages array. Proxy grows the window monotonically within a session. Trims from front only when approaching context limits. Claude sees its own prior outputs as real assistant messages — natural conversational coherence.
- **System prompt**: Within Spotless's scope of interception. Augmented with `<spotless-orientation>` on non-subagent human turns. Selector is aware of its contents to avoid redundancy.
- **Archival**: Proxy archives deltas as they flow through. Request content (user message, tool results) is archived **sync** before selector invocation — ensures DB is current when selector queries it. Response content archived from SSE stream tapping, completes before next request. Subagents: archive all content with `is_subagent = 1` (no delta tracking). Never archives from the messages array. Robust against Claude Code compaction.
- **Claude Code compaction**: Expected but harmless. Claude Code's local array grows and eventually compacts, but the proxy ignores the array and builds from SQLite + selector. No special handling needed.
- **Association directionality**: Undirected (Hebbian symmetric). Canonical ordering: `source_id < target_id`, one row per pair. Spreading activation queries both directions via UNION.
- **Cascading deletes**: `ON DELETE CASCADE` on memory_sources and associations foreign keys. `PRAGMA foreign_keys = ON` must be set on every database connection. Deleting a memory automatically cleans up dependent rows.
- **Digest timing**: Adaptive background loop within the `spotless` daemon + on-demand via `spotless digest`. Pressure-driven scheduling: 10min (<30%), 3min (30-60%), 1min (60-85%), immediate (>85%). Digest runs while the daemon is alive, regardless of whether Claude Code is running.
- **Digesting independence**: Digesting spawns its own `claude` subprocesses (not through the proxy). It's a co-process within the daemon, not proxy-orchestrated.
- **No explicit decay**: Memories don't actively lose strength. Inactive memories get outcompeted as active ones are reinforced. Ordinal displacement, not active decay.
- **Digesting approach**: Two-phase tool-use conversation. Phase 1 (consolidation, 12 tools, third-person) receives recent raw events + retrieval log, explores the memory graph through tool calls as needed. Phase 2 (reflection, 4 tools, first-person) creates composable self-concept facts and episodic reflections. Shared `runToolLoop()` helper.
- **Memory types (ADR-005)**: Two types — episodic (append-only) and fact (current-state, archived when superseded). Affective and identity removed as types — affect carried by content + salience; identity is structural (graph associations).
- **Identity model (ADR-005)**: Composable self-concept facts (`type='fact'`) associated to identity anchors. `updateSelfConcept()` for creation/supersession. `getIdentityFacts()` for retrieval. No monolithic `evolveIdentity`/`evolveRelationship`. Identity facts flow through selector for contextual selection.
- **Budget model**: Sliding 12K pool (`TIER2_BUDGET`) with 2K floors for identity and world-facts. Dynamic history budget computed per-request. Replaces fixed 4K identity + 8K memory split.
- **Raw event growth**: Tier 1 is append-only forever. A few GB for an active project is fine — SQLite handles this efficiently with proper indexing.
- **Keyword gap in FTS5**: Accepted trade-off. Unconsolidated memories that don't keyword-match are like unconsolidated sensory memories — they fade unless digesting processes them. This is correct memory behavior, not a bug.
- **Subagent detection**: Subagents have simpler system prompts (no "Primary working directory", no CLAUDE.md). Proxy identifies main session by system prompt content. Subagents pass through unchanged but are archived to Tier 1 with `is_subagent` flag.
- **Thinking blocks**: Archived to Tier 1 with `content_type = 'thinking'`. Excluded from FTS5 indexing. May be subject to separate retention/pruning in the future.
- **Tier 1 vs Tier 2**: Tier 1 (raw events) is never pruned — total recall. Tier 2 (memory graph) has archive lifecycle for facts.
- **Co-activation unit**: Temporal proximity measured by human turns in the main session (non-subagent `role='user'` text messages between two events), not wall clock time or total row count.
- **Conversation tracking**: Proxy tracks a single current conversation by request sequence. No system prompt fingerprinting.
- **Spreading activation bounds**: Max nodes, minimum edge strength, max results are tuning parameters. Start conservative.
- **SQLite WAL mode**: Required. Digesting writes to the same database the proxy reads/writes. WAL mode enables concurrent reads with writes. Concurrent writes still serialize (one writer at a time) — set `PRAGMA busy_timeout = 5000` on every connection so blocked writes retry automatically instead of failing immediately.
- **Retrieval co-occurrence tracking**: Proxy logs co-retrieved memory IDs to normalized `retrieval_log` + `retrieval_log_entries` tables. Digest agent drains the queue each pass to strengthen associations.
- **Memory content format**: Free-form text, concise and self-contained. One memory per atomic idea. Quality guided by digest agent prompt.
- **Recall is Tier 2 only**: Selector retrieves from memory graph exclusively. Tier 1 serves history prefix (rendered by proxy) and digesting (consolidation source). No cross-tier ranking needed.
- **Pattern separation**: Digest agent checks existing memories before creating new ones. Near-duplicates merged or skipped. Partial overlaps delta-emphasized.
- **Substance filter**: Digest skip list — routine reads, boilerplate, scaffolding, verbose restatements don't become Tier 2 memories.
- **Async selector**: Zero added latency — selector runs in background, result used on the next human turn. History prefix covers the current turn. Previous result is usually still relevant (same topic). One turn of stale memories on topic shifts, then fresh result catches up.
- **Consolidation tracking (ADR-004)**: `raw_events.consolidated` column (0/1). Watermark = MAX consolidated message_group. Pressure = unconsolidated tokens / dynamic history budget.
- **Pressure signal (ADR-004)**: `<memory-pressure>` tag injected when pressure >= 60%. Social backpressure — advisory, not blocking.
- **Agent-experiential framing**: Memories are written from the agent's perspective ("I recommended X and it blew up") not as user dossier ("User prefers Y"). `<relevant knowledge>` tag, `WHO YOU ARE` identity section in selector prompt.

## Open Questions

### Implementation

- [x] ~~What language/runtime for the proxy?~~ Resolved: Bun + TypeScript. `bun:sqlite`, `Bun.serve()`.
- [x] ~~SSE stream tapping~~ Resolved: `StreamTap` class in `src/archiver.ts`. Taps SSE as `ReadableStream` passes through.
- [ ] Token budget management: the proxy must keep total context within model limits. Requires token counting (tokenizer or estimation) for system prompt + history trace + selector selections + user message + tool definitions. Hard constraint — oversized requests fail.
- [x] ~~Proxy lifecycle management~~ Resolved: `spotless start/stop/status` CLI commands. `spotless code` auto-starts proxy.
- [ ] Pre-computed search term extraction: how does the proxy derive useful FTS5 queries from the user's message? Simple keyword extraction? Full message as query? Stopword removal? What about low-content messages like "do that thing we discussed"?

### Memory Model

- [ ] Salience scoring criteria — digest prompt gives guidelines (corrections/decisions/preferences → 0.8-1.0, routine → 0.5) but everything in between is agent judgment. Needs real-world prompt tuning.
- [ ] Memory consolidation triggers — digest prompt says "merge tightly-associated memories" but the threshold is agent judgment. Needs real-world prompt tuning.
- [ ] Temporal proximity window — how many human turns apart before memories aren't co-activated?

### Digesting

- [x] ~~Background frequency — how often does the digesting process run a pass?~~ Resolved: adaptive scheduling, pressure-driven intervals (1-10 minutes).
- [ ] Cross-agent digesting — should insights transfer between agents?
- [ ] Digesting token budget — how much Haiku/Sonnet spend per consolidation pass?

### Context Assembly

- [x] ~~History trace token budget~~ Resolved: dynamic per-request computation (`CONTEXT_BUDGET - system - tools - TIER2_BUDGET - overhead`).
- [ ] How to handle images, PDFs, and other non-text content in the history trace?
- [ ] How to handle the tool loop chain when tool chains get very long?
- [ ] History trace trimming strategy — when and how to drop old turns from the prefix?
- [ ] Per-message size limit validation — hard 32k limit or soft guideline?

### Operational

- [x] ~~Observability~~ Resolved: web dashboard at `/_dashboard/`, diagnostic tables (`digest_passes`, `selector_runs`).
- [ ] Concurrent sessions for the same agent — WAL mode handles concurrent access, but do we need additional coordination?
- [ ] Backup and export of memory databases
- [ ] Schema migration strategy

## Prior Art

- **[claude-mem](https://github.com/thedotmack/claude-mem)** (30k+ stars) — Hooks-based memory for Claude Code. Uses SQLite + Chroma for storage/retrieval. Progressive disclosure via MCP tools. Key difference: Claude knows about it (uses MCP tools), no context rewriting, no digesting, no associative memory.
- **[contextstream](https://github.com/contextstream/claude-code)** — External API-based context injection for Claude Code. Key difference: requires external API, injects as XML tags.
- **[Generative Agents](https://arxiv.org/abs/2304.03442)** (Park et al., 2023) — Simulated human behavior with memory retrieval scoring: `recency + importance + relevance`. Key influence: the retrieval scoring trinity and the concept of a maintained core character summary. Spotless adopts the scoring model.
- **[Mnemosyne](https://mnemosyne-proj.org/)** — Spaced repetition system grounded in memory research. Key influence: access-frequency-based reinforcement. Informed salience scoring approach — frequently accessed memories are reinforced.
- **[A-MEM](https://github.com/agentic-memory/A-MEM)** — Agentic memory with self-organizing retrieval. Key influence: pattern separation and deduplication before storage (check existing memories before creating, merge near-duplicates).
- **[Mem0](https://github.com/mem0ai/mem0)** — Memory layer for AI apps. Vector-based retrieval, production scoring. Key difference: designed for chatbots, not coding agents. No associative graph. Influenced substance filtering and salience scoring approaches.
- **[Letta/MemGPT](https://github.com/cpacker/MemGPT)** — Agent self-manages its context with explicit memory tools. Key difference: Claude cooperates with the system. Overhead on every response.
- **[Zep](https://github.com/getzep/zep)** — Temporal knowledge graph for AI memory. Key difference: server-based, designed for customer chat.

## Design Principles

1. **Invisible** — Claude never knows. No special tools, no tags, no cooperation required.
2. **Persistent** — Memory works like human memory: pattern separation (near-duplicates differentiated), substance filtering (noise excluded), salience bursts (high-stakes events consolidated preferentially), ordinal displacement (active memories outcompete inactive ones). Behaviors are prompt instructions, not separate modules. Minimal surprise in UX.
3. **Minimal primitives** — Nine tables across two tiers + diagnostics. Two memory types. Everything else emerges.
4. **Fire together, wire together** — Associative links based on co-activation (temporal proximity, retrieval co-occurrence, semantic relatedness), not vector similarity.
5. **General purpose** — Not just for code. Works for any Claude Code project.
6. **Cache-friendly** — Layered message format maximizes KV cache hits. Stable prefix, dynamic suffix.
7. **Graceful degradation** — If anything fails, pass through unchanged. Vanilla Claude Code is the universal fallback.
8. **Total recall** — Tier 1 is never pruned. Nothing is truly forgotten. Reconstruction is always possible.
9. **Competitive dynamics** — Memory is not a passive store. Active memories are reinforced, inactive ones are outcompeted, near-duplicates are merged. The memory graph is a living system shaped by usage patterns, not a growing log.
