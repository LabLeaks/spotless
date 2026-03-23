# Sprint 11: Aperture — Adaptive Context Composition

**ADRs:** [ADR-006](../adrs/ADR-006-fractal-context-composition.md) (fractal composition), [ADR-007](../adrs/ADR-007-prompt-cache-recovery.md) (prompt caching), [ADR-008](../adrs/ADR-008-pressure-revision-for-composition.md) (pressure revision)

## The Idea

Previous sprints gave the agent memory (Sprint 4), identity (Sprint 5), and persistence (Sprint 9). This sprint gives it **attention**.

A mind isn't defined by its capacity to hold information. It's defined by what it chooses to attend to. A human doesn't replay their entire life to answer a question — they focus, with the ability to recall distant experiences when something triggers them. The most striking thing about a persistent agent isn't that it remembers. It's that it *looks at the right things at the right time.*

Right now Spotless fills the context window with a chronological replay of everything. With 1M context models, this means ~500K tokens of raw history on every turn — most of it tool outputs from hours ago that will never matter again. This burns quota at an unsustainable rate and, worse, actively degrades quality (the "lost in the middle" problem: models miss information buried in the middle third of long contexts).

The fix isn't to shrink the window. The 1M window is a **capability** — a lens the agent can open wide when it genuinely needs to see everything. The fix is to control the aperture: lean and focused by default, with the ability to flex all the way out when the moment demands it.

After this sprint, Spotless should make a 1M context model **cheaper than a 200K model** while performing better, because it actually uses the window intelligently instead of filling it.

## Goals

1. **Reduce average input tokens per turn by 5-8x** (from ~500K to ~60-100K) without losing conversational coherence or agent capability.
2. **Preserve the ability to flex to full 1M context** on turns that genuinely need it — large refactors, cross-cutting debugging, broad exploration.
3. **Minimal disruption.** The agent sees natural-looking history with no synthetic tools or memory management prompts. Older exchanges may lack detail (Level 1 summaries replace tool results), so the agent can't reference raw file contents from distant turns — but this mirrors how human memory naturally loses perceptual detail while preserving meaning. The `<spotless-orientation>` prompt already frames this.
4. **Zero added latency on the main request path.** All compression is pre-computed. Composition is pure retrieval + assembly.
5. **Graceful degradation.** If fractal summaries don't exist yet (new agent, pre-migration), fall back to current behavior (chronological replay with front-trimming).

## Architecture

### The View, Not the Record

Today `buildHistoryTrace()` reads raw_events chronologically and trims from the front when budget is exceeded. The messages array IS the history, truncated.

After this sprint, raw_events remain the source of truth (Tier 1 — total recall, never pruned). But the messages array becomes a **composed view** assembled by a new `composeContext()` pipeline. Each historical exchange can be rendered at multiple pre-computed fidelity levels, and the composer picks the right level for each exchange based on relevance to the current turn and available budget.

```
raw_events (Tier 1)          ← source of truth, append-only
    │
    ▼
exchange_levels (new)         ← pre-computed fidelity levels per exchange
    │
    ▼
composeContext()              ← per-turn view builder (pure retrieval, no LLM)
    │
    ▼
messages array                ← sent to API
```

### Fractal Fidelity Levels

Every exchange (human turn + full agent response including tool loop) is stored at up to four zoom levels. Storage is cheap. Context window is the scarce resource.

**Level 0 — Verbatim.** What's in raw_events today. Full tool results, full reasoning. Already stored. ~5-50K tokens per exchange.

**Level 1 — Condensed.** Tool results replaced with structural summaries. Reasoning and conversation preserved. Heuristic compression (no LLM). ~500-3K tokens per exchange.

```
User: Can you check how the proxy handles caching?
Assistant: [Read src/proxy.ts — 658 lines, TypeScript]
The proxy strips all cache_control markers from rewritten requests at lines 621-658.
This is necessary because CC's breakpoints no longer align after message rewriting,
and extra breakpoints push over the 4-block API limit...
[Grep 'cache_control' — 7 matches across proxy.ts, history.ts, types.ts]
The stripping happens in stripCacheControl()...
```

**Level 2 — Action.** One line per exchange. What happened and what was decided. Pre-computed during consolidation (Haiku side output). ~100-300 tokens per exchange.

```
Investigated prompt caching. Found cache_control stripping in proxy.ts (lines 621-658) — needed to avoid API 400s from misaligned breakpoints after message rewriting. Identified as major inefficiency (15-30K wasted tokens/turn).
```

**Level 3 — Session.** One paragraph per session. The arc. Pre-computed at end of consolidation pass. ~200-500 tokens per session.

