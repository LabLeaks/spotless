# ADR-004: Eidetic Consolidation & Memory Pressure

**Status:** Proposed
**Date:** 2026-02-27

## Context

### The Problem

Spotless's eidetic trace (Tier 1) is a sliding window of raw conversation events assembled into the API request as the "eidetic prefix." When the prefix exceeds the token budget (144,000 tokens), `trimTobudget` drops the oldest messages from the front. This works mechanically — the conversation continues, the model still responds — but it's cognitively reckless.

The current architecture has two consolidation triggers:

1. **Timer-based:** Background dream loop runs every 5 minutes (`setInterval`), iterates active agents, processes unconsolidated raw events.
2. **Trim-triggered:** When `trimTobudget` drops messages, `onEideticTrimmed` fires, calling `dreamLoop.triggerNow()` for that agent.

Both triggers share the same problem: **consolidation is reactive, not proactive.** The dreaming agent only processes events after they're already at risk of being lost (or already lost). There's no mechanism for the agent to know that its memory buffer is filling up, no signal that unconsolidated experiences are about to fall off the back end, and no way for the human to know the agent is under memory pressure.

### What Goes Wrong Today

1. **Silent knowledge loss.** During heavy tool-use sessions (file reads, searches, edits), the eidetic trace fills rapidly. Messages get trimmed before dreaming can process them. The raw events still exist in SQLite, but the agent has no awareness that it just "forgot" something.

2. **Reactive dreaming is too late.** The trim event fires *after* messages are dropped. `triggerNow()` kicks off a dream pass, but the dreamer works on *all* unconsolidated events (up to 50 groups), not specifically the ones about to be lost. By the time consolidation finishes, more messages may have been trimmed.

3. **No cognitive signal.** The model has no proprioception over its memory state. A human working intensely recognizes fatigue — the feeling that they're processing faster than they can consolidate. Spotless agents have no equivalent. They keep running at full speed until the eidetic buffer overflows.

4. **Dreaming throughput is bounded.** Each dream pass spawns Haiku for multi-turn tool-use. It takes 10-60 seconds depending on volume. During heavy use (rapid tool loops), events accumulate faster than dreaming can process them. There's no backpressure mechanism to prevent this gap from growing.

5. **Dropped triggers.** The dream loop uses `setInterval` + a `dreaming` Set. If `triggerNow()` fires while a dream is already running for that agent, the trigger returns `errors: ["Already dreaming"]` and is silently dropped — no queuing, no retry. Under load, the trim-triggered dreams that matter most are the ones most likely to be dropped.

6. **Schema inefficiency.** The `unconsolidatedOnly` query uses `NOT IN (SELECT raw_event_id FROM memory_sources)` but there's no index on `memory_sources(raw_event_id)` — the composite PK `(memory_id, raw_event_id)` can't serve this query efficiently. Every dream pass pays a table scan.

### Current Architecture (for reference)

```
User message → Proxy receives
  → buildEideticTrace(db)  // query raw_events → messages[]
    → trimTobudget(messages, 144k tokens)
      → if trimmedCount > 0: onEideticTrimmed(agentName)
        → dreamLoop.triggerNow(agentName)
  → Inject memory suffix (Tier 2, hippocampus-selected)
  → Forward to API

Raw events: permanent storage in SQLite (never deleted)
memory_sources: junction table (memory_id → raw_event_id)
  → implicitly marks raw events as "consolidated"
queryRawEvents({ unconsolidatedOnly: true }):
  → WHERE id NOT IN (SELECT raw_event_id FROM memory_sources)
Dream loop: setInterval(5 min) + triggerNow() on trim
  → dreaming Set prevents concurrent dreams per agent
  → second trigger while dreaming is silently dropped
```

## Decision

Replace the reactive trim-then-dream architecture with a **continuous consolidation pipeline** that gives the agent proprioception over its memory state through a **fatigue signal** when unconsolidated events are at risk of falling off the eidetic trace. The fatigue signal is social backpressure — the agent asks the human to slow down.

### Core Principles

