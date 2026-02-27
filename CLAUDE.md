# Spotless

Neuromorphic memory system for Claude Code. Local reverse proxy that intercepts API calls, assembles optimally-curated context, and stores everything in per-agent SQLite.

## Runtime

- **Bun** — not Node. Use `bun:sqlite`, `Bun.serve()`, `bun test`.
- No external deps beyond `@types/bun` and `typescript` unless explicitly needed.
- `bun:sqlite` for SQLite — FTS5 confirmed working.
- Bun installed at `~/.bun/bin/bun`. May need `export PATH="$HOME/.bun/bin:$PATH"` in scripts.

## Architecture

See `_project/prds/spotless-prd.md` for the full spec.

- `src/index.ts` — CLI entry point (start/stop/status/code/agents/dream/repair)
- `src/proxy.ts` — HTTP server, agent-based URL routing, SSE forwarding + tapping, message rewriting
- `src/agent.ts` — agent name resolution from URL, DB paths, name generation, listing
- `src/classifier.ts` — turn boundary detection (human turn / tool loop / subagent)
- `src/archiver.ts` — sync archival to SQLite Tier 1, StreamTap for SSE parsing
- `src/eidetic.ts` — eidetic trace builder (queries Tier 1, reconstructs message pairs)
- `src/tokens.ts` — token budget estimation (~4 chars/token heuristic)
- `src/db.ts` — SQLite connection, schema init (Tier 1 + Tier 2 + diagnostic tables), pragmas, `openReadonlyDb()`
- `src/state.ts` — proxy state (cached base, tool loop chain, stop_reason, hippocampus state)
- `src/types.ts` — shared type definitions (incl. MemoryType, Memory, Association, DreamOperation, DreamResult, HippoResult)
- `src/dream-tools.ts` — 15 SQLite-backed dream tool functions (query, create, merge, prune, supersede, identity tools, etc.)
- `src/dream-prompt.ts` — dreaming prompt builder (consolidation + identity pass prompts)
- `src/dreamer.ts` — dreaming orchestrator (two-phase: consolidation → identity, shared tool-use loop)
- `src/dream-loop.ts` — background REM cycle loop (configurable interval, per-agent, trim-triggered)
- `src/recall.ts` — recall pipeline (FTS5 + spreading activation + retrieval scoring + touch/log)
- `src/memory-suffix.ts` — memory suffix assembly (render + inject Tier 2 memories into user message)
- `src/hippo-prompt.ts` — hippocampus prompt builder + tool definitions
- `src/hippocampus.ts` — hippocampus orchestrator (spawn haiku, parse memory IDs)
- `src/dashboard.ts` — web dashboard (route handler, JSON API, HTML pages, served at `/_dashboard/`)
- `src/repair.ts` — database diagnostics and repair (diagnose, targeted fix, purge eidetic)

## Auth