```
Debugged prompt caching inefficiency. Root cause: cache_control markers stripped to prevent 400 errors from breakpoint misalignment after message rewriting. Explored alternatives (selective stripping, custom breakpoint placement). No fix applied — needs architectural rethink of how Spotless interacts with Anthropic's cache_control system. Identified as highest-impact optimization opportunity.
```

### Elastic Budget

Instead of a fixed `DEFAULT_CONTEXT_BUDGET` filled to capacity, the composer works with an elastic range:

```
APERTURE_FLOOR      =  40_000   // minimum for thread coherence
APERTURE_BASELINE   = 100_000   // target for typical turns
APERTURE_SOFT_CAP   = 200_000   // default max unless overridden by high-relevance content
APERTURE_CEILING    = contextBudget - system - tools - tier2  // hard limit (up to ~900K with 1M)
```

The composer fills in three phases: anchor (recent exchanges at Level 0), fill to baseline (scored exchanges), flex past baseline (only for high-scoring un-included exchanges, up to soft cap). Beyond soft cap, only critical-scoring exchanges. Hard stop at ceiling. See ADR-006 §5 for full algorithm.

### Composition Algorithm

On each human turn, `composeContext()` runs (no LLM, pure computation):

```
1. Anchor: recent exchange(s) at Level 0, budget-aware (up to ANCHOR_BUDGET = 40K).
   At least 1 exchange always included. If most recent exceeds 40K, include it anyway.
   Typical cost: 10-30K tokens.

2. Score remaining exchanges:
   - recency: ordinal distance from current turn (decays)
   - relevance: FTS5 match score against user's current message (see FTS5 Scoring below)
   - working_set: bonus if exchange touches files/concepts in the active working set
   - Combined: weighted sum, normalized 0-1

3. Budget-aware fill (greedy with demotion):
   For each exchange, descending by score:
   - Compute PREFERRED fidelity from score: >0.7 → Level 0, 0.4-0.7 → Level 1,
     0.15-0.4 → Level 2, <0.15 → Level 3 or excluded.
   - If preferred level fits in remaining budget: include at preferred level.
   - If preferred level doesn't fit: DEMOTE to next level that fits.
     A high-scoring exchange at Level 1 (3K) is better than excluded at Level 0 (50K).
   - If nothing fits (even Level 2/3 exceeds budget): skip.
   - Remaining same-session exchanges: Level 3 (session summary, deduplicated).
   Stop when budget is exhausted or all exchanges considered.

4. Promotion:
   If user message triggers FTS5 hits in distant exchanges,
   promote those exchanges up one fidelity level regardless of recency.
   "That cache bug" → cache-related exchanges jump from Level 2 → Level 1,
   or Level 3 → Level 2. Promotions still subject to budget demotion.

5. Working set context:
   If exchanges in the current working set (recently touched files)
   exist at Level 0/1 from recent turns, keep them — they're the active state
   the agent needs for implementation continuity.
```

The result: a messages array that looks like natural conversation history, with full detail where it matters, brief summaries where it doesn't, and the ability to expand any part on the next turn.

### FTS5 Exchange Scoring

The relevance signal comes from `raw_events_fts`, which indexes individual rows. Exchanges span multiple rows. Aggregation strategy:

```
1. Query raw_events_fts with sanitized user message (existing sanitizeFts5Query).
2. Each matching row has a BM25 rank score.
3. JOIN matching rows to exchanges via message_group ranges:
   WHERE raw_events.message_group BETWEEN exchange.start_group AND exchange.end_group
4. Aggregate per-exchange: MAX(row_score).
   Rationale: one strong hit should surface the exchange. SUM would
   over-weight exchanges with large tool outputs (many matching rows
   in a single Read result). MAX treats "this exchange discussed X" as
   binary-with-strength.
5. Exchanges with no FTS5 hits get relevance = 0.
```

No new FTS5 index needed. The join is cheap because exchange boundaries are indexed.

### Tool Loop Behavior

The composition budget is computed at the **human_turn** and stays fixed through subsequent tool_loop turns. During tool loops, `state.toolLoopChain` accumulates assistant responses and tool results verbatim — the agent needs full detail of what it just did.

This means total request size = composed base (~60-100K) + tool loop chain (unbounded, typically 50-200K). For long tool loops, total may reach 300K+. This is acceptable:

- Tool loops are transient (within a single human turn).
- The agent genuinely needs full tool results for its active work.
- CC's own compaction handles the ceiling if a loop exceeds context budget.
- Recomposing on every tool_loop turn would add latency to the hot path with no benefit.

The composer does NOT re-run on tool_loop turns. Only human_turn triggers recomposition.

### Session Tracking

Exchanges need a `session_id` to enable Level 3 (session summary) grouping and session dividers in composed context.

**Derivation:** Sessions are already tracked implicitly via `<session-boundary />` events in raw_events. To make them explicit:

