# ADR-006: Fractal Context Composition

**Status:** Proposed
**Date:** 2026-03-19
**Related:** ADR-004 (history consolidation), ADR-005 (memory architecture), Sprint 11 (Aperture)

## Context

### The Problem

Spotless's history trace (`buildHistoryTrace`) replays raw conversation chronologically, trimming from the front when the budget is exceeded. With `DEFAULT_CONTEXT_BUDGET = 500_000` (for 1M context models), the dynamic history budget reaches ~404K tokens. Every human turn sends ~500K tokens to the API — regardless of whether the turn is a simple "yes" or a complex architectural question.

This has three compounding costs:

1. **Quota burn.** ~500K input tokens per turn × 20 turns/session = ~10M tokens/session. With 1M context models, this exhausts Claude Max quotas rapidly.

2. **Quality degradation.** The "lost in the middle" problem (Liu et al., TACL 2024): models miss information in the middle third of long contexts. 450K of chronological history means most context is in the low-attention zone. More context is actively worse than less, better-curated context.

3. **Wasted replay.** Tool results (file reads, grep outputs, bash results) dominate history volume. A 500-line file read is 5-10K tokens in the history trace. On subsequent turns, that file content is replayed verbatim even though the agent already processed it and extracted what it needed.

### What Exists Today

- `buildHistory(db, budget, agentName)` reads all non-subagent, non-thinking raw_events, reconstructs user/assistant pairs with tool pairing validation, enforces alternation, and trims from the front.
- `trimTobudget(messages, budget)` drops oldest messages first, returns `trimmedCount`.
- Tier 2 memories (selector-selected) are injected as a suffix on the current user message.
- The proxy caches the rewritten messages as `state.cachedBase` for tool loop requests.

### Design Constraint: The 1M Window Is a Capability

The goal is NOT to shrink the effective context window. The goal is to use it intelligently — lean for routine turns, expansive when the moment demands it. An agent that always uses 500K is wasteful. An agent that always uses 60K is handicapped. The right answer is elastic: the context expands and contracts based on what the current turn actually needs.

## Decision

### 1. Exchange as the Compositional Unit

An **exchange** is a human turn + the agent's complete response cycle (including tool loops), bounded by:

- **Start:** A `human_turn` classification (when `resetForHumanTurn()` is called)
- **End:** The message_group immediately before the next `human_turn` classification

Within an exchange:
- `state.cachedBase` is constant
- `state.toolLoopChain` accumulates
- All message_groups within the range belong to this exchange

Exchange boundaries are recorded in the `exchange_levels` table by `start_group` (first request message_group) and `end_group` (last response message_group before next human turn). Detection piggybacks on the existing classifier — when a human_turn is classified, the previous exchange's `end_group` is finalized.

**Size variance is expected.** A "yes" → "ok" exchange is 100 tokens. A 20-file refactor exchange is 200K. The compositional unit doesn't need to be uniform — it needs to be the natural unit of "something happened" so that fidelity levels are semantically coherent.

### 2. Four Fidelity Levels

Each exchange is renderable at up to four zoom levels. Level 0 is the raw data (already stored). Levels 1-3 are pre-computed and stored in `exchange_levels`.

**Level 0 — Verbatim.** Real user/assistant message pairs with full tool_use/tool_result blocks. Reconstructed from raw_events using existing `buildHistoryTrace` logic for the relevant message_group range. ~5-50K tokens per exchange.

**Level 1 — Condensed.** Plain text user/assistant pairs. Tool results replaced with structural summaries. Assistant reasoning and user text preserved verbatim. No tool_use/tool_result blocks. ~500-3K tokens per exchange.

**Level 2 — Action.** A single text exchange (one user message, one assistant message). Captures what happened and what was decided. ~100-300 tokens.

**Level 3 — Session.** One paragraph per session (not per exchange). The arc of the session. ~200-500 tokens per session.

### 3. Compressed Levels Render as Plain Text (No Tool Blocks)

