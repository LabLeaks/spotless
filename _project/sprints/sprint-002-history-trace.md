# Sprint 002: History Context Assembly

## Status: Complete

## Goal

The proxy rewrites the `messages` array on human turns. Instead of forwarding CC's messages array, it builds a new one from Tier 1: recent conversation turns rendered as real user/assistant message pairs (the "history prefix"), followed by the user's current message. This is the self-accelerating inflection point — after this sprint, Spotless gives CC persistent conversation history that survives compaction.

## Context

- **PRD**: `_project/prds/spotless-prd.md` (Tier 3: Active Context, Layered Message Format)
- **Depends on**: Sprint 1 (proxy + archival — done)
- **What this sprint does NOT do**: No selector, no memory suffix, no Tier 2. Just the history prefix from Tier 1.

## Definition of Done

1. ✅ On human turns, the proxy builds messages from Tier 1 (recent raw_events) instead of forwarding CC's array
2. ✅ Tool loops append onto the cached base correctly
3. ✅ History trace grows monotonically within a session (newest turn appended, cache-friendly)
4. ✅ Oldest turns trimmed from front when approaching token budget
5. ✅ History trace recovered from Tier 1 on proxy restart
6. ✅ Subagents still pass through unchanged
7. ✅ Verified with real Claude Code — multi-turn conversation, tool use, cross-session memory, session boundary awareness

---

## Tasks

### TASK-001: History Trace Builder ✅
Built `src/history.ts` — queries raw_events, groups by message_group, reconstructs Message[] with proper content blocks. Thinking blocks excluded, subagent content excluded, system-reminders filtered.

### TASK-002: Token Budget Estimation ✅
Built `src/tokens.ts` — ~4 chars/token heuristic, HISTORY_BUDGET = 144,000. Trims from front.

### TASK-003: Message Rewriting in Proxy ✅
Wired into proxy.ts on human turns. History prefix built before archiving current message, current message appended at end.

### TASK-004: History Trace Recovery on Restart ✅
Works automatically — buildHistoryTrace queries DB on every human turn. Restart = fresh proxy state but full DB history.

### TASK-005: Real Claude Code Integration Test ✅
Verified: told Claude "personal facts about the project" in one invocation, asked in separate invocation, got correct answer. Cross-session memory works.

---

## Additional Work (discovered during implementation)

### Session Boundary Markers ✅
When `isNewConversation` fires, archives `<session-boundary />` marker to DB. History builder detects these and injects `--- new session ---` dividers into the next user message. Adds `[End of conversation history — new session starting]` assistant message when boundary is at the end (before current request).

### Memory System Preamble ✅
History trace prepends a user/assistant pair explaining the synthetic memory environment: what the messages are, what session dividers mean, how to reference prior context naturally. Model correctly identifies prior sessions: "From our **previous session**, we looked at..."

### Tool Pairing Validation ✅
Validates tool_use/tool_result pairs across the full message sequence. Skips broken pairs (orphaned tool_uses from interrupted sessions or routing bugs) instead of truncating everything. Prevents API 400 "tool use concurrency" errors.

### Alternation Enforcement ✅
After skipping broken pairs, inserts synthetic `[Session interrupted — response not captured]` assistant messages to maintain strict user/assistant alternation. Prevents consecutive same-role messages.

### Deduplication ✅
Removes consecutive identical user messages (from retried failed requests).

---

## Bugs Fixed During Sprint 2

1. **Thinking signature** — API requires `signature` field on replayed thinking blocks. Captured from `signature_delta` SSE events.
2. **ZLib/gzip corruption** — CC sends `Accept-Encoding: gzip`, Anthropic responds compressed, TextDecoder corrupts. Fix: `accept-encoding: identity` in both `forwardSimple` and `forwardStreaming`.
3. **Wrong project DB** — singleton DB sent all data to first project. Fix: `Map<string, Database>` keyed by project hash. (Later replaced entirely by agent-based routing in Sprint 3.)
4. **Orphaned tool_use 400 errors** — interrupted sessions leave tool_use without tool_result. Fix: skip broken pairs instead of truncating.
5. **Duplicate current message** — trace was built after archiving current message, causing it to appear twice. Fix: build trace before archiving.
6. **Session boundary not detected** — boundary groups had no content rows and weren't iterated. Fix: check boundary IDs between consecutive group IDs.

## Key Learnings

- **Model treats history prefix as "this session"** unless explicitly framed. The preamble + session boundary markers + end-of-history assistant message are all needed for the model to correctly attribute prior context to previous sessions.
- **Self-reinforcing wrong answers** — if the model says "I have no cross-session memory" and that response gets archived, future sessions see the model's own denial and reinforce it. Clean test data matters.
- **`bun link` creates symlinks, not copies** — code changes propagate immediately to the global install after `bun link`, but the proxy process must be restarted.
- **Bun's fetch may re-add Accept-Encoding** — deleting the header isn't enough, must explicitly set to `identity`.
- **WebSearch failures are service-side** — 95% empty results for both main agent and subagents. Not proxy-related.
- **Always test with real Claude Code**, not curl with fake API keys.

## Progress Log

### 2026-02-24
- Implemented history.ts and tokens.ts
- Wired into proxy, tested with real CC
- Cross-session memory verified ("personal facts about the project")
- Fixed gzip, thinking signature, multi-project DB routing bugs
- Interactive testing revealed UI thrashing, compression errors — all fixed

### 2026-02-25
- Fixed tool pairing validation (orphaned tool_uses from routing bug)
- Implemented session boundary markers and memory preamble
- Fixed boundary detection bug (boundary groups not iterated)
- Fixed duplicate current message (trace built after archive)
- Added alternation enforcement and deduplication
- Final test: model correctly says "From our **previous session**" — session awareness works
