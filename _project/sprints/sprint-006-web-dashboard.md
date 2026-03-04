# Sprint 006: Web Dashboard

## Status: Done

## Goal

Read-only web dashboard for inspecting agent memory, identity, digest passes, and selector runs. Served from the same `Bun.serve()` at `/_dashboard/` routes.

## Completed Tasks

### TASK-1: Schema + DB helpers
- Added `digest_passes` and `selector_runs` tables to `initSchema()` in `src/db.ts`
- Added `openReadonlyDb(path)` — opens with `{ readonly: true }`, sets `busy_timeout = 5000`

### TASK-2: Persist dream pass results
- At end of `runDreamPass()` in `src/dreamer.ts`, INSERT into `dream_passes`
- Non-fatal try/catch — diagnostics never break digesting

### TASK-3: Persist selector runs + proxy stats
- Added `ProxyStats` interface (`startedAt`, `totalRequests`, `agentRequests` map)
- In selector `.then()` handler, INSERT into `selector_runs`
- Added `getStats()` and `getAgentContexts()` to `ProxyInstance`
- Dashboard route check (`/_dashboard*`) at top of fetch handler, before agent routes

### TASK-4: Dashboard API endpoints
- Created `src/dashboard.ts` with `handleDashboardRequest()` route handler
- JSON API: `/api/status`, `/api/agents`, `/api/agent/:name/memories`, `/api/agent/:name/memory/:id`, `/api/agent/:name/identity`, `/api/agent/:name/dreams`, `/api/agent/:name/hippo`
- Read-only DB access: `openReadonlyDb()` per request, closed after

### TASK-5: Dashboard HTML pages
- Index page: proxy status bar, agent cards with counts, auto-refresh
- Agent detail page: 4 tabs (Memories, Identity, Dreams, Hippocampus)
- Dark theme, monospace, vanilla JS, no external dependencies

### TASK-6: Tests
- 29 new tests in `test/dashboard.test.ts`
- Schema: diagnostic tables created, accept valid INSERTs
- `openReadonlyDb`: reads data, rejects writes
- Routing: returns null for non-dashboard, Response for dashboard paths
- API: status returns stats, agents returns array, unknown agent 404
- Persistence: digest_passes and selector_runs roundtrip

### TASK-7: Documentation
- Updated `CLAUDE.md`: architecture section, sprint status
- Created this sprint doc

## Test Results

264 tests passing (29 new), 0 failures.

## Files Modified

| File | Changes |
|------|---------|
| `src/db.ts` | `digest_passes` + `selector_runs` tables, `openReadonlyDb()` |
| `src/dreamer.ts` | Persist `DreamResult` to `dream_passes` after each pass |
| `src/proxy.ts` | `ProxyStats`, hippo persistence, dashboard routing, `getStats()`/`getAgentContexts()` |
| `src/dashboard.ts` | **NEW** — route handler, JSON API, HTML pages |
| `test/dashboard.test.ts` | **NEW** — 29 tests |
| `CLAUDE.md` | Architecture + sprint status |
| `_project/sprints/sprint-006-web-dashboard.md` | **NEW** — this file |