**This is a hard constraint from the Anthropic API, not a design choice.**

The API requires every `tool_use` block to have an immediately adjacent `tool_result` block. There is no way to include a "summarized" tool interaction — you either include the full `tool_use` + `tool_result` pair or you don't include tool blocks at all.

Therefore: Levels 1, 2, and 3 render as plain text `user`/`assistant` message pairs. No `tool_use`, no `tool_result`. The tool interaction is described in natural language:

```
Level 0 (verbatim):
  assistant: [tool_use: Read, path: "src/proxy.ts"]
  user: [tool_result: <658 lines of TypeScript>]
  assistant: "The proxy strips cache_control markers at lines 621-658..."

Level 1 (condensed):
  user: "Can you check how the proxy handles caching?"
  assistant: "I read src/proxy.ts (658 lines, TypeScript) and found the
  cache_control stripping at lines 621-658. The proxy strips all markers
  because CC's breakpoints don't align after message rewriting..."

Level 2 (action):
  user: "Can you check how the proxy handles caching?"
  assistant: "Investigated prompt caching. Found cache_control stripping in
  proxy.ts:621-658 — needed to avoid API 400s from misaligned breakpoints."
```

This means the model sees tool usage in Level 0 (recent exchanges) as actual tool interactions, and in Levels 1-3 (older exchanges) as natural language descriptions. The transition is invisible — the model just sees a conversation where older parts are less detailed, exactly like human memory.

**Alternative considered:** Preserving tool_use/tool_result structure in Level 1 with compressed results. Rejected because:
- Tool pairing is fragile — any bug → 400 error
- Compressed tool results still carry structural overhead (block types, tool_use_ids, metadata)
- Level 0 already preserves full structure for recent exchanges where it matters
- The model doesn't need to know HOW information was obtained in old history, just WHAT was learned

### 4. FTS5 Strategy: Raw Events Mapped to Exchanges

The composition algorithm needs relevance scoring per exchange against the user's current message. Three approaches were considered:

**Option A: New FTS5 on exchange_levels.** Index Level 1 content. Problem: Level 1 replaces file contents with `[Read src/proxy.ts — 658 lines]`, so the actual content the agent read isn't searchable. A user asking about "cache_control" wouldn't match an exchange where the agent read proxy.ts (which contains "cache_control") because the Level 1 summary doesn't include that text.

**Option B: Query raw_events_fts, map hits to exchanges.** Search the full original content (including file contents the agent read), then map matching raw_event rows back to their exchange via message_group ranges. The search surface is comprehensive.

**Option C: Use memories_fts via memory_sources.** Leverages Tier 2 knowledge. But memories are abstractions — they don't cover all exchanges, and memory_sources only links to the specific events that spawned each memory.

**Decision: Option B.**

```sql
SELECT DISTINCT el.start_group, el.end_group,
       SUM(rank) as relevance_score
FROM raw_events_fts
JOIN raw_events ON raw_events.id = raw_events_fts.rowid
JOIN exchange_levels AS el
  ON raw_events.message_group BETWEEN el.start_group AND el.end_group
  AND el.level = 1  -- join on any level to identify the exchange
WHERE raw_events_fts MATCH ?
  AND raw_events.is_subagent = 0
GROUP BY el.start_group, el.end_group
ORDER BY relevance_score DESC
```

This searches full original content and maps to exchanges. The FTS5 `rank` function provides relevance scoring. No new index needed — `raw_events_fts` already exists.

**FTS5 query sanitization:** Same approach as the existing selector recall — split user message into words, wrap each in quotes, join with OR. Handles special characters and long messages.

### 5. Elastic Budget with Soft Cap

The composer works with a **target budget** and a **soft cap**, not a single fixed budget:

```
APERTURE_FLOOR      =  40_000   // minimum for thread coherence
APERTURE_BASELINE   = 100_000   // target for typical turns
APERTURE_SOFT_CAP   = 200_000   // default max unless overridden by high-relevance content
APERTURE_CEILING    = contextBudget - system - tools - tier2 - overhead  // hard limit (~900K with 1M)
```

