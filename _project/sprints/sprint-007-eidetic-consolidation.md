# Sprint 007: Eidetic Consolidation & Memory Pressure

## Status: Complete

## Goal

Replace reactive trim-then-dream with proactive consolidation: explicit `consolidated` flag on raw_events, consolidation watermark, adaptive dream scheduling, and fatigue signal injection so the agent can ask the human to slow down when memory pressure builds.

## Context

- **ADR-004**: `_project/adrs/ADR-004-history-consolidation-memory-pressure.md`
- **PRD**: `_project/prds/spotless-prd.md`
- **Prior sprints**: 1-6 complete (proxy, history, agents, digesting, selector, dashboard)
- **Current state**: 281 tests passing, typecheck clean

## Tasks

### TASK-1: Schema Migration — `consolidated` Column + Index Hygiene (S)

**Priority:** P0 — everything else depends on this

**Files:** `src/db.ts`, `test/db.test.ts`

**Description:**
Add `consolidated INTEGER NOT NULL DEFAULT 0` to `raw_events`. Add missing `memory_sources(raw_event_id)` index. Write idempotent migration in `initSchema()`.

**Work:**
- Add `consolidated` column to `SCHEMA` constant (for fresh DBs)
- Add `idx_raw_consolidated` filtered index to `SCHEMA`
- Add `idx_memory_sources_raw_event` index to `TIER2_SCHEMA`
- Write `migrateConsolidated(db)` called from `initSchema()`:
  - `ALTER TABLE raw_events ADD COLUMN consolidated ...` (try/catch idempotent)
  - Backfill: `UPDATE raw_events SET consolidated = 1 WHERE id IN (SELECT DISTINCT raw_event_id FROM memory_sources)`
  - Create indexes if not exists
- Add migration to `initSchema()` after existing `migrateMemoryTypes()`

**Acceptance Criteria:**
- [ ] Fresh DB has `consolidated` column and both new indexes
- [ ] Existing DB gets column added + backfilled from memory_sources
- [ ] Migration is idempotent (run twice, no error)
- [ ] `EXPLAIN QUERY PLAN` on `SELECT ... WHERE consolidated = 0 AND is_subagent = 0` uses the new index
- [ ] Tests verify column exists, backfill works, idempotent

---

### TASK-2: Dream Tools — `unconsolidatedOnly` Uses Column (S)

**Priority:** P0 — digesting must use the new column

**Files:** `src/dream-tools.ts`, `test/dream-tools.test.ts`

**Description:**
Replace the `NOT IN (SELECT raw_event_id FROM memory_sources)` anti-pattern with `WHERE consolidated = 0`.

**Work:**
- `queryRawEvents` unconsolidatedOnly branch: replace subquery with `AND r.consolidated = 0`
- Keep the `memory_sources` join out of this path entirely — consolidation status is now on the column

**⚠️ Test breakage:** The existing `unconsolidatedOnly` test (dream-tools.test.ts:217-233) WILL FAIL after this change. It inserts test data AFTER `initSchema()`, then creates a `memory_sources` link and expects the event to be excluded. But with the new column, `initSchema()` migration backfill already ran (before test data existed), and the test's `memory_sources` INSERT doesn't update the `consolidated` column. The test must be rewritten to set `consolidated = 1` directly on events instead of relying on `memory_sources` links.

**Acceptance Criteria:**
- [ ] `queryRawEvents({ unconsolidatedOnly: true })` returns only rows where `consolidated = 0`
- [ ] `queryRawEvents()` (without flag) returns all rows regardless of consolidated status
- [ ] Existing `unconsolidatedOnly` test REWRITTEN to use `consolidated` column directly
- [ ] All other dream-tools tests still pass
- [ ] New test: insert events, mark some consolidated=1, verify filter excludes them

---

### TASK-3: Dreamer — Post-Pass Marking + Pressure in Result (S)

**Priority:** P0 — digesting must mark what it processed

**Depends on:** TASK-2 (column filter) AND TASK-4 (pressure function)

**Files:** `src/dreamer.ts`, `src/types.ts`, `test/dreamer.test.ts`

**Description:**
After each dream pass (both phases complete), mark all processed message groups as consolidated. "Consolidated" means "the dreamer saw it" — not "a memory was created." Then compute consolidation pressure and return it in `DreamResult` so the dream loop can schedule the next pass without opening the DB again.