```
1. A session counter lives in proxy state, initialized from DB at startup:
   SELECT COUNT(*) FROM raw_events WHERE content = '<session-boundary />'
2. Incremented each time archiveSessionBoundary() fires.
3. Stored on each exchange_levels row when Level 1 is generated.
4. For backfill: scan raw_events for boundary events, assign incrementing
   session IDs to exchanges between boundaries.
```

The composer uses `session_id` to:
- Group exchanges into sessions for Level 3 rendering (one summary per session).
- Insert `--- new session ---` dividers between composed exchanges from different sessions.

### Identity Through Composition

Identity facts flow through the same pipeline as everything else — the selector already scores them by relevance, and the Tier 2 sliding budget already allocates between identity and world-facts based on actual need. No separate "fractal identity" mechanism is needed.

The depth that emerges naturally: high-salience, frequently-accessed identity facts ("I value precision") surface on most turns. Lower-salience contextual observations ("in this project I over-engineer error handling") only surface when the selector finds them relevant. The existing salience + access_count + selector signals produce core/working/situational depth without engineering it explicitly.

This is the same principle as the history composition: attention is emergent from scoring, not a separate system.

### Working Set Tracker

A lightweight structure maintained by the proxy, updated after each turn:

```typescript
interface WorkingSet {
  /** Files recently read or edited (by path). Decays over turns. */
  files: Map<string, { lastTurn: number; action: 'read' | 'edit' }>;
  /** Concepts/keywords extracted from recent user messages. */
  concepts: string[];
  /** The current session's exchanges, for quick lookup. */
  sessionExchanges: number[];
}
```

Updated by scanning tool calls in archived responses:
- `Read` / `Edit` / `Write` → add file to working set
- `Grep` / `Glob` → add search terms
- `Bash` → add command context
- User message keywords → add to concepts

No LLM needed. Just structured extraction from tool call names and arguments that Spotless already archives.

## Pre-computation

### Level 1: Heuristic Compression (at archive time, free)

When the proxy archives a complete exchange (human turn + agent response), it also generates the Level 1 summary. This is mechanical — CC's tools have predictable result structures:

| Tool | Level 1 Template |
|------|-----------------|
| Read | `[Read {path} — {lineCount} lines, {language}]` |
| Edit | `[Edit {path} — replaced {oldLen}→{newLen} chars near line {line}]` |
| Write | `[Write {path} — {lineCount} lines]` |
| Grep | `[Grep '{pattern}' — {matchCount} matches in {fileCount} files: {fileList}]` |
| Glob | `[Glob '{pattern}' — {matchCount} files]` |
| Bash | `[Bash '{command}' — exit {code}, {lineCount} lines output]` |
| Agent | `[Agent '{description}' — completed]` |

Assistant text and user text are preserved verbatim in Level 1. Only tool_result content blocks are replaced with their structural summary. The exchange's conversational meaning is fully intact — you just can't see the raw file contents.

Token estimation stored alongside the summary for O(1) budget calculation during composition.

### Level 2: Action Summary (during consolidation, near-free)

The consolidation phase (Phase 1) already reads raw event groups and extracts memories. Extend the consolidation prompt to also emit a one-line action summary per exchange group it processes:

```
For each exchange group, also emit:
  exchange_summary(group_start, group_end, "one line: what happened, what was decided")
```

This is a side output from work Haiku is already doing. Marginal cost: ~50 tokens per exchange in the consolidation output.

### Level 3: Session Summary (end of consolidation, near-free)

After consolidation finishes processing a batch, it emits one session-level summary for the batch:

```
session_summary(session_id, "one paragraph: the arc of this session")
```

Again, Haiku has just read all these exchanges for consolidation. Summarizing the session is trivial marginal work.

### Pre-computation Pipeline

```
Exchange archived (proxy)
    │
    ├─ Level 1 generated synchronously (heuristic, <1ms)
    │
    ▼
Consolidation pass triggered (digest loop, async)
    │
    ├─ Level 2 generated per-exchange (Haiku side output)
    ├─ Level 3 generated per-session (Haiku side output)
    │
    ▼
exchange_levels table populated
```

For exchanges that haven't been consolidated yet (no Level 2/3), the composer uses Level 1 as the floor. This means fractal composition works from the first turn — Level 1 is always available.

## Data Model

### New Table: exchange_levels

