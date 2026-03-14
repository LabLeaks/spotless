# Spotless

Persistent memory system for Claude Code. Local reverse proxy that intercepts API calls, assembles optimally-curated context, and stores everything in per-agent SQLite.

## Runtime

- **Bun** — not Node. Use `bun:sqlite`, `Bun.serve()`, `bun test`.
- No external deps beyond `@types/bun` and `typescript` unless explicitly needed.
- `bun:sqlite` for SQLite — FTS5 confirmed working.
- Bun installed at `~/.bun/bin/bun`. May need `export PATH="$HOME/.bun/bin:$PATH"` in scripts.

## Architecture

See `_project/prds/spotless-prd.md` for the full spec.

- `src/index.ts` — CLI entry point (start/stop/status/code/agents/digest/repair)
- `src/proxy.ts` — HTTP server, agent-based URL routing, SSE forwarding + tapping, message rewriting
- `src/agent.ts` — agent name resolution from URL, DB paths, name generation, listing
- `src/classifier.ts` — turn boundary detection (human turn / tool loop / subagent)
- `src/archiver.ts` — sync archival to SQLite Tier 1, StreamTap for SSE parsing
- `src/history.ts` — history trace builder (queries Tier 1, reconstructs message pairs)
- `src/tokens.ts` — token budget estimation (~4 chars/token heuristic), dynamic history budget computation
- `src/db.ts` — SQLite connection, schema init (Tier 1 + Tier 2 + diagnostic tables), pragmas, `openReadonlyDb()`
- `src/state.ts` — proxy state (cached base, tool loop chain, stop_reason, selector state)
- `src/types.ts` — shared type definitions (incl. MemoryType, Memory, Association, DigestOperation, DigestResult, SelectorResult)
- `src/digest-tools.ts` — SQLite-backed digest tool functions (query, create, merge, supersede, updateSelfConcept, getIdentityFacts, etc.)
- `src/digest-prompt.ts` — digest prompt builder (consolidation + reflection pass prompts)
- `src/digester.ts` — digest orchestrator (two-phase: consolidation → reflection, shared tool-use loop)
- `src/consolidation.ts` — consolidation pressure, watermark, pressure signal, adaptive digest interval scheduling
- `src/digest-loop.ts` — background digest cycle loop (adaptive setTimeout-after-completion, per-agent, pressure-driven)
- `src/recall.ts` — recall pipeline (FTS5 + graph traversal + retrieval scoring + touch/log)
- `src/memory-suffix.ts` — memory suffix assembly (render + inject Tier 2 memories into user message), sliding budget allocation (`computeTier2Allocation`), identity suffix builder (`buildIdentitySuffix`)
- `src/selector-prompt.ts` — selector prompt builder + tool definitions
- `src/selector.ts` — selector orchestrator (spawn haiku, parse memory IDs)
- `src/dashboard.ts` — web dashboard (route handler, JSON API, HTML pages, served at `/_dashboard/`)
- `src/repair.ts` — database diagnostics and repair (diagnose, targeted fix, purge history)

## Auth

**The proxy never touches API keys.** It forwards CC's request headers unchanged. Selector and digesting spawn `claude` on the command line — Claude Code handles its own auth via the user's Claude Max account. There is no API key configuration anywhere in Spotless.

## Conventions

- Strict TypeScript. No `any` unless unavoidable.
- No external HTTP framework — `Bun.serve()` directly.
- SQLite pragmas (`foreign_keys = ON`, `journal_mode = WAL`, `busy_timeout = 5000`) set on every connection.
- Storage at `~/.spotless/agents/<name>/spotless.db` — NOT in `~/.claude/`.
- Agent name from URL: `ANTHROPIC_BASE_URL=http://localhost:9000/agent/<name>`.
- Agent names: lowercase alphanumeric + hyphens, 1-32 chars.

## Testing