**Work:**
- After Phase 2 (or after Phase 1 if identity pass skipped), collect all `message_group` values from the `rawGroups` that were queried
- `UPDATE raw_events SET consolidated = 1 WHERE message_group IN (...) AND is_subagent = 0`
- Wrap in try/catch — non-fatal if marking fails
- After marking, call `getConsolidationPressure(db)` to compute current pressure (uses `EIDETIC_BUDGET` default — no budget param needed in dreamer)
- Add to `DreamResult` (in `src/types.ts`):
  - `groupsConsolidated: number` — count of consolidated groups
  - `pressure: number` — consolidation pressure after this pass (0.0-1.0+)
- The dream loop reads `pressure` from `DreamResult` to schedule the next pass — no separate DB query needed

**Note:** Pressure is also computed independently in the proxy (TASK-5) on every human turn. Both computations are needed because dreamer and proxy run at different times — the dreamer's value feeds dream scheduling, the proxy's value feeds the fatigue signal. They use the same function and budget.

**Acceptance Criteria:**
- [ ] After dream pass, all raw_events in processed groups have `consolidated = 1`
- [ ] Groups not processed remain `consolidated = 0`
- [ ] `DreamResult` includes count of consolidated groups
- [ ] `DreamResult` includes pressure (number, 0.0 when fully consolidated)
- [ ] Subsequent `queryRawEvents({ unconsolidatedOnly: true })` excludes marked groups

---

### TASK-4: Consolidation Module — Pressure, Watermark, Fatigue Signal (S)

**Priority:** P0 — the fatigue signal and adaptive scheduling both need this

**Files:** new `src/consolidation.ts`, `test/consolidation.test.ts`

**Description:**
Single module for all consolidation logic: watermark queries, pressure computation, and fatigue signal builder. Consolidates what was originally two tasks (pressure queries + fatigue builder) since they share types and are both small. Pure functions + cheap DB queries.

**Work:**

*Types:*
- `type PressureLevel = "none" | "moderate" | "high"`
- `type ConsolidationStatus = { watermark: number | null, pressure: number, unconsolidatedTokens: number, totalGroups: number, consolidatedGroups: number }`

*Constants (exported for tuning + reuse by dashboard/dream-loop):*
- `PRESSURE_MODERATE = 0.6`
- `PRESSURE_HIGH = 0.85`
- `DREAM_INTERVAL_RELAXED = 10 * 60 * 1000` (10min, pressure < 30%)
- `DREAM_INTERVAL_NORMAL = 3 * 60 * 1000` (3min, 30-60%)
- `DREAM_INTERVAL_AGGRESSIVE = 60 * 1000` (1min, 60-85%)
- `getIntervalForPressure(pressure: number): number` — maps pressure to interval, returns 0 for immediate (>85%)

*DB queries (all default `budget = EIDETIC_BUDGET` from `tokens.ts`):*
- `getWatermark(db)`: `SELECT MAX(message_group) FROM raw_events WHERE consolidated = 1 AND is_subagent = 0` — returns number or null
- `getConsolidationPressure(db, budget = EIDETIC_BUDGET)`: estimate unconsolidated tokens via `SELECT SUM(LENGTH(content)) / 4.0 FROM raw_events WHERE consolidated = 0 AND is_subagent = 0 AND content_type != 'thinking'`, divide by budget. **Must use `/4.0` (float division)** — SQLite integer division truncates (11/4 = 2, but 11/4.0 = 2.75), consistent with `tokens.ts` which uses `Math.ceil(text.length / 4)`. Returns `{ pressure: number, unconsolidatedTokens: number }`
- `getConsolidationStatus(db, budget = EIDETIC_BUDGET)`: returns full `ConsolidationStatus` (calls getWatermark + getConsolidationPressure + group counts)

*Fatigue signal (pure functions, no DB):*
- `getPressureLevel(pressure: number): PressureLevel` — none (<0.6), moderate (0.6-0.85), high (>=0.85)
- `buildFatigueSignal(pressure: number, unconsolidatedTokens: number): string` — returns empty string for "none", XML tag for moderate/high
- Moderate: gentle awareness message
- High: urgent message asking the human to slow down
- Signal text should feel like proprioception, not a command