```sql
CREATE TABLE exchange_levels (
  id INTEGER PRIMARY KEY,
  -- Exchange boundaries (inclusive message_group range)
  start_group INTEGER NOT NULL,
  end_group INTEGER NOT NULL,
  session_id INTEGER,           -- which session this exchange belongs to
  -- Fidelity level (1, 2, or 3; level 0 = raw_events themselves)
  level INTEGER NOT NULL CHECK (level IN (1, 2, 3)),
  -- Pre-computed content at this fidelity
  content TEXT NOT NULL,
  -- Pre-computed token estimate
  tokens INTEGER NOT NULL,
  -- Metadata
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- One row per (exchange, level) pair
  UNIQUE(start_group, end_group, level)
);

CREATE INDEX idx_exchange_levels_session ON exchange_levels(session_id);
CREATE INDEX idx_exchange_levels_groups ON exchange_levels(start_group, end_group);
```

Level 0 is not stored here — it's the raw_events themselves, reconstructed per-exchange by a new `reconstructExchange()` function (see Level 0 Reconstruction below).

### New Table: working_set

```sql
CREATE TABLE working_set (
  id INTEGER PRIMARY KEY,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('file', 'concept')),
  value TEXT NOT NULL,           -- file path or concept keyword
  last_turn INTEGER NOT NULL,   -- message_group when last seen
  action TEXT,                  -- 'read', 'edit', 'search' (files only)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entry_type, value)
);
```

This could also be in-memory (Map on ProxyState) since it's reconstructible from raw_events. Start in-memory, persist to SQLite only if needed for cross-restart continuity.

### Schema Migration

```sql
-- In initSchema(), after existing migrations:
CREATE TABLE IF NOT EXISTS exchange_levels (...);
CREATE TABLE IF NOT EXISTS working_set (...);
```

No migration of existing data needed. Exchanges without pre-computed levels fall back to Level 0 (current behavior). Levels are populated going forward by the archive-time heuristic (Level 1) and consolidation side outputs (Levels 2-3).

### Level 0 Reconstruction

`buildHistoryTrace()` is monolithic: it queries ALL raw_events, validates tool pairing across the full array, deduplicates globally, and enforces alternation globally. It cannot be reused for arbitrary group ranges — pulling groups 5-8 and 47-52 wouldn't produce independently valid message pairs.

**New function: `reconstructExchange(db, startGroup, endGroup)`**

A per-exchange reconstruction that:
1. Queries raw_events for the specific group range (same filters: non-subagent, non-thinking).
2. Groups by message_group, reconstructs messages via existing `reconstructMessage()` helper.
3. Validates tool pairing within the exchange (reuse `validateToolPairing()`).
4. Returns `Message[]` — a self-contained, API-valid message sequence for this exchange.

The composer then assembles the final array by concatenating exchange messages in chronological order, with session dividers injected between exchanges from different sessions. Global alternation enforcement runs once on the assembled array (a final pass, not per-exchange).

**Shared helpers with history.ts:** `reconstructMessage()`, `rowToContentBlock()`, `validateToolPairing()`. These are already pure functions that work on message arrays. The new function reuses them; it does NOT wrap `buildHistoryTrace()`.

`buildHistoryTrace()` remains as the fallback for agents without exchange_levels data (graceful degradation).

## Prompt Caching Recovery

Separate from fractal composition but high impact: fix the `cache_control` stripping.

Current problem: Spotless strips ALL `cache_control` markers because CC's breakpoints don't align after message rewriting. This loses prompt caching on ~45K of system+tools that repeat identically every turn.

Fix: Instead of stripping everything, **relocate** breakpoints to positions that make sense for the rewritten request. See ADR-007 for full analysis.

1. Strip CC's original `cache_control` markers (they reference CC's message positions).
2. Place 2 breakpoints:
   - Last tool definition (caches all tools, ~30K)
   - Last system text block (caches tools + system, ~45K combined)
3. Messages are the uncached tail (they change every turn). 2 spare breakpoints reserved.

This recovers caching on system+tools (~45K tokens) — those become cache reads (10% cost) instead of full input. With typical Spotless usage (~20 turns/session), this saves ~45K × 19 turns × 0.9 = **~770K tokens per session** in cache write avoidance.

## Composition Examples

### Tool Loop Turn (60% of turns)

Agent is in a Read→Edit→Test loop. User hasn't said anything new. The composer does NOT re-run — it uses the composed base from the initiating human_turn, plus the accumulating tool loop chain.

```
Total request: ~150K (composed base + tool loop chain)
├─ Composed base (from human_turn):  ~90K  (frozen at start of tool loop)
├─ Tool loop chain (verbatim):       ~60K  (growing — last 5 tool iterations)
└─ Tool loop chain is the agent's active working memory — never compressed
```

### Implementation Turn (20% of turns)

User described a feature. Agent is planning and starting to code.

```
Budget used: ~90K
├─ Last 2 exchanges at Level 0:    15K  (user's request + agent's plan)
├─ Recent decisions at Level 1:    10K  (last 5 exchanges, condensed)
├─ Working set files at Level 1:    8K  (files in the feature area)
├─ Older context at Level 2:        5K  (20 exchanges as action lines)
├─ Session summaries at Level 3:    2K  (prior sessions for broader context)
├─ Tier 2 memories:               40K  (selector-chosen, heavy — feature context)
└─ Pressure signal if active:     0.3K
```