- `bun test` runs unit tests. `bun run typecheck` checks types.
- **Always test with real Claude Code, not fake curl requests.** Curl with fake keys proves nothing — the SSE streaming, response archival, and message rewriting are the hard parts.
- To test through the proxy: `CLAUDECODE= ANTHROPIC_BASE_URL=http://localhost:<port>/agent/<name> claude -p "..."`. The `CLAUDECODE=` unset is required to bypass CC's nesting check when running from inside a Claude Code session.
- Or use `spotless code --agent <name>` which handles proxy startup and URL configuration automatically.
- `claude -p` output may appear empty in tool output — check the database to verify what happened.

## Learned

- `bun:sqlite` PRAGMA `busy_timeout` returns key `timeout`, not `busy_timeout`.
- CC sends multiple user content blocks in a single message: system reminders (`<system-reminder>` tags) + actual user text. The history trace builder filters out system reminders since they're session-specific, not conversation content.
- CC sometimes sends brief internal requests (token counting probes like "count"/"I") that don't get classified as subagents because they use the main system prompt. Minor issue, doesn't affect core functionality.
- `claude -p` does include "Primary working directory" in its system prompt — classifier uses this to distinguish main sessions from subagents.
- Never design around API keys. The proxy forwards CC's headers. Selector/digesting run `claude` CLI. Auth is always CC's problem.
- FTS5 external content tables (`content=`) need special delete syntax: `INSERT INTO fts_table(fts_table, rowid, content) VALUES('delete', old.id, old.content)` — not `DELETE FROM fts_table WHERE rowid = old.id`.
- Digesting spawns `claude -p --model haiku` with `CLAUDECODE=""` to bypass CC nesting check. Multi-turn tool-use conversation (each turn is a new `claude -p` invocation with full history).
- Dream operations use `"new_N"` references (0-indexed) so create_association can reference memories created earlier in the same session.
- Selector runs async — starts on each human turn, result used on the NEXT turn. Zero added latency. Memories are one turn behind. Skips CC's `[SUGGESTION MODE: ...]` probes (garbage input that wastes 15s timing out).
- FTS5 query sanitization: split user message into words, wrap each in quotes, join with OR. Handles special characters and long messages.
- Graph traversal: BFS from FTS5 seed hits, follows associations bidirectionally, bounded by maxNodes/minEdgeStrength/maxResults.
- Sliding Tier 2 budget: identity + world-fact memories share a single pool (10% of context budget, floor 12K, cap 60K) computed by `computeTier2Budget()`. `IDENTITY_FLOOR` (2K) and `MEMORY_FLOOR` (2K) minimums within the pool. `computeTier2Allocation()` computes sliding split based on actual token needs. Identity facts flow through selector for contextual selection — tagged `[identity]` in candidates so selector can prioritize but also omit irrelevant ones. Proxy partitions selector result IDs into identity vs world-fact bins, allocates budgets, uses `buildIdentitySuffix()` and `buildMemorySuffix()`. Falls back to agent name on cold start.
- Dynamic history budget: history trace budget computed per-request as `contextBudget - systemTokens - toolsTokens - tier2Budget - SUFFIX_OVERHEAD (1K)`, floored at 20K. `DEFAULT_CONTEXT_BUDGET` = 500K (configurable via `--max-context`). Tier 2 budget scales at 10% of context budget (floor 12K, cap 60K). With 500K context and typical CC overhead (~15K system + ~30K tools), history gets ~404K. Consolidation pressure uses `PRESSURE_BUDGET_CAP` (144K) as denominator — independent of context budget so Haiku digester triggers at the same pace regardless of context window size.
- Memories are never pruned. `pruneMemory()` and `prune_memory` digest tool removed. The `memories_pruned` column in `digest_passes` table kept for schema compat (always 0).
- Memory suffix: `<relevant knowledge>...</relevant knowledge>` tag wrapping chronologically-ordered world-fact content. Prepended to user's actual message. Budget from sliding Tier 2 allocation. Tag framing is agentive — these are the agent's own memories, not external context.
- Agent-experiential framing: Memories are written from the agent's perspective ("I recommended MongoDB and it blew up") not as user dossier ("User prefers PostgreSQL"). Consolidation prompt and identity prompt both enforce this. The agent owns its experiences.
- Selector output: `{"memory_ids": [3, 17, 42]}` — robust parser handles fenced JSON, embedded JSON in prose, clean JSON.
- ADR-001: 5 persistent behaviors (substance filter, pattern separation, salience burst detection, core summary, retrieval scorer) folded into digest prompt + selector pre-computation. No new modules/tables. Three behaviors rejected: temporal decay (ordinal displacement sufficient), competitive salience ("adjacent" undefined), stakes weighting (redundant with retrieval scorer).
- Retrieval scoring for Sprint 5: `score(m) = α·recency + β·salience`, both 0-1, starting weights 1.0 each. Topical relevance excluded — FTS5 is just the trigger, selector judges relevance directly. Pre-computed by proxy before selector invocation.
- Core summary: REMOVED. Was a "project summary" concept that doesn't fit cross-project agents. `evolveCoreSummary()` and `getCoreSummary()` deleted. Working self is now 2-slot: self + relationship.
- Correction stickiness: `supersedeMemory()` archives old memory (`archived_at` = now, `type` = 'fact'), creates corrected memory with `type: 'fact'`, duplicates associations, adds 0.9 breadcrumb link. Old memory preserved for provenance, excluded from FTS5 by triggers. No `[SUPERSEDED]` prefix — archive semantics replaced it (ADR-003).
- Working Self (Working Self): `identity_nodes` table (2 rows: self, relationship) points into the memory graph. Identity = retrieval structure, not stored facts. Nodes seed selector recall, shaping what surfaces.
- Identity architecture (ADR-005+): `evolveIdentity()` and `evolveRelationship()` REMOVED. Identity is computed, not stored. Self-concept = composable facts associated to identity anchors. `updateSelfConcept()` creates/supersedes self-concept facts (type='fact') with anchor association. `getIdentityFacts(db, role)` queries individual facts from graph neighbors (non-archived, strength >= 0.5, ordered by created_at DESC). Identity facts flow through selector for contextual selection (merged at score 100, tagged `[identity]`). Proxy partitions selector results into identity vs world-fact IDs, uses `buildIdentitySuffix()` for `<your identity>` tag with sliding budget from `computeTier2Allocation()`. `recompileIdentityCache()` and `replaceIdentityCache()` REMOVED — no compilation step; identity stays granular like world-facts. `reflectOnSelf()` REMOVED — all reflection output goes through `updateSelfConcept` (supersedable facts, not permanent episodics).
- Significance boost: `markSignificance()` boosts salience +0.15 (capped 0.95), associates to self-model at 0.6. Valuation = retrieval bias, not a separate record.
- Memory types (ADR-005): `MemoryType = "episodic" | "fact"`. Episodic = events, experiences, emotional moments (append-only). Fact = atomic knowledge (current-state, archived when superseded). `affective` and `identity` types removed — affect carried by content text + salience; identity is structural (graph associations to identity_nodes anchors). `migrateAdr005()` rebuilds table with new CHECK constraint, reclassifies old identity/affective → episodic.
- Two-phase digesting: Phase 1 (consolidation) catalogs facts with 12 tools (incl. `type` param on create_memory), third-person framing. Phase 2 (reflection) runs after consolidation with first-person reflective endorsement framing and 4 tools (query_memories, update_self_concept, mark_significance, done). Reflection initial message shows existing associated memories per anchor so haiku can pick `supersedes_id` targets. No post-reflection compilation step — identity facts are read directly by the proxy.
- Reflection pass triggers when: consolidation created new memories. Does NOT trigger on missing identity nodes (anchors are stable).
- `runToolLoop()` is a shared helper for both phases. Validates tool calls against phase-specific `allowedTools` set. Returns error to model if wrong tool called.
- Subagent session boundaries leak into main session: when CC's Task tool runs, each subagent invocation triggers `isNewConversation` → session boundary in the main session's message_group space. These boundaries fall between the main tool_use and its tool_result (groups 20→98 with 11 boundaries in between). The history trace builder then injects `--- new session ---` dividers into the tool_result message, corrupting the API request. Fix: `spotless repair --fix` removes these leaked boundaries.
- `memory_sources.raw_event_id` has no ON DELETE CASCADE — must manually delete memory_sources before deleting referenced raw_events.
- Orphaned tool_results in history trace: when tool_use was from a different/old session and tool_result appears in current session, the API rejects with 400. `validateToolPairing()` now handles both directions (orphaned tool_use AND orphaned tool_result).
- Session dividers MUST NOT be injected into tool_result messages: when a session boundary falls between a tool_use and its tool_result (common with subagent leaks), `prependTextToMessage` was adding `--- new session ---` text into the tool_result user message. The Anthropic API rejects text blocks mixed into tool_result messages that follow an assistant tool_use. Fix: skip session divider injection on user messages that contain tool_result blocks, defer to next text-only user message.
- `cache_control` must be stripped from forwarded requests when rewriting messages. CC adds up to 4 `cache_control: {type: "ephemeral"}` breakpoints across system/messages/tools. Since we replace CC's messages with the history trace, CC's breakpoints no longer align. Any extra breakpoints on the current user message or tools push us over the 4-block API limit → 400 error. Fix: `stripCacheControl()` removes all markers from system, messages, and tools on non-subagent requests. Automatic prefix-matching cache still works on the history trace without explicit markers.
- Tool results in history trace must NOT be truncated — the history trace IS the conversation sent to the API. If the agent reads a file via Read tool, the tool_result is how it sees the file content. Truncating would blind the agent to what it just read. Budget trimming (oldest messages dropped first) is working as designed.
- Consolidation architecture (ADR-004): `raw_events.consolidated` INTEGER column (0/1) — "consolidated" means "the digester saw it." Watermark = `MAX(message_group) WHERE consolidated = 1`. Pressure = unconsolidated tokens / HISTORY_BUDGET. SQL uses `SUM(LENGTH(content)) / 4.0` (float division, not integer). Dreamer marks groups after Phase 2 via `UPDATE raw_events SET consolidated = 1 WHERE message_group IN (...)`. Returns pressure in `DigestResult` so digest loop schedules next pass without separate DB query.
- Adaptive digest scheduling (ADR-004): `setTimeout`-after-completion replaces `setInterval`. Per-agent state: `Map<string, { timeout, pendingEscalate }>`. After each digest pass, `getIntervalForPressure(result.pressure)` determines next interval: 10min (<30%), 3min (30-60%), 1min (60-85%), immediate (>85%). `escalate(agentName)` is synchronous fire-and-forget — sets `pendingEscalate` if agent is currently digesting, triggers immediately if idle. No dropped triggers.
- Pressure signal (ADR-004): `<memory-pressure level="moderate|high">` XML tag injected into user message when consolidation pressure exceeds 60%. Social backpressure — agent asks human to slow down. Not archived (injected after archive point in proxy). Proxy computes pressure on every human turn via `getConsolidationPressure(db)`. Escalation only fires when `pressure >= PRESSURE_HIGH && trimmedCount > 0`.
- `buildHistoryTrace` returns `HistoryTraceResult { messages, trimmedCount, pressure, unconsolidatedTokens }` — trimmedCount is messages dropped by `trimTobudget`, pressure/unconsolidatedTokens feed pressure signal and escalation decision.
- Digest loop bootstrapping: `digestLoop.start()` schedules agents known at startup, but agents are created lazily on first request. `DigestLoop.registerAgent(agentName)` schedules a new agent with relaxed interval (no-op if already known). `ProxyInstance.onAgentInit` callback fires from `getOrInitAgent()` for new agents only. Wired in `cmdStart()` to `digestLoop.registerAgent()`.
- Session boundaries are pre-consolidated: `archiveSessionBoundary()` INSERTs with `consolidated = 1` since they contain no conversation content. Without this, they permanently inflate pressure metrics because `queryRawEvents` filters them out but the pressure query counted them.
- Pressure queries must align with digester content filters: `getConsolidationPressure()` and `getConsolidationStatus()` exclude `<session-boundary />` and `<system-reminder>%` content, matching what `queryRawEvents` actually feeds to the digester.