**Composition fills in three phases:**

Phase 1: **Anchor.** Include the most recent exchange(s) at Level 0, up to `ANCHOR_BUDGET = 40_000` tokens. At least one exchange (the current one) is always included. If the most recent exchange alone exceeds ANCHOR_BUDGET, include it anyway — you always need the current conversation.

Phase 2: **Fill to baseline.** Score remaining exchanges. Fill greedily (descending by score) up to `APERTURE_BASELINE`. Each exchange is rendered at the fidelity level appropriate to its score (see scoring below).

Phase 3: **Flex past baseline.** If there are still exchanges scoring above `HIGH_SCORE_THRESHOLD` that haven't been included, continue filling up to `APERTURE_SOFT_CAP`. Beyond SOFT_CAP, only continue if exchanges score above `CRITICAL_SCORE_THRESHOLD` (very strong FTS5 match + high recency). Hard stop at APERTURE_CEILING.

**Why a soft cap?** Without it, a session where every exchange mentions "proxy" would fill 400K every turn (everything matches the keyword). The soft cap prevents accidental over-fill while allowing genuine flex when the relevance signal is strong, not just broad.

### 6. Exchange Scoring

Each exchange gets a composite score:

```
score(exchange) = α·recency + β·relevance + γ·working_set_bonus
```

**Recency:** `1 / (1 + ordinal_distance)` where ordinal_distance is the number of exchanges between this one and the current turn. Decays with distance. Normalized 0-1.

**Relevance:** FTS5 match score (from the raw_events_fts query above), normalized by dividing by the maximum score in the result set. 0 if no FTS5 hits. Normalized 0-1.

**Working set bonus:** +0.3 if the exchange touched any file currently in the working set (detected from tool_use names and inputs in the exchange). +0.1 if the exchange contains any concept keyword from the working set. Binary, not proportional.

**Starting weights:** α=1.0, β=0.8, γ=0.5. These are tuning parameters.

**Score → Fidelity mapping:**

| Score Range | Fidelity Level | Rationale |
|------------|---------------|-----------|
| > 0.7 | Level 0 (verbatim) | Highly relevant — agent needs full detail |
| 0.4 - 0.7 | Level 1 (condensed) | Moderately relevant — what happened, not raw content |
| 0.15 - 0.4 | Level 2 (action) | Low relevance — one-line summary sufficient |
| < 0.15 | Level 3 or excluded | Session summary or not included |

These thresholds are tuning parameters. Start conservative (more Level 0/1, less exclusion), tighten based on real usage.

### 7. Level 1 Generation: Heuristic Compression at Exchange Boundary

Level 1 is generated when an exchange boundary is detected (the next human_turn arrives, finalizing the previous exchange). Not at individual archive time — the full exchange must be complete.

**Process:**
1. Query raw_events for the exchange's message_group range
2. Reconstruct user/assistant message pairs (existing logic)
3. For each `tool_result` content block, match it to its `tool_use` by `tool_use_id` (tool_use is in the preceding assistant message)
4. Generate a structural summary based on the tool name:

| Tool | Template |
|------|----------|
| Read | `[Read {path} — {lineCount} lines, {language}]` |
| Edit | `[Edit {path} — {changeDescription}]` |
| Write | `[Write {path} — {lineCount} lines]` |
| Grep | `[Grep '{pattern}' — {matchCount} matches in {fileList}]` |
| Glob | `[Glob '{pattern}' — {matchCount} files]` |
| Bash | `[Bash '{command}' — exit {code}, {outputLines} lines]` |
| Agent | `[Agent '{description}' — completed]` |
| Unknown | `[{toolName} — {truncated first 200 chars}...]` |

5. Replace tool_result content blocks with their summary. Drop all tool_use blocks.
6. Render as plain text user/assistant pairs
7. Compute token estimate
8. Store in exchange_levels (level=1)