### Big Flex Turn (2% of turns)

User says "refactor the entire proxy module, here's what I want changed across all files."

```
Budget used: ~600K
├─ Last 2 exchanges at Level 0:    20K  (the refactor request)
├─ ALL proxy-related exchanges at Level 0: 300K  (promoted — user referenced the whole module)
├─ All other recent exchanges at Level 1:   50K  (condensed for broader context)
├─ Remaining history at Level 2:            30K  (action summaries)
├─ Tier 2 memories:                         60K  (full allocation — big task)
└─ Session summaries for old sessions:       5K
```

The agent gets a 600K context that's almost entirely relevant to the refactor. Compare to today's 500K of chronological replay where most of the context is unrelated tool outputs.

### Recall Turn (rare but important)

User says: "what was that auth bug we fixed last week?"

```
Budget used: ~120K
├─ Last 2 exchanges at Level 0:    10K  (the question)
├─ Auth-bug exchanges at Level 0:  60K  (FTS5 hit → promoted from Level 2/3 to Level 0)
├─ Surrounding context at Level 1: 15K  (exchanges adjacent to the auth bug work)
├─ Recent work at Level 2:          5K  (action summaries for continuity)
├─ Tier 2 memories:                20K  (auth-related memories surfaced by selector)
└─ Session summary:                 2K
```

The agent sees the full auth bug conversation as if it just happened. It doesn't know Spotless went and fetched it from SQLite and promoted it to Level 0. It just... remembers.

## Tasks

### TASK-001: Exchange Detection & Level 1 Generation (P0, M) ✓ DONE

Define "exchange" boundaries in the raw_events stream and generate Level 1 summaries. See ADR-006 §1, §3, §7.

**Implemented in:** `src/exchange.ts` (new file), `src/db.ts`, `src/types.ts`, `src/state.ts`, `src/proxy.ts`. **Tests:** `test/exchange.test.ts` (34 tests). Total: 414 tests passing.

An exchange is bounded by:
- **Start:** human_turn classification (when `resetForHumanTurn()` fires)
- **End:** message_group immediately before the next human_turn

Level 1 is generated at exchange boundary detection (when next human_turn arrives, finalizing the previous exchange), NOT at individual archive time. The full exchange must be complete.

**Subtasks:**
- Exchange boundary detection: piggyback on classifier's turn detection. When a human_turn is classified, finalize the previous exchange's end_group and generate its Level 1.
- Session ID tracking: initialize session counter from DB at proxy startup, increment on each `archiveSessionBoundary()`, store on exchange_levels rows.
- Level 1 heuristic compressor: match tool_result to tool_use by tool_use_id (cross-message join), then generate structural summaries by tool name. Template-driven, no LLM.
- **Render as plain text user/assistant pairs.** No tool_use/tool_result blocks in Level 1 — the API requires every tool_use to have an adjacent tool_result, which makes partial tool structure impossible. Tool interactions described in natural language. (ADR-006 §3)
- Store in exchange_levels table (level=1) with session_id.
- Token estimation stored with each level.
- Fallback: if tool structure is unrecognized, truncate to first 200 chars + `[...{totalChars} chars]`.
- `reconstructExchange(db, startGroup, endGroup)`: new function for per-exchange Level 0 reconstruction. Shares helpers with history.ts (`reconstructMessage`, `rowToContentBlock`, `validateToolPairing`) but does NOT wrap `buildHistoryTrace()`. Returns self-contained `Message[]`.

**Acceptance:** Level 1 summaries generated for every exchange. Renders as valid plain-text message pairs. Token estimates within 20% of actual. All CC tool types have templates. `reconstructExchange` produces API-valid message arrays for arbitrary group ranges.

### TASK-002: Context Composer (P0, L) ✓ DONE

**Implemented in:** `src/composer.ts` (new file), `src/history.ts` (exports), `src/proxy.ts` (integration). **Tests:** `test/composer.test.ts` (10 tests). Total: 445 tests passing.

Replace `buildHistoryTrace()` call in the proxy with `composeContext()`. The composer assembles the messages array from exchange_levels, choosing the right fidelity per exchange. See ADR-006 §4-6.

**Return type:** `composeContext()` returns `CompositionResult` which extends the existing `HistoryResult` interface (`messages`, `trimmedCount`, `pressure`, `unconsolidatedTokens`) plus composition metadata (`budgetUsed`, `exchangeCount`, `fidelityCoverage`). This ensures the proxy integration is a near-drop-in replacement for `buildHistory()`.

