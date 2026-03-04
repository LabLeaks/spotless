# Sprint 005: Selector (Context Assembly from Tier 2)

## Status: Complete

## Goal

Close the loop: digesting writes memories to Tier 2, the selector reads them back into the conversation. On each human turn, the proxy injects a memory suffix (Tier 2 memories selected by a Haiku selector) into the user's message. After this sprint, Claude has persistent long-term memory across sessions.

## Context

- **PRD**: `_project/prds/spotless-prd.md` (Selector section)
- **ADR**: `_project/adrs/ADR-001-persistent-memory-behaviors.md`
- **Depends on**: Sprint 4 (digesting — done, 120 tests passing)

## Definition of Done

1. On human turns, the proxy injects a memory suffix (selector-selected Tier 2 memories) into the user's message
2. Selector runs async — zero added latency, memories one turn behind
3. Recall pipeline: FTS5 + spreading activation + retrieval scoring (`score = α·recency + β·salience`)
4. Core summary included unconditionally (found by highest salience)
5. Access tracking: selected memories get `last_accessed` and `access_count` updated
6. Retrieval log: co-retrieved memory IDs written to `retrieval_log` for digesting's co-activation signal
7. Graceful degradation: all failures fall back to vanilla (no memories)
8. Digester refactored from single-shot JSON to multi-turn tool-use conversation
9. 182 unit tests passing

---

## Tasks

### TASK-001: Recall Pipeline ✅
Created `src/recall.ts` — FTS5 search + spreading activation + retrieval scoring. Functions: `recall()`, `spreadActivation()`, `scoreMemory()`, `getCoreSummary()`, `touchMemories()`, `logRetrieval()`. FTS5 query sanitization splits user message into quoted words joined with OR.

### TASK-002: Memory Suffix Assembly ✅
Created `src/memory-suffix.ts` — `buildMemorySuffix()` fetches memories by ID in chronological order, renders as `<relevant context>` tag, budget-bounded. `injectMemorySuffix()` prepends to user message (handles string and array content).

### TASK-003: Selector Prompt ✅
Created `src/selector-prompt.ts` — `buildSelectorPrompt()` constructs prompt with user message, project identity, pre-computed recall, core summary, recent raw summary. `SELECTOR_TOOLS` defines 4 tools (recall, get_context_bundle, get_active_state, get_recent_raw).

### TASK-004: Selector Orchestrator ✅
Created `src/selector.ts` — `runSelector()` runs recall → builds prompt → spawns `claude -p --model haiku` → parses `{"memory_ids": [...]}`. Single-shot v1 (no tool-use loop). 15s timeout. All errors return empty result.

### TASK-005: Async Proxy Integration ✅
Modified `src/proxy.ts`, `src/state.ts`, `src/types.ts`. On human turns: inject memory suffix from previous selector result → start selector async for next turn. New ProxyState fields: `lastSelectorResult`, `selectorRunning`, `lastSystemPrompt`. Rapid turn protection: abandon in-flight selector. Helper functions: `extractSystemText()`, `extractUserText()`.

### TASK-006: Token Budget ✅
Added `MEMORY_SUFFIX_BUDGET = 8_000` to `src/tokens.ts`. Logging in proxy for memory suffix injection and selector timing.

### TASK-007: Digester Refactor ✅
Rewrote `src/digester.ts` and `src/digest-prompt.ts`. Single-shot JSON → multi-turn tool-use conversation. Each turn: build prompt with full history → spawn `claude -p` → parse tool call → execute locally → append result → repeat. Max 20 iterations. Digest prompt now includes tool definitions and consolidation goals as system prompt. Initial message is just raw events + retrieval log (small).

### TASK-008: Documentation ✅
Updated CLAUDE.md with new source files, learned patterns, sprint status. Created sprint doc.

### TASK-009: Phenomenological Memory — Correction Stickiness + Identity Trajectory ✅
Added two new digest tool functions in `src/digest-tools.ts`:
- `supersedeMemory()` — atomically handles correction lifecycle: create corrected memory, demote old with `[SUPERSEDED]` prefix + salience 0.1, duplicate associations, create 0.9 breadcrumb link. Old memory preserved (prevents re-learning from raw events).
- `evolveCoreSummary()` — chains core summary versions: new at 1.0, old demoted to 0.7, associations + memory_sources transferred, 0.8 "evolved from" link. Threshold >= 0.9 to identify existing core summary.

Wired into `src/digester.ts` (VALID_TOOLS + executeTool). Updated `src/digest-prompt.ts` with tool definitions and consolidation goals (correction handling, identity trajectory sections). Added `memoriesSuperseded` to `DigestResult` in `src/types.ts`. 14 new tests, 182 total passing.

## New Files

| File | Tests |
|------|-------|
| `src/recall.ts` | `test/recall.test.ts` (12 tests) |
| `src/memory-suffix.ts` | `test/memory-suffix.test.ts` (11 tests) |
| `src/selector-prompt.ts` | `test/selector-prompt.test.ts` (8 tests) |
| `src/selector.ts` | `test/selector.test.ts` (10 tests) |

## Modified Files

| File | Changes |
|------|---------|
| `src/types.ts` | Added SelectorResult, selector state fields to ProxyState |
| `src/state.ts` | New state fields in createProxyState + resetState |
| `src/proxy.ts` | Memory suffix injection, async selector, helper functions |
| `src/tokens.ts` | MEMORY_SUFFIX_BUDGET constant |
| `src/digester.ts` | Full rewrite — multi-turn tool-use loop |
| `src/digest-prompt.ts` | Full rewrite — tool definitions + consolidation goals |