**Acceptance Criteria:**
- [ ] Watermark returns null when no events consolidated, correct group when some are
- [ ] Pressure is 0.0 when everything consolidated, >0 when not
- [ ] Pressure uses float division (verified: 11 chars → 2.75 tokens, not 2)
- [ ] Pressure ratio makes sense (tokens, not groups)
- [ ] Returns correct values after marking events consolidated
- [ ] All queries use indexes (verify with EXPLAIN QUERY PLAN in test)
- [ ] Returns empty string when pressure < 0.6
- [ ] Returns `<memory-pressure level="moderate">` block for 0.6-0.85
- [ ] Returns `<memory-pressure level="high">` block for >= 0.85
- [ ] Signal text includes approximate unconsolidated token count
- [ ] Signal is not archived (verified in TASK-5 integration)

---

### TASK-5: Proxy Integration — Pressure + Fatigue Injection (M)

**Priority:** P1 — wires everything together

**Files:** `src/proxy.ts`, `src/history.ts`, `src/types.ts`

**Description:**
On human turns, compute consolidation status, inject fatigue signal into user message, and trigger escalated dreams when pressure is high and trimming occurred.

**Work:**
- `HistoryTraceResult` in `src/history.ts`: add `pressure: number` and `unconsolidatedTokens: number` fields
- In `buildHistoryTrace`: call `getConsolidationPressure(db)` (uses `HISTORY_BUDGET` default), include both `pressure` and `unconsolidatedTokens` in result
- In proxy human_turn block (after building history trace):
  - Read `pressure` and `unconsolidatedTokens` from trace result
  - Call `buildFatigueSignal(pressure, unconsolidatedTokens)`
  - Prepend to `memorySuffix` (before identity tag)
  - **Escalation decision lives in the proxy** (it has both pressure and trimmedCount): if `pressure >= PRESSURE_HIGH && trimmedCount > 0`, call `onEideticTrimmedFn(agentName)`
- `onEideticTrimmed` callback signature stays `(agentName: string) => void` — no change needed. The proxy makes the escalation decision; the dream loop just receives "escalate this agent"
- Fatigue signal must NOT be archived — it's injected into the augmented message only, which is not the message passed to `archiveUserMessage` (archive at proxy.ts:150, augmentation at :166 — safe by design)

**Acceptance Criteria:**
- [ ] `EideticTraceResult` includes `pressure` and `unconsolidatedTokens`
- [ ] Fatigue signal injected when pressure >= 0.6
- [ ] No fatigue signal when pressure < 0.6
- [ ] Signal appears in the API request but NOT in raw_events
- [ ] High pressure + trim triggers escalated dream via `onEideticTrimmed`
- [ ] `onEideticTrimmed` callback signature unchanged — `(agentName: string) => void`
- [ ] Typecheck clean

---

### TASK-6: Adaptive Dream Loop (M)

**Priority:** P1 — eliminates dropped triggers

**Files:** `src/dream-loop.ts`, `src/index.ts`, `test/dream-loop.test.ts` (new)

**Description:**
Replace `setInterval` with `setTimeout`-after-completion. After each dream pass, read pressure from `DreamResult` and schedule the next pass accordingly. No separate DB query needed — the dreamer already computed pressure in TASK-3.

**Work:**
- Per-agent state: `Map<string, { timeout: Timer | null, pendingEscalate: boolean }>` — tracks scheduled timeouts and pending escalations per agent
- `escalate(agentName: string): void` — **synchronous** (fire-and-forget). If agent is currently digesting, set `pendingEscalate = true`; if idle, trigger immediately. The proxy already fire-and-forgets via `.catch()` at index.ts:200, so async is unnecessary
- Replace `setInterval` in `start()` with per-agent `setTimeout` scheduling
- After each `dreamAgent()` completes:
  - Read `pressure` from `DreamResult` (computed in TASK-3, no DB open needed)
  - Call `getIntervalForPressure(pressure)` from `consolidation.ts` (uses exported constants, not magic numbers)
  - If `pendingEscalate` flag is set, clear it and use immediate interval (0)
  - Schedule `setTimeout` for next pass
- Agent discovery: `start()` runs an initial sweep of all known agents. New agents appearing after start are discovered when `escalate(agentName)` is called (proxy calls escalate on trim, which is the first signal that a new agent is active)
- `triggerNow()` still works for manual CLI triggers
- `stop()` clears all pending timeouts in the per-agent map
- Wire `escalate` in `index.ts` (line 200) instead of `triggerNow` for trim callbacks