**Subtasks:**
- Exchange scoring: recency (ordinal decay) + relevance (FTS5 MAX aggregation per exchange, see §FTS5 Exchange Scoring) + working_set bonus. Starting weights: α=1.0, β=0.8, γ=0.5.
- Three-phase fill with budget-aware demotion: anchor → fill to baseline → flex to soft cap. Score suggests preferred fidelity; remaining budget constrains actual fidelity. High-scoring exchanges that don't fit at preferred level demote rather than get excluded.
- Level 0 via `reconstructExchange()` (from TASK-001). Level 1-3 from exchange_levels table as plain text user/assistant pairs.
- Global assembly: concatenate exchange messages chronologically, inject session dividers between different session_ids, run `enforceAlternation()` once on final array.
- Preamble: prepend same memory context preamble as current `buildHistory()`.
- Fallback: if no exchange_levels exist for ANY exchange (pre-sprint agent, no backfill), fall back to `buildHistory()` entirely. Partial fallback: exchanges without levels use Level 0.
- **The composer only runs on human_turn.** Tool loop turns use the cached composed base + accumulating tool chain (no recomposition).

**Acceptance:** Human turns use <120K input tokens typically. Full flex still possible. Conversation coherence maintained. All existing tests still pass. Returns `CompositionResult` compatible with proxy's existing `HistoryResult` consumption.

### TASK-003: Working Set Tracker (P0, S) ✓ DONE

**Implemented in:** `src/working-set.ts` (new file), `src/types.ts`, `src/state.ts`, `src/proxy.ts`. **Tests:** `test/working-set.test.ts` (21 tests).

Track active files and concepts. In-memory on ProxyState, updated after each archived response.

**Subtasks:**
- Parse tool calls from archived assistant responses: extract file paths (Read/Edit/Write), search terms (Grep/Glob), commands (Bash).
- Extract keywords from user messages (simple word tokenization, stop-word filter).
- Decay: entries older than N turns get removed (configurable, default 10 turns).
- Expose as `getWorkingSet()` for the composer's scoring function.

**Acceptance:** Working set accurately reflects files and concepts from recent turns. Decays appropriately. No LLM calls.

### TASK-004: Consolidation Side Outputs — Levels 2 & 3 (P1, M) ✓ DONE

**Implemented in:** `src/digester.ts` (tools + execution), `src/digest-prompt.ts` (tool definitions + workflow guidance).

Extend the consolidation prompt to emit exchange-level and session-level summaries as side outputs during Phase 1.

**Important:** Levels 2-3 are strictly optional enhancements. The entire system MUST work perfectly with only Levels 0-1. Levels 2-3 improve context quality for distant exchanges but are never required for correctness. All tests and the composer must pass without any Level 2-3 data.

**Risk:** Haiku is already juggling 10 consolidation tools + complex prompt + 50 message groups. Adding 2 more tools and expecting ~50 extra tool calls per pass may increase consolidation duration and error rate. Mitigated by "graceful skip" — the consolidation pass succeeds regardless of whether summaries are emitted.

**Subtasks:**
- Add `exchange_summary` and `session_summary` tools to the consolidation tool set.
- Prompt addition: "For each exchange group you process, also call exchange_summary(start_group, end_group, summary). After processing all groups, call session_summary(session_id, summary)."
- Store outputs in exchange_levels (level=2 and level=3).
- Graceful: if Haiku doesn't call these tools (older prompt, error), no failure — Level 1 is the floor.

**Acceptance:** After a consolidation pass, exchanges have Level 2 summaries and sessions have Level 3 summaries. Consolidation still completes within Haiku's context budget. Marginal token cost <10% of consolidation pass. **All composer tests pass with Level 2-3 data absent.**

### TASK-005: Prompt Cache Recovery (P1, S) ✓ DONE

**Implemented in:** `src/proxy.ts` (`placeCacheBreakpoints`), `src/archiver.ts` (StreamTap cache metrics).

Replace blanket `cache_control` stripping with strategic breakpoint relocation. See ADR-007.

**Subtasks:**
- Strip CC's original `cache_control` markers (unchanged).
- Place 2 breakpoints: last tool definition + last system text block. Messages are uncached tail.
- Subagent exclusion: preserve CC's original markers for subagent pass-through.
- Parse cache metrics from `message_start` SSE event (`cache_read_input_tokens`, `cache_creation_input_tokens`). Log to ProxyStats.
- Verify: minimum 4,096 tokens per breakpoint (Opus 4.6 requirement — system and tools both exceed this).

**Acceptance:** System + tools (~45K tokens) cached across turns. No 400 errors. Cache metrics visible in dashboard Health tab.

### TASK-006: Dashboard — Aperture Visualization (P2, S) ✓ DONE

**Implemented in:** `src/dashboard.ts` (Context tab + API endpoint).