## Sprint Status

- **Sprint 1**: Done — transparent proxy + archival. 37 unit tests, verified with real CC.
- **Sprint 2**: Done — history trace assembly. Claude remembers across separate `claude -p` invocations. Verified: told Claude personal facts in one invocation, asked in a separate invocation, got correct answer.
- **Sprint 3**: Done — agent-level memory. Memory keyed by named agent (URL path), not project directory. `spotless code` CLI command. 52 unit tests passing.
- **Sprint 4**: Done — digesting (background memory consolidation). Tier 2 schema, 10 digest tool functions, digest prompt, orchestrator, background loop, CLI `digest` command. 120 unit tests passing.
- **Sprint 5**: Done — selector (context assembly from Tier 2) + working self (agent identity). Recall pipeline, memory suffix, selector orchestrator, async proxy integration. Dreamer refactored to two-phase tool-use (consolidation → reflection). Correction stickiness + identity trajectory + working self (identity_nodes, updateSelfConcept, getIdentityFacts, markSignificance). ADR-002 bugs all fixed (M1-M7, A1). 235 unit tests passing.
- **Sprint 6**: Done — web dashboard. `/_dashboard/` served from same `Bun.serve()`, read-only SQLite, inline HTML/CSS/JS. Agent list + detail pages with Memories/Identity/Digests/Selector tabs. `digest_passes` + `selector_runs` diagnostic tables. `ProxyStats` tracking. 264 unit tests passing.
- **ADR-003**: Done — memory type architecture. Typed memories (episodic/fact/affective/identity) with archive lifecycle. Schema migration, FTS5 trigger rebuild, digest tools archive semantics, type classification in digest prompt, recall archived exclusion, dashboard type display. 281 unit tests passing.
- **Sprint 7**: Done — history consolidation & memory pressure (ADR-004). `consolidated` column on `raw_events`, consolidation watermark, adaptive digest scheduling (setTimeout replacing setInterval), pressure signal injection (`<memory-pressure>` tag), dashboard Health tab. 326 unit tests passing.
- **Sprint 8 (ADR-005)**: Done — memory architecture revision. 2 types (episodic/fact) replacing 4. `evolveIdentity`/`evolveRelationship` removed, replaced by composable `updateSelfConcept` + `getIdentityFacts`. `recompileIdentityCache` removed — identity facts served directly as granular list instead of compiled blob. Reflection pass (renamed from identity pass) with reflective endorsement. System prompt augmentation (`<spotless-orientation>`). `<your memories>` → `<relevant knowledge>`. `<memory-architecture>` tag removed. 362 unit tests passing.
- **Sliding Tier 2 Budget**: Done — single 12K pool (`TIER2_BUDGET`) with 2K floors replacing fixed 4K identity + 8K memory split. `computeTier2Allocation()` for sliding budget. Identity facts flow through selector for contextual selection (tagged `[identity]`). `buildIdentitySuffix()` extracted from proxy. Proxy partitions selector results into identity vs world-fact bins. 393 unit tests passing.
- **Terminology Scrub**: Done — replaced neuroscience jargon with grounded engineering terms. eidetic→history, hippocampus→selector, dream/dreaming→digest/digesting, engram→memory graph, neuromorphic→persistent, somatic→significance, Korsgaard removed from code (kept in ADR docs). File renames, identifier renames, DB table migrations (`dream_passes`→`digest_passes`, `hippocampus_runs`→`selector_runs`), CLI `dream`→`digest`, dashboard route/tab renames. Also fixed `computeTier2Allocation` middle case bug (proportional scaling when both bins moderately large). 384 unit tests passing.
- **v0.1.0 Release Prep**: Done — content scrub (genericized personal agent names in ADRs), package metadata (`@lableaks/spotless`, files allowlist, prepublishOnly), CI/CD workflows (test on push/PR, npm publish on tag), README enhancement. Stripped periodic digest scheduling (escalation-only + manual). Published to npm. 384 unit tests passing.