**Acceptance Criteria:**
- [ ] No `setInterval` in dream-loop.ts
- [ ] `escalate` is synchronous (`void`, not `Promise<DreamResult>`)
- [ ] After dream pass, next scheduled based on `DreamResult.pressure`
- [ ] Escalate during active dream sets `pendingEscalate` (not dropped)
- [ ] Escalate when idle triggers immediately
- [ ] `stop()` cancels all pending timeouts
- [ ] Manual `triggerNow()` still works
- [ ] Dream loop logs current interval on schedule
- [ ] New agents discovered via first `escalate` call

---

### TASK-7: Dashboard — Consolidation Status Panel (S)

**Priority:** P2 — observability

**Files:** `src/dashboard.ts`, `test/dashboard.test.ts`

**Description:**
Add consolidation status to the dashboard API and agent detail page.

**Work:**
- New API endpoint: `/_dashboard/api/agent/:name/consolidation`
  - Returns: `{ watermark, pressure, unconsolidatedTokens, consolidatedGroups, totalGroups, pressureLevel }`
  - **No `currentDreamInterval`** — dashboard has no access to the dream loop object. Instead, compute `expectedInterval` from pressure using the same thresholds as TASK-6 (export the interval-from-pressure function from dream-loop.ts or consolidation.ts)
- Agent detail HTML: new "Health" tab (or top-level status bar on agent page)
  - Pressure gauge (percentage bar, color-coded green/yellow/red)
  - Unconsolidated token count
  - Watermark group number
  - Time since last dream pass (from `dream_passes` table)
  - Fatigue signal level indicator
  - Expected dream interval (computed from pressure thresholds)
- Agent list: add pressure indicator column (dot or bar)

**Acceptance Criteria:**
- [ ] API endpoint returns correct consolidation status
- [ ] Dashboard shows pressure gauge on agent detail
- [ ] Color coding: green (<30%), yellow (30-60%), orange (60-85%), red (>85%)
- [ ] Agent list shows pressure indicator per agent
- [ ] Expected dream interval shown (derived from pressure, not from dream loop state)

---

### TASK-8: Documentation + Final Verification (XS)

**Priority:** P1

**Files:** `CLAUDE.md`, memory files, ADR-004

**Description:**
Update all documentation with the new architecture. Run full verification.

**Work:**
- Update CLAUDE.md: architecture section (consolidation column, fatigue signal, adaptive digesting), sprint status
- Update ADR-004: status from "Proposed" to "Accepted", fix `/4` → `/4.0` in code examples, update `fatigue.ts` → `consolidation.ts`, update "dream loop queries DB" → "dreamer returns pressure in DreamResult", update dashboard `currentDreamInterval` → `expectedInterval`
- Run `bun run typecheck` — clean
- Run `bun test` — all pass
- Manual test: `spotless dream --agent <name>` verifies consolidated marking

**Acceptance Criteria:**
- [ ] CLAUDE.md reflects new architecture
- [ ] ADR-004 status is "Accepted"
- [ ] Typecheck clean
- [ ] All tests pass
- [ ] Git commit with all changes

---

## Task Dependencies

```
TASK-1 (schema)
  ├─→ TASK-2 (dream-tools uses column) ──┐
  ├─→ TASK-4 (consolidation module) ─────┼─→ TASK-3 (dreamer marks + pressure)
  │     └─→ TASK-5 (proxy integration)   │     └─→ TASK-6 (adaptive dream loop)
  └─→ TASK-7 (dashboard)                 │
                                          ↓
                                        TASK-8 (docs + verification)
```

**TASK-3 has TWO dependencies:** TASK-2 (column filter for `queryRawEvents`) AND TASK-4 (`getConsolidationPressure` function). The two tracks converge at TASK-3.

**Critical path:** 1 → 4 → 3 → 6 → 8

**Parallel track:** 1 → 4 → 5 (proxy integration, independent of digesting track after TASK-4)

**Parallelizable after TASK-1:** TASK-2 and TASK-4 are independent. TASK-7 (dashboard) is independent of all. TASK-5 and TASK-3 both depend on TASK-4 but are independent of each other.

## Deferred

- **Storage evolution** (archive table, separate DB) — separate sprint, ADR-004 Future Work
- **Cache-aware context placement** (system prompt injection) — separate ADR-005
- **Menubar app** — separate sprint
- **Pressure threshold calibration** — needs real-world usage data first, tune after deployment

## Risks