**Tool name extraction:** The tool name is stored in `raw_events.metadata` (as JSON with `tool_name` field) when the assistant's tool_use block is archived. The compressor joins tool_use metadata with tool_result to determine the tool type.

### 8. Levels 2-3: Consolidation Side Outputs

Level 2 (action summaries) and Level 3 (session summaries) are generated during the consolidation phase of digesting, as side outputs from work Haiku is already doing.

Two new tools added to the consolidation tool set:

- `exchange_summary(start_group, end_group, summary)` — Haiku emits one per exchange group it processes
- `session_summary(session_id, summary)` — Haiku emits one per session batch

These are **optional** — if Haiku doesn't call them (prompt mismatch, error, token limit), no failure. Level 1 is always available as the floor. Level 2-3 are quality improvements, not requirements.

### 9. Backwards Compatibility and Backfill

**New agents (post-sprint):** Level 1 generated from first exchange. Levels 2-3 after first consolidation. Graceful cold start.

**Existing agents (pre-sprint):** No exchange_levels exist. The composer falls back to the existing `buildHistoryTrace()` behavior — chronological replay with front-trimming. As new exchanges are created, they get Level 1. As consolidation runs, they get Levels 2-3.

**Optional backfill:** A `spotless backfill` command could retroactively generate Level 1 summaries for existing raw_events. Level 1 is heuristic (no LLM), so this is fast and free. Not a launch requirement, but a significant quality-of-life improvement for existing agents.

### 10. Fractal Identity

Identity facts (self-concept, relationship observations) follow the same fractal depth logic as history. Identity facts have salience and access_count — these map to conceptual depth:

| Characteristic | Identity Depth | Treatment |
|---------------|---------------|-----------|
| High salience, high access, old | Core | Always present (minimum identity) |
| Medium salience, evolving | Working | Included on normal conversation turns |
| Lower salience, contextual | Situational | Surfaced by selector when contextually relevant |

The composer allocates identity budget from the existing Tier 2 pool. On tool loop turns, only core identity facts (1-2 lines). On normal turns, core + working. On identity-relevant turns (corrections, value judgments, relationship statements), full expansion.

The selector already scores identity facts — the composer just applies a fidelity threshold based on turn type, the same way it applies fidelity thresholds to history exchanges.

## Schema

```sql
CREATE TABLE exchange_levels (
  id INTEGER PRIMARY KEY,
  start_group INTEGER NOT NULL,
  end_group INTEGER NOT NULL,
  session_id INTEGER,
  level INTEGER NOT NULL CHECK (level IN (1, 2, 3)),
  content TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(start_group, end_group, level)
);

CREATE INDEX idx_exchange_levels_session ON exchange_levels(session_id);
CREATE INDEX idx_exchange_levels_groups ON exchange_levels(start_group, end_group);
```

Working set is in-memory (Map on ProxyState). Reconstructible from raw_events on restart. No SQLite table needed.

## Rejected Alternatives

### Synthetic retrieval tool
Give the agent a tool to request specific past context. Rejected: Spotless's value proposition is invisible memory. The agent shouldn't manage its own context. Adds latency (tool call round-trip) and token cost (tool call overhead). The composer does this transparently.

### LLMLingua-style token compression
Run a small model to identify dispensable tokens. Rejected: Adds a runtime dependency (compression model), latency, and complexity. Heuristic Level 1 compression gets 80% of the benefit for 0% of the cost. LLM-quality compression happens at Level 2-3 via the consolidation phase that's already running.

### Always-Level-0 with aggressive trimming
Just trim more aggressively from the front. Rejected: This is what Spotless does today. It loses conversational coherence (can't reference old work), wastes tokens on irrelevant recent tool outputs, and can't re-expand when needed.

### MCP tool for memory management
Expose memories/history as MCP tools. Rejected: Same as synthetic retrieval tool — violates the invisible memory principle. Also requires the model to be good at knowing what it doesn't know, which it isn't.