## Known Issues

- Subagent classification may miss CC's internal probes that use the main system prompt.
- Token budget is rough heuristic (4 chars/token). Works for now, refine with real tokenizer later.
- `queryRawEvents` must filter `<session-boundary />` and `<system-reminder>` content from both group discovery and row queries. Without this, digesting gets CC internal metadata instead of real conversation, causing "empty output from claude" and parse failures.
- ~~"Shreds the UI" / ZlibError~~ — **Fixed.** CC sends `Accept-Encoding: gzip`, Anthropic responds compressed, TextDecoder corrupts it. Fix: strip `accept-encoding` from outgoing headers so we get plaintext SSE.

## Bugs Fixed

- **thinking.signature 400 error**: Anthropic API requires a `signature` field on thinking blocks when replayed in messages. Fix: capture `signature` from `signature_delta` SSE events and include it on thinking blocks in the tool loop chain. Thinking is preserved so Claude retains its reasoning during tool loops. Thinking blocks without a signature are dropped (can't replay without it). History trace still excludes thinking (not useful across sessions).
- **orphaned tool_result 400 error**: Tool_result from current session referencing tool_use from old session causes API 400. History trace `validateToolPairing()` now skips orphaned tool_results (no preceding assistant tool_use). Also fixed: subagent boundary leaks injecting `--- new session ---` text into tool_result messages.
- **stdin corruption from interactive picker**: `Bun.stdin.stream()` leaves stdin in raw mode, corrupting input for child `claude` process. Fix: use `node:readline`'s `createInterface` instead.
- **identity not surfacing**: Two compounding bugs. (1) Identity node content was only delivered via selector → memory suffix path; when selector failed, agent only got minimal name tag. Fix: proxy queries `identity_nodes` directly every turn, injects full content in `<your identity>` unconditionally. (2) `initSchema` migration ordering: `rebuildMemoriesFtsTriggers` referenced `archived_at` before `migrateMemoryTypes` added it; `idx_raw_consolidated` referenced `consolidated` before `migrateConsolidated` added it. Both caused `initSchema` to throw on pre-migration DBs → entire request fell back to `forwardSimple` (no history trace, no identity, no memories — vanilla CC). Fix: moved `migrateMemoryTypes` before trigger rebuild, moved `idx_raw_consolidated` out of SCHEMA into `migrateConsolidated`. Also: suggestion mode probes skip selector; `<spotless-orientation>` system prompt augmentation tells agent to draw from injected tags not files.
- **duplicate tool_result 400 error**: Retried requests can archive the same tool_result twice with the same `tool_use_id`. The API rejects "each tool_use must have a single result." Fix: `validateToolPairing()` now tracks seen tool_use_ids and skips duplicate pairs.
- **CC compaction loop**: Static `HISTORY_BUDGET` (144K) didn't account for system prompt, tools, identity, or memory suffix. Total request often exceeded 170-200K tokens, triggering CC's auto-compaction. Next turn, Spotless replaced compacted messages with full 144K trace → compaction again → infinite loop. Fix: dynamic history budget computed per-request (`CONTEXT_BUDGET - system - tools - identity - memory - overhead`), with `CONTEXT_BUDGET = 120_000` (upper end of CC's 80-120K sweet spot). Typical CC session (~15K system + ~30K tools) → ~62K history, keeping total well under 120K.
- **consolidation pressure never decreasing**: Three compounding bugs. (1) Digest loop bootstrapping: agents are created lazily on first request, but `digestLoop.start()` reads agent names at startup (empty). Only escalation (>=85% pressure + trim) could schedule an agent — agents below 85% never got dreamed. Fix: `DigestLoop.registerAgent()` + `ProxyInstance.onAgentInit` callback, wired in `cmdStart()`, so new agents get scheduled on first request. (2) Session boundary orphans: `archiveSessionBoundary()` stored boundaries with `consolidated = 0`, but `queryRawEvents` filters them out — they permanently inflated pressure (~5 tokens each). Fix: INSERT with `consolidated = 1` directly. (3) Pressure query misalignment: `getConsolidationPressure()` counted all unconsolidated content including boundaries and system reminders, but the digester never processes those. Fix: added `AND content != '<session-boundary />' AND content NOT LIKE '<system-reminder>%'` to pressure and status queries.