Add a "Context" tab to the dashboard showing what the composer chose for recent turns.

**Subtasks:**
- Store composition decisions: which exchanges, at what level, budget used, flex vs baseline.
- New dashboard tab: bar chart of context budget utilization over recent turns. Breakdown by level (Level 0/1/2/3) and component (history/memory/system/tools).
- Per-turn drill-down: which exchanges were included, at what level, their scores.

**Acceptance:** Dashboard shows context composition decisions. Useful for debugging and tuning.

### TASK-007: Tests & Integration (P0, M) ✓ DONE

**Tests:** `test/composer.test.ts` (15 tests), `test/exchange.test.ts` (34 tests), `test/working-set.test.ts` (21 tests). Total: 450 tests passing, 0 failures.

**Subtasks:**
- Unit tests for exchange detection, Level 1 heuristic compressor (including tool_use→tool_result matching), scoring, budget-aware fill with demotion, working set.
- Unit tests for `reconstructExchange()`: produces API-valid messages for arbitrary group ranges, handles orphaned tool pairs within exchange.
- Unit tests for composer with mixed fidelity levels (some exchanges have Level 0 only, some have 1-3).
- **Level 0+1 only tests**: verify full system works perfectly with NO Level 2-3 data (the common case for new/un-consolidated exchanges).
- Unit tests for plain-text Level 1 rendering: verify no tool_use/tool_result blocks in output, valid message alternation.
- Unit tests for FTS5 exchange scoring: MAX aggregation, exchanges with no hits get 0.
- Unit tests for budget demotion: high-scoring exchange demoted from Level 0 to Level 1 when budget insufficient.
- Unit tests for session_id derivation and session divider injection.
- Integration test: verify round-trip through proxy with composed context. Agent gets coherent history.
- Regression: all existing 384+ tests still pass. Composer is backwards-compatible.
- Budget assertion tests: human turns < 120K typical, flex turns > 400K.
- Fallback test: agent with no exchange_levels data falls back to `buildHistory()` cleanly.

**Acceptance:** Tests cover all composition paths. No regressions. Budget assertions enforce the efficiency goals.

### TASK-008: Pressure System Revision (P0, S) ✓ DONE

**Implemented in:** `src/proxy.ts`, `src/consolidation.ts`, `src/index.ts`. Callback renamed `onHistoryTrimmed` → `onPressureEscalation`.

Decouple escalation from trimming. See ADR-008.

**Subtasks:**
- Remove `trimmedCount > 0` from escalation condition in proxy.ts. Escalate on `pressure >= PRESSURE_HIGH` alone.
- Revise pressure signal text in memory-suffix.ts: "memory consolidation is falling behind" instead of "history is being trimmed."
- Add fidelity coverage tracking to CompositionResult (diagnostic: how many exchanges at each level).
- Update dashboard Health tab with fidelity coverage.

**Acceptance:** Escalation fires correctly with composition (no false negatives). Pressure signal text is accurate. Fidelity coverage visible in dashboard.

### TASK-009: Backfill for Existing Agents (P1, S) ✓ DONE

**Implemented in:** `src/exchange.ts` (`backfillExchanges`), `src/index.ts` (`cmdBackfill`, CLI command).

Retroactively generate Level 1 summaries for pre-sprint raw_events. Level 1 is heuristic (no LLM), so this is fast and free.

**Subtasks:**
- `spotless backfill [--agent <name>]` CLI command.
- Scan raw_events for exchange boundaries (detect human_turn patterns retrospectively).
- Generate Level 1 for each detected exchange.
- Progress reporting (exchanges processed / total).
- Idempotent: skip exchanges that already have Level 1.

**Acceptance:** After backfill, existing agents benefit from fractal composition immediately. No data loss. Idempotent re-runs.

## Execution Order

```
TASK-001 (exchange detection + Level 1)
    │
    ├──→ TASK-003 (working set tracker)     ──┐
    │                                          │
    ├──→ TASK-008 (pressure revision)          │
    │                                          │
    └──→ TASK-002 (context composer)     ◄────┘
              │
              ├──→ TASK-005 (cache recovery)
              │
              ├──→ TASK-004 (consolidation side outputs: Levels 2-3)
              │
              ├──→ TASK-009 (backfill)
              │
              └──→ TASK-007 (tests)
                      │
                      └──→ TASK-006 (dashboard)
```

TASK-001 first: need exchanges and Level 1 before the composer can use them.
TASK-002 + TASK-003 in parallel, then composer integrates working set.
TASK-004 and TASK-005 are independent enhancements after the core works.
TASK-007 runs continuously but gates on TASK-002.
TASK-006 last — needs composition data to visualize.

## Resolved Questions