**The proxy never touches API keys.** It forwards CC's request headers unchanged. Hippocampus and dreaming spawn `claude` on the command line — Claude Code handles its own auth via the user's Claude Max account. There is no API key configuration anywhere in Spotless.

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
- CC sends multiple user content blocks in a single message: system reminders (`<system-reminder>` tags) + actual user text. The eidetic trace builder filters out system reminders since they're session-specific, not conversation content.
- CC sometimes sends brief internal requests (token counting probes like "count"/"I") that don't get classified as subagents because they use the main system prompt. Minor issue, doesn't affect core functionality.
- `claude -p` does include "Primary working directory" in its system prompt — classifier uses this to distinguish main sessions from subagents.
- Never design around API keys. The proxy forwards CC's headers. Hippocampus/dreaming run `claude` CLI. Auth is always CC's problem.
- FTS5 external content tables (`content=`) need special delete syntax: `INSERT INTO fts_table(fts_table, rowid, content) VALUES('delete', old.id, old.content)` — not `DELETE FROM fts_table WHERE rowid = old.id`.
- Dreaming spawns `claude -p --model haiku` with `CLAUDECODE=""` to bypass CC nesting check. Multi-turn tool-use conversation (each turn is a new `claude -p` invocation with full history).
- Dream operations use `"new_N"` references (0-indexed) so create_association can reference memories created earlier in the same session.
- Hippocampus runs async — starts on each human turn, result used on the NEXT turn. Zero added latency. Memories are one turn behind.
- FTS5 query sanitization: split user message into words, wrap each in quotes, join with OR. Handles special characters and long messages.
- Spreading activation: BFS from FTS5 seed hits, follows associations bidirectionally, bounded by maxNodes/minEdgeStrength/maxResults.
- Memory suffix: `<your memories>...</your memories>` tag wrapping chronologically-ordered memory content. Prepended to user's actual message. Budget-bounded (8000 tokens default). Tag framing is agentive — these are the agent's own memories, not external context.
- Agent-experiential framing: Memories are written from the agent's perspective ("I recommended MongoDB and it blew up") not as user dossier ("User prefers PostgreSQL"). Consolidation prompt and identity prompt both enforce this. The agent owns its experiences.
- Hippocampus output: `{"memory_ids": [3, 17, 42]}` — robust parser handles fenced JSON, embedded JSON in prose, clean JSON.
- ADR-001: 5 neuromorphic behaviors (substance filter, pattern separation, salience burst detection, core summary, retrieval scorer) folded into dreaming prompt + hippocampus pre-computation. No new modules/tables. Three behaviors rejected: temporal decay (ordinal displacement sufficient), competitive salience ("adjacent" undefined), stakes weighting (redundant with retrieval scorer).
- Retrieval scoring for Sprint 5: `score(m) = α·recency + β·salience`, both 0-1, starting weights 1.0 each. Topical relevance excluded — FTS5 is just the trigger, hippocampus judges relevance directly. Pre-computed by proxy before hippocampus invocation.
- Core summary: REMOVED. Was a "project summary" concept that doesn't fit cross-project agents. `evolveCoreSummary()` and `getCoreSummary()` deleted. Working self is now 2-slot: self + relationship.
- Correction stickiness: `supersedeMemory()` archives old memory (`archived_at` = now, `type` = 'fact'), creates corrected memory with `type: 'fact'`, duplicates associations, adds 0.9 breadcrumb link. Old memory preserved for provenance, excluded from FTS5 by triggers. No `[SUPERSEDED]` prefix — archive semantics replaced it (ADR-003).
- Working Self (Conway's Self-Memory System): `identity_nodes` table (2 rows: self, relationship) points into the memory graph. Identity = retrieval structure, not stored facts. Nodes seed hippocampus recall, shaping what surfaces.
- Self-referential encoding: `reflectOnSelf()` creates memories at 0.85 salience, associated to self-model node at 0.8. Richer connectivity = stronger retrieval.
- Identity evolution: `evolveIdentity()` (self-model, 0.9) and `evolveRelationship()` (agent-user dynamic, 0.85). Identity is current-state: old version archived (`archived_at` = now) after transferring associations + sources to new. No accumulation, no chain. One active memory per role. Archive preserves provenance, FTS5 triggers exclude archived rows (ADR-003).
- Somatic markers: `markSignificance()` boosts salience +0.15 (capped 0.95), associates to self-model at 0.6. Valuation = retrieval bias, not a separate record.
- Memory types (ADR-003): `MemoryType = "episodic" | "fact" | "affective" | "identity"`. Permanent types (episodic, affective) accumulate. Current-state types (fact, identity) get archived when superseded/evolved — `archived_at` timestamp set, FTS5 triggers exclude from search, original content preserved for provenance. `memories` table has `type TEXT NOT NULL DEFAULT 'episodic' CHECK(...)` and `archived_at INTEGER`. Migration classifies existing rows: identity_nodes refs → 'identity', `[SUPERSEDED]` content → archived facts. `queryMemories` excludes archived by default (`includeArchived` flag). `cleanupConsolidatedFromFts()` removes consolidated raw_events from FTS5 after dreaming.
- Two-phase dreaming: Phase 1 (consolidation) catalogs facts with 12 tools (incl. `type` param on create_memory), third-person framing. Phase 2 (identity) runs deterministically after consolidation with first-person framing and 6 tools (query_memories + 4 identity + done). Fixes homunculus problem where Haiku wouldn't call identity tools among many others.
- Identity pass triggers when: consolidation created new memories OR self/relationship identity nodes are missing. Skips when nothing to reflect on and identity is complete.
- `runToolLoop()` is a shared helper for both phases. Validates tool calls against phase-specific `allowedTools` set. Returns error to model if wrong tool called.
- Subagent session boundaries leak into main session: when CC's Task tool runs, each subagent invocation triggers `isNewConversation` → session boundary in the main session's message_group space. These boundaries fall between the main tool_use and its tool_result (groups 20→98 with 11 boundaries in between). The eidetic trace builder then injects `--- new session ---` dividers into the tool_result message, corrupting the API request. Fix: `spotless repair --fix` removes these leaked boundaries.
- `memory_sources.raw_event_id` has no ON DELETE CASCADE — must manually delete memory_sources before deleting referenced raw_events.
- Orphaned tool_results in eidetic trace: when tool_use was from a different/old session and tool_result appears in current session, the API rejects with 400. `validateToolPairing()` now handles both directions (orphaned tool_use AND orphaned tool_result).
- Session dividers MUST NOT be injected into tool_result messages: when a session boundary falls between a tool_use and its tool_result (common with subagent leaks), `prependTextToMessage` was adding `--- new session ---` text into the tool_result user message. The Anthropic API rejects text blocks mixed into tool_result messages that follow an assistant tool_use. Fix: skip session divider injection on user messages that contain tool_result blocks, defer to next text-only user message.
- `cache_control` must be stripped from forwarded requests when rewriting messages. CC adds up to 4 `cache_control: {type: "ephemeral"}` breakpoints across system/messages/tools. Since we replace CC's messages with the eidetic trace, CC's breakpoints no longer align. Any extra breakpoints on the current user message or tools push us over the 4-block API limit → 400 error. Fix: `stripCacheControl()` removes all markers from system, messages, and tools on non-subagent requests. Automatic prefix-matching cache still works on the eidetic trace without explicit markers.
- Tool results in eidetic trace must NOT be truncated — the eidetic trace IS the conversation sent to the API. If the agent reads a file via Read tool, the tool_result is how it sees the file content. Truncating would blind the agent to what it just read. Budget trimming (oldest messages dropped first) is working as designed.
- Trim-triggered dreaming: when `buildEideticTrace` trims messages from the eidetic prefix (budget overflow), `proxy.onEideticTrimmed` fires a dream for that agent immediately via `dreamLoop.triggerNow()`. Hybrid model: 5-min timer for background sweep + trim events for burst consolidation during active use. The `dreaming` Set in dream-loop prevents concurrent dreams per agent. `buildEideticTrace` returns `EideticTraceResult { messages, trimmedCount }` — trimmedCount is the number of messages dropped from front by `trimTobudget`.

## Sprint Status

- **Sprint 1**: Done — transparent proxy + archival. 37 unit tests, verified with real CC.
- **Sprint 2**: Done — eidetic trace assembly. Claude remembers across separate `claude -p` invocations. Verified: told Claude "favorite color is purple, dog is Biscuit" in one invocation, asked in a separate invocation, got correct answer.
- **Sprint 3**: Done — agent-level memory. Memory keyed by named agent (URL path), not project directory. `spotless code` CLI command. 52 unit tests passing.
- **Sprint 4**: Done — dreaming (background memory consolidation). Tier 2 schema, 10 dream tool functions, dreaming prompt, orchestrator, background loop, CLI `dream` command. 120 unit tests passing.
- **Sprint 5**: Done — hippocampus (context assembly from Tier 2) + working self (agent identity). Recall pipeline, memory suffix, hippocampus orchestrator, async proxy integration. Dreamer refactored to two-phase tool-use (consolidation → identity). Correction stickiness + identity trajectory + working self (identity_nodes, reflectOnSelf, evolveIdentity, evolveRelationship, markSignificance). ADR-002 bugs all fixed (M1-M7, A1). 235 unit tests passing.
- **Sprint 6**: Done — web dashboard. `/_dashboard/` served from same `Bun.serve()`, read-only SQLite, inline HTML/CSS/JS. Agent list + detail pages with Memories/Identity/Dreams/Hippocampus tabs. `dream_passes` + `hippocampus_runs` diagnostic tables. `ProxyStats` tracking. 264 unit tests passing.
- **ADR-003**: Done — memory type architecture. Typed memories (episodic/fact/affective/identity) with archive lifecycle. Schema migration, FTS5 trigger rebuild, dream tools archive semantics, type classification in dream prompt, recall archived exclusion, dashboard type display. 281 unit tests passing.

## Known Issues

- Subagent classification may miss CC's internal probes that use the main system prompt.
- Token budget is rough heuristic (4 chars/token). Works for now, refine with real tokenizer later.
- `queryRawEvents` must filter `<session-boundary />` and `<system-reminder>` content from both group discovery and row queries. Without this, dreaming gets CC internal metadata instead of real conversation, causing "empty output from claude" and parse failures.
- ~~"Shreds the UI" / ZlibError~~ — **Fixed.** CC sends `Accept-Encoding: gzip`, Anthropic responds compressed, TextDecoder corrupts it. Fix: strip `accept-encoding` from outgoing headers so we get plaintext SSE.

## Bugs Fixed

- **thinking.signature 400 error**: Anthropic API requires a `signature` field on thinking blocks when replayed in messages. Fix: capture `signature` from `signature_delta` SSE events and include it on thinking blocks in the tool loop chain. Thinking is preserved so Claude retains its reasoning during tool loops. Thinking blocks without a signature are dropped (can't replay without it). Eidetic trace still excludes thinking (not useful across sessions).
- **orphaned tool_result 400 error**: Tool_result from current session referencing tool_use from old session causes API 400. Eidetic trace `validateToolPairing()` now skips orphaned tool_results (no preceding assistant tool_use). Also fixed: subagent boundary leaks injecting `--- new session ---` text into tool_result messages.
- **stdin corruption from interactive picker**: `Bun.stdin.stream()` leaves stdin in raw mode, corrupting input for child `claude` process. Fix: use `node:readline`'s `createInterface` instead.