1. **Raw events are permanent.** They stay in SQLite forever. Consolidated events are gradually migrated to archival storage for performance, but never deleted.
2. **"Consolidated" means "the dreamer saw it."** When dreaming processes a batch of groups, all events in those groups are flagged — regardless of whether memories were created from them. The dreamer had the opportunity to process them and made its judgment.
3. **Consolidated events are safe to evict from the trace.** Their knowledge lives in Tier 2 (or the dreamer decided they weren't worth retaining). They can be dropped from the eidetic prefix without knowledge loss.
4. **Unconsolidated events are vulnerable.** If they fall off the eidetic prefix before the dreamer sees them, the agent loses experiences it hasn't yet committed to long-term memory.
5. **The agent should feel its limits.** When memory pressure builds, the agent gets language to ask the human for a break. The backpressure is social, not mechanical — the human decides whether to pause.

### Architecture: `consolidated` Column on `raw_events`

Replace the implicit consolidation tracking (via `memory_sources` junction table) with an explicit `consolidated` flag on `raw_events`:

```sql
ALTER TABLE raw_events ADD COLUMN consolidated INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_raw_consolidated ON raw_events(consolidated, message_group)
  WHERE is_subagent = 0;
```

When dreaming processes a batch of groups, it marks ALL events in those groups:

```sql
UPDATE raw_events SET consolidated = 1
  WHERE message_group IN (?, ?, ...) AND is_subagent = 0;
```

This replaces the `NOT IN (SELECT raw_event_id FROM memory_sources)` anti-pattern with a simple indexed column check.

**Storage evolution path:**
1. **Now:** `consolidated` flag. Watermark is `SELECT MAX(message_group) FROM raw_events WHERE consolidated = 1 AND is_subagent = 0`.
2. **Later:** Move consolidated rows to `raw_events_archive` (same schema, separate table). Main `raw_events` stays small and fast. Eidetic trace only queries main table.
3. **Eventually:** Archive table moves to a separate DB file. Main DB stays tight, archive is append-only, can be backed up/rotated independently.

Each step is a clean migration — no behavioral changes, just storage topology.

### Architecture: Consolidation Watermark

The **consolidation watermark** is the boundary between consolidated and unconsolidated events in the eidetic trace. Because dreaming processes oldest-first (ASC), consolidated events are always at the front and unconsolidated events at the back. The watermark advances monotonically.

```
Eidetic trace (oldest → newest):

  [consolidated] [consolidated] [consolidated] | WATERMARK | [pending] [pending] [pending]
                                                                                    ↑
  ← safe to evict from trace                                    ← must retain  →  newest
```

Since `trimTobudget` already drops oldest-first, "prefer evicting consolidated" and "evict oldest" are the same operation. No per-message metadata threading needed. The implementation is a threshold check:

1. Before building the trace, query the watermark position
2. After trimming, check whether the trim ate past the watermark into unconsolidated territory
3. If so → fatigue signal + immediate dream trigger

**Key metric: consolidation pressure** = estimated tokens of unconsolidated content / eidetic budget. Measured in tokens (not groups), because groups vary wildly in size — a Read tool result can be 100x the tokens of a text exchange.

### Architecture: Fatigue Signal

When consolidation pressure exceeds a threshold, inject a **fatigue signal** into the user message (same injection point as memory suffix). This gives the agent language to ask the human for a break:

```
<memory-pressure level="moderate">
You have been working intensively and your memory consolidation is falling behind.
Approximately N tokens of conversation haven't been committed to long-term memory yet.
If this pace continues, some experiences may be lost before they can be consolidated.

You may want to let the human know you need a moment to consolidate.
</memory-pressure>
```

Three pressure levels:

| Level | Trigger | Signal |
|-------|---------|--------|
| **none** | Pressure < 60% | No signal |
| **moderate** | Pressure >= 60% | Agent can mention it naturally — "I've been working intensively, my consolidation is behind" |
| **high** | Pressure >= 85% | Agent should actively ask for a pause — "I'm at risk of forgetting unconsolidated work, can we slow down?" |

The fatigue signal is:
- **Injected in the user message** alongside memory suffix and identity tag (same cache characteristics as today)
- **Not archived** — it's ephemeral system state, not conversation content
- **Social backpressure** — the agent asks the human to slow down; the human decides

### Architecture: Adaptive Dream Scheduling

Replace `setInterval` with `setTimeout`-after-completion. After each dream pass finishes, the loop queries the agent's consolidation pressure and schedules the next pass accordingly.

| Consolidation Pressure | Next Dream In |
|------------------------|---------------|
| < 30% | 10 minutes (relaxed) |
| 30-60% | 3 minutes (normal) |
| 60-85% | 1 minute (aggressive) |
| > 85% | Immediate (re-trigger after current pass completes) |

This eliminates the dropped-trigger problem: since each agent's next dream is scheduled only after the current one finishes, there's no race between `setInterval` and `triggerNow`. The `dreaming` Set is still useful as a safety guard but the primary scheduling is sequential.

The dream loop queries the DB itself after each pass to get the current pressure — it already opens the agent's DB for dreaming, so reading consolidation status is trivial overhead.

Trim-triggered dreams (`onEideticTrimmed`) still exist as an escalation: if the proxy detects a trim into unconsolidated territory, it can signal the dream loop to reprioritize that agent (bump to front of queue, immediate scheduling).

### Architecture: Smart Eviction

`trimTobudget` stays simple — it still drops oldest messages first. The "smart" part is the threshold check after trimming:

```
function buildEideticTrace(db, budget, agentName):
  watermark = getWatermark(db)  // MAX consolidated message_group
  messages = reconstructMessages(db)  // existing pipeline
  { trimmed, trimmedCount } = trimTobudget(messages, budget)

  // Did we trim past the watermark?
  unconsolidatedEvicted = (trimmedCount > 0) AND (trim ate past watermark)

  pressure = estimateUnconsolidatedTokens(db) / budget

  return { messages: trimmed, trimmedCount, pressure, unconsolidatedEvicted }
```

No per-message metadata, no pipeline refactor. The watermark is a single query before trace building, and the pressure check is a simple comparison after.

### Architecture: Schema & Index Hygiene

As part of this work, fix existing schema inefficiencies:

1. **Add `consolidated` column** on `raw_events` (as above)
2. **Add missing index:** `CREATE INDEX idx_memory_sources_raw_event ON memory_sources(raw_event_id)` — the existing `NOT IN (SELECT raw_event_id ...)` in `queryRawEvents` has been doing table scans
3. **Replace `NOT IN` anti-pattern:** `unconsolidatedOnly` filter becomes `WHERE consolidated = 0` instead of `NOT IN (SELECT raw_event_id FROM memory_sources)`
4. **Run `EXPLAIN QUERY PLAN`** on hot paths during implementation to catch other misses

### What Changes

| Component | Current | Proposed |
|-----------|---------|----------|
| `raw_events` schema | No consolidation column | `consolidated INTEGER DEFAULT 0` + index |
| `eidetic.ts` | `trimTobudget` drops oldest blindly | Same trim, but returns pressure + unconsolidated eviction flag |
| `proxy.ts` | No consolidation awareness | Reads pressure from trace result, injects fatigue signal |
| `dream-loop.ts` | `setInterval(5min)` + `triggerNow` (dropped if busy) | `setTimeout`-after-completion, adaptive interval from pressure |
| `dream-tools.ts` | `unconsolidatedOnly` via `NOT IN (SELECT ...)` | `WHERE consolidated = 0` + marks groups after processing |
| `dreamer.ts` | No post-pass marking | `UPDATE raw_events SET consolidated = 1` for processed groups |
| `db.ts` | Missing `raw_event_id` index | Add index + `consolidated` column + migration |
| New: `fatigue.ts` | N/A | Pressure computation + fatigue signal text assembly |

### What Doesn't Change

- Raw events are permanent (never deleted)
- `memory_sources` junction table (still tracks which memory came from which events — provenance, not consolidation status)
- Dreaming pipeline (prompt, tools, phases — all unchanged)
- Hippocampus (operates on Tier 2, unaffected)
- FTS5 indexes (unchanged)
- Memory suffix injection mechanism (fatigue signal uses the same injection point)

## Consequences

### Positive

- **Agent proprioception.** The model knows when it's working faster than it can consolidate. It has language to ask the human for a break. A qualitative shift — from a system that silently degrades to one that communicates its limits.
- **Knowledge preservation.** Consolidated events are evicted first (they're oldest, and trimming is oldest-first). The eidetic window is effectively used better — consolidated content at the front is "spent" buffer.
- **Adaptive throughput.** Aggressive dreaming during high-pressure periods closes the consolidation gap faster. Relaxed dreaming during idle periods saves compute. No wasted Haiku calls.
- **No dropped triggers.** `setTimeout`-after-completion eliminates the race between interval timer and trim triggers. Every dream completes before the next is scheduled.
- **Graceful degradation.** Under extreme load, the model gets progressively stronger fatigue signals rather than silent memory loss. Worst case: it still works exactly as today (trim oldest, trigger dream), but the model knows what's happening.
- **Observable.** Consolidation pressure is queryable — dashboard can show a "memory health" gauge. Future menubar app shows green/yellow/red status icon. The agent's cognitive state becomes inspectable.
- **Schema cleanup.** The `consolidated` column and missing index fix long-standing inefficiencies that affect dreaming performance today.

### Negative

- **Schema migration.** Adding a column to `raw_events` requires backfilling existing rows. For agents with large databases, this ALTER + UPDATE could take a moment. Mitigated: `DEFAULT 0` means existing rows are unconsolidated (correct — we can't know if they were processed without checking `memory_sources`, so a one-time backfill query sets `consolidated = 1` for events that have `memory_sources` links).
- **Fatigue signal is advisory.** The model may ignore it. The backpressure is social — the human decides whether to pause. This is by design, not a limitation, but it means pressure can build indefinitely if the human keeps pushing.
- **Adaptive scheduling adds state.** The dream loop needs per-agent pressure tracking. Mitigated: it queries the DB after each pass, no persistent state needed.
- **Pressure estimation is approximate.** Token estimation uses the 4-chars/token heuristic. Pressure thresholds (60%, 85%) are tuning knobs that need calibration against real usage patterns.

### Neutral

- **`memory_sources` role narrows.** It shifts from "consolidation marker" to "provenance tracker." Memory → raw_event links still exist for source tracing, but consolidation status lives on `raw_events.consolidated`.
- **No change to dreaming quality.** The dreamer sees the same events, uses the same tools, makes the same consolidation decisions. Only scheduling and marking change.
- **Eidetic trace pipeline is minimally modified.** `trimTobudget` logic is unchanged. The new work is the watermark query before and the pressure computation after.

## Alternatives Considered

### A. Status quo with faster timer

Reduce the dream loop interval from 5 minutes to 1 minute unconditionally. Simple, no new architecture.

**Rejected:** Wastes compute during idle periods. Doesn't solve the core problem — during burst activity, even 1-minute intervals can't keep up with rapid tool loops that generate 50+ message groups in seconds. No cognitive signal to the agent. Trigger dropping still happens.

### B. Synchronous consolidation barrier

Block the API request until critical events are consolidated. When the consolidation gap exceeds a threshold, hold the response until a dream pass completes.

**Rejected:** Adds seconds to minutes of latency to the user experience. Violates the "all failure modes fall back to pass-through" principle. The user would see Claude "thinking" for 30+ seconds while Haiku consolidates memories. Unacceptable UX.

### C. In-band consolidation (model consolidates its own memories)

Instead of a background Haiku process, give the main model (Opus/Sonnet) tools to consolidate its own memories during conversation. The model would be responsible for its own memory management.

**Rejected:** Consumes the model's attention budget. The whole point of neuromorphic architecture is that consolidation happens in the background (REM sleep analogy). Making the model manage its own memory is the homunculus problem from ADR-002 — a conscious agent deciding what to remember, rather than a structural process that consolidates automatically.

### D. Aggressive raw event deletion

Delete raw events after consolidation (instead of keeping them permanently). Reduces DB size and eliminates the need for consolidation-aware eviction.

**Rejected:** Loses provenance. Memories can't be traced back to source conversations. Dreaming can't re-consolidate if memory quality is poor. Future features (conversation replay, audit trail) become impossible. The user explicitly wants raw events preserved permanently.

### E. Vector-based consolidation priority

Use embeddings to score which unconsolidated events are most "important" and consolidate those first.

**Rejected:** Adds an embedding dependency (violates the no-external-deps principle). The dreaming prompt already handles importance judgment — Haiku's consolidation decisions are qualitative, not geometric. Priority should be temporal (oldest unconsolidated first), not semantic.

### F. Per-message consolidation metadata through the eidetic pipeline

Thread `message_group` and `raw_event_id` through `reconstructMessage`, `validateToolPairing`, `deduplicateConsecutive`, `enforceAlternation` so `trimTobudget` can make per-message eviction decisions.

**Rejected:** Unnecessary complexity. Since dreaming processes oldest-first, consolidated events are always at the front of the trace and unconsolidated at the back. `trimTobudget` already drops oldest-first. "Prefer evicting consolidated" and "evict oldest" are the same operation. A watermark threshold check achieves the same result without modifying the pipeline.

## Implementation Notes

### Watermark query

```sql
SELECT MAX(message_group) FROM raw_events
  WHERE consolidated = 1 AND is_subagent = 0;
```

Single indexed query, O(1) with the `idx_raw_consolidated` index.

### Pressure estimation

```sql
-- Approximate token count of unconsolidated content
SELECT SUM(LENGTH(content)) / 4 FROM raw_events
  WHERE consolidated = 0 AND is_subagent = 0
    AND content_type != 'thinking';
```

Divide by `EIDETIC_BUDGET` (144,000) to get pressure ratio. Same 4-chars/token heuristic used throughout Spotless.

### Migration

```sql
-- Add column (idempotent)
ALTER TABLE raw_events ADD COLUMN consolidated INTEGER NOT NULL DEFAULT 0;

-- Backfill: mark events with memory_sources links as consolidated
UPDATE raw_events SET consolidated = 1
  WHERE id IN (SELECT DISTINCT raw_event_id FROM memory_sources);

-- Add indexes
CREATE INDEX IF NOT EXISTS idx_raw_consolidated
  ON raw_events(consolidated, message_group) WHERE is_subagent = 0;
CREATE INDEX IF NOT EXISTS idx_memory_sources_raw_event
  ON memory_sources(raw_event_id);
```

### Dreamer post-pass marking

After each dream pass (both phases complete), mark all processed groups:

```sql
UPDATE raw_events SET consolidated = 1
  WHERE message_group IN (?, ?, ...) AND is_subagent = 0;
```

This is keyed on the groups that were queried for this pass (the `queryRawEvents` result), not on which events produced memories. "Consolidated" means "the dreamer saw it."

### Fatigue signal placement

Injected in the user message alongside memory suffix and identity tag. Same injection point (proxy.ts lines 160-172), same cache characteristics. Not archived — it's ephemeral system state.

### Dashboard integration

`getConsolidationStatus()` feeds into existing dashboard:

- Consolidation pressure gauge (percentage bar)
- Unconsolidated token count
- Watermark position (message_group)
- Time since last dream pass
- Current adaptive interval
- Fatigue signal level (none/moderate/high)

## Future Work

### ADR-005: Cache-Aware Context Placement

Currently all dynamic content (identity tag, memory suffix, fatigue signal) is injected into the user message. This is cache-optimal — the system prompt (first in the request prefix) stays untouched, getting full KV cache hits.

However, identity, memories, and fatigue are semantically system-level context, not user input. The Anthropic API supports up to 4 `cache_control` breakpoints. A four-level caching strategy could place content at its semantically correct location while preserving cache performance:

1. CC's system prompt [breakpoint] → cached, stable
2. Spotless identity + stable memories [breakpoint] → cached when unchanged
3. Eidetic prefix messages → cached by prefix matching
4. Current user message with fatigue signal + turn-specific memories → dynamic tail

This requires Spotless to manage its own `cache_control` breakpoints (currently it strips CC's breakpoints because they don't align with rewritten messages). Separate ADR to design this properly.

### Menubar App

The dashboard at `/_dashboard/` shows consolidation status via the web. A native menubar app would provide ambient awareness — a status icon (green/yellow/red) based on consolidation pressure, visible without switching to a browser. The app polls the same JSON API endpoints the dashboard uses. Separate sprint.

### Storage Evolution

The `consolidated` column enables a gradual storage migration:
1. Current: flag on `raw_events`
2. Next: `raw_events_archive` table (consolidated rows moved, main table stays small)
3. Later: archive in separate DB file (main DB tight, archive append-only)

Each step is a clean migration with no behavioral changes. Tracked separately.

## References

- ADR-001: Neuromorphic Memory Behaviors (salience, substance filtering)
- ADR-002: Working Self (two-phase dreaming, identity structure)
- ADR-003: Memory Type Architecture (typed lifecycle, archive semantics)
- Spotless PRD: `_project/prds/spotless-prd.md` (three-tier memory model)
- Conway's Self-Memory System: working self as retrieval structure
- Sleep consolidation literature: REM cycles, memory pressure, sleep debt metaphor