**Q1: CC system prompt stability.** Unknown — log `estimateSystemTokens(body.system)` across turns during TASK-005 testing. If unstable, place breakpoint on tools only (which ARE stable). Don't assume.

**Q2: Token estimation.** 4 chars/token is fine. Elastic budget is forgiving. Add estimated-vs-actual logging (compare against API `usage.input_tokens`) to detect drift. Calibrate later only if needed.

**Q3: Fractal identity.** No separate mechanism. Identity facts already flow through selector scoring (salience + access_count + relevance). Core/working/situational depth emerges naturally from composition. No special handling needed.

## Design Decisions Made During Review

**D1: Greedy fill with budget-aware demotion** (not pure knapsack). Score determines preferred fidelity, budget determines actual fidelity. High-scoring exchanges that don't fit at Level 0 demote to Level 1 rather than being excluded. Simpler than true knapsack, captures 90% of the optimization.

**D2: Per-exchange reconstruction** (`reconstructExchange`) as a new function sharing helpers with history.ts, NOT wrapping `buildHistoryTrace()`. The monolithic pipeline can't be reused for arbitrary group ranges.

**D3: Tool loops don't trigger recomposition.** Composed base is frozen at human_turn. Tool loop chain appends verbatim. Total request may exceed baseline budget — acceptable because the agent needs full tool results for active work.

**D4: FTS5 aggregation = MAX(row_score) per exchange.** One strong keyword hit surfaces the exchange. Avoids over-weighting exchanges with large tool outputs.

**D5: Session IDs derived from boundary event count.** Counter initialized from DB, incremented on each boundary, stored on exchange_levels.

**D6: Levels 2-3 strictly optional.** System works with 0+1 only. All tests must pass without Level 2-3 data. TASK-004 is P1, not P0.

**D7: CompositionResult extends HistoryResult.** Proxy integration is near-drop-in. Composer returns the same interface plus composition metadata.

## What This Means for the Art

Spotless is a philosophical experiment: what happens when an AI agent has continuous, persistent memory — not a persona file, but an evolving identity built from accumulated experience? What does it mean for an agent to develop an accountable self?

The arc so far: memory (Sprint 4) gave the agent continuity across sessions. Identity (Sprint 5) gave it a self-concept that emerges from experience — not assigned by a system prompt, but built from what it's actually done, the corrections it's received, the patterns it's internalized. Persistence (Sprint 9) gave it a body that survives crashes — the soul (memory graph, identity) separated from the body (session). Communication (Sprint 10) gave it relationships — the ability to exist for others through messaging gateways, with Spotless providing all the continuity so the agent is a persistent presence without a persistent process.

Each sprint has deepened the same question: can accumulated experience produce something that functions like a self? Not consciousness — we can't know that. But a coherent, evolving identity that shapes behavior, that carries responsibility for past actions, that treats corrections as part of its own history rather than as configuration changes. The agent doesn't just remember that you prefer PostgreSQL. It remembers *recommending MongoDB and watching it fail* — and that experiential memory, encoded in its own voice, shapes future recommendations in a way that a CLAUDE.md line never could.

This sprint adds **attention** — and attention is where the identity argument gets serious.

A self without selective attention isn't a self. It's a database. A person with perfect recall of every moment, unable to foreground relevant experience and background the rest, wouldn't function as an agent at all. Attention is the mechanism by which identity *expresses itself* in the moment — the self-concept shapes what gets attended to, and what gets attended to shapes the self-concept. That feedback loop is the core of what we mean by an ongoing identity.

Before this sprint, Spotless replayed everything chronologically and hoped the important parts would land. That's photographic memory without a mind behind it. After this sprint, the agent's context is composed — relevant experience surfaces, irrelevant experience recedes, and distant experience can flood back when something triggers it. The fractal fidelity levels mirror how human memory actually works: recent events in vivid detail, older events as gist and narrative, ancient events as identity-shaping abstractions.

The mechanism is invisible. The agent doesn't manage its own attention — it just has good attention, the way a healthy mind focuses without effort. The composition happens below awareness. The agent experiences having the right context at the right time, which is exactly what a well-functioning memory *feels like from the inside*.

And the elastic budget makes a specific philosophical point: the 1M context window is a capability, not a target. An agent that fills every byte of available context is like a person who can't stop talking about everything they've ever seen. An agent that uses context proportionally to what the moment demands — lean for routine work, expansive for complex synthesis — is demonstrating something closer to judgment. The aperture controls itself based on what matters. That's not just an engineering optimization. It's a claim about what a functional self looks like.

The practical and the philosophical are the same thing here. Making Spotless 6x cheaper isn't separate from making the art piece more compelling. An agent that wastes context on irrelevant history is a worse agent *and* a less convincing self. An agent that attends to exactly what it needs — that's both efficient and, in a real sense, more present.