- **Pressure thresholds are guesses.** 60% and 85% are starting points. May need tuning after observing real agent behavior under load. Mitigated: thresholds are constants, easy to adjust.
- **Migration on large DBs.** Backfilling `consolidated = 1` via `memory_sources` subquery on a DB with 100k+ raw_events could be slow. Mitigated: one-time cost, runs during `initSchema()`.
- **Fatigue signal ignored.** The model may not act on the `<memory-pressure>` tag. Mitigated: it's advisory by design. Even if the model ignores it, the adaptive scheduling still helps.
- **Existing test breakage in TASK-2.** The `unconsolidatedOnly` test (dream-tools.test.ts:217-233) will fail because `initSchema()` migration runs before test data insertion. Must rewrite test to set `consolidated` column directly. Known and accounted for.

## Audit Notes

### Round 1 — Codebase audit (pre-implementation)

1. **TASK-4+5 merged** into single `src/consolidation.ts` — pressure queries and fatigue signal share types and are both small
2. **Float division** in SQL: `SUM(LENGTH(content)) / 4.0` not `/4` — SQLite integer division truncates
3. **`DreamResult.pressure`** computed in TASK-3 (dreamer), consumed by TASK-6 (dream loop) — no redundant DB query
4. **`escalate()` is sync** (`void`) — proxy fire-and-forgets at index.ts:200, async unnecessary
5. **Per-agent timeout map** in dream loop: `Map<string, { timeout, pendingEscalate }>`
6. **Dashboard `currentDreamInterval` dropped** — compute `expectedInterval` from pressure thresholds instead (dashboard has no dream loop access)
7. **Test rewrite required** in TASK-2 — existing test relies on `memory_sources` join which no longer drives consolidation status

### Round 2 — Internal consistency + conceptual audit

8. **Dependency graph was wrong** — TASK-3 calls `getConsolidationPressure()` from TASK-4, so TASK-3 depends on BOTH TASK-2 and TASK-4. The two tracks converge at TASK-3, not parallel. Critical path updated: 1 → 4 → 3 → 6 → 8
9. **Budget parameter defaulted** — `getConsolidationPressure(db, budget = EIDETIC_BUDGET)` so dreamer calls it without passing budget. Both proxy and dreamer use same default (144k tokens)
10. **Dual pressure computation clarified** — proxy computes on every human turn (for fatigue signal), dreamer computes after each pass (for dream scheduling). Same function, different times, both needed
11. **Escalation decision lives in proxy** — proxy has both `pressure` and `trimmedCount`, makes the `>=0.85 && trimmed` check, then calls `onEideticTrimmed(agentName)`. Callback signature stays `(agentName) => void`. Dream loop's `escalate()` just responds to the signal
12. **TASK-5 uses `getConsolidationPressure`** which now returns `{ pressure, unconsolidatedTokens }` — proxy needs both for `buildFatigueSignal(pressure, unconsolidatedTokens)`
13. **Threshold constants exported** from `consolidation.ts` — `PRESSURE_MODERATE`, `PRESSURE_HIGH`, interval constants, `getIntervalForPressure()`. Dashboard and dream-loop import these instead of hardcoding
14. **ADR-004 sync** added to TASK-8 — fix 4 stale details in ADR (float division, file name, pressure source, dashboard field)

## Progress Log

### 2026-02-27
- Completed TASK-1: Schema migration — `consolidated` column, `idx_raw_consolidated`, `idx_memory_sources_raw_event`, `migrateConsolidated()`, 7 new tests
- Completed TASK-4: Consolidation module — new `src/consolidation.ts` with pressure, watermark, fatigue signal. 24 tests
- Completed TASK-2: Dream tools — replaced `NOT IN (SELECT ...)` with `WHERE consolidated = 0`, rewrote broken test
- Completed TASK-3: Dreamer post-pass marking — `DreamResult.groupsConsolidated` + `DreamResult.pressure`, marks groups after Phase 2
- Completed TASK-5: Proxy integration — `EideticTraceResult` gets pressure/unconsolidatedTokens, fatigue signal injection, escalation on high pressure + trim
- Completed TASK-6: Adaptive dream loop — complete rewrite, setTimeout-after-completion, per-agent state, `escalate()` method, 10 tests
- Completed TASK-7: Dashboard — `apiAgentConsolidation()` endpoint, Health tab with pressure gauge, agent list pressure indicator, 4 new tests
- Completed TASK-8: Documentation — ADR-004 status "Accepted", fixed stale details, updated CLAUDE.md, sprint doc
- Final count: 326 tests passing (10 skip), typecheck clean
