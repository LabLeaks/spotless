# Sprint 001: Transparent Proxy + Archival

## Status: Complete

> **Note**: Sprint 1 used per-project routing (project path from system prompt → project hash → DB). This was replaced by agent-based routing in Sprint 3 (agent name from URL → DB). The proxy and archival foundations built here remain unchanged.

## Goal

Stand up the Spotless HTTP reverse proxy that sits between Claude Code and the Anthropic API. It passes all requests through transparently (no rewriting yet), while capturing every piece of content to SQLite Tier 1. This is the foundation — nothing else works without a functioning proxy and a filling database.

## Context

- **PRD**: `_project/prds/spotless-prd.md`
- **Runtime**: TypeScript on Bun
- **What this sprint does NOT do**: No eidetic trace assembly, no hippocampus, no dreaming, no message rewriting. Pure pass-through + data capture.

## Definition of Done

1. `spotless start` launches an HTTP proxy on localhost:9000
2. `ANTHROPIC_BASE_URL=http://localhost:9000 claude` works identically to vanilla Claude Code — all features, tool use, subagents, streaming
3. Every human message, tool result, assistant response, and thinking block is archived to `raw_events` in SQLite
4. `raw_events_fts` is populated (excluding thinking blocks)
5. Turn boundaries are correctly classified (human turn / tool loop / subagent)
6. Proxy state tracks cached base position, tool loop chain, and last stop_reason
7. SSE streaming works with no perceptible latency added
8. Graceful shutdown on SIGINT/SIGTERM

---

## Tasks

### TASK-001: Project Scaffolding
**Priority**: P0 | **Size**: S

Initialize the Bun/TypeScript project with the minimal dependency set.

**Deliverable:**
- `package.json` with bun as runtime
- `tsconfig.json` (strict mode)
- `src/` directory structure
- Anthropic SDK as dependency (for types + client usage in later sprints)
- `better-sqlite3` or `bun:sqlite` for SQLite access

**Acceptance Criteria:**
- `bun run src/index.ts` starts without errors
- TypeScript compiles cleanly with strict mode

**Structure:**
```
src/
  index.ts          -- entry point, CLI arg parsing, starts proxy
  proxy.ts          -- HTTP server, request routing, SSE forwarding
  classifier.ts     -- turn boundary detection
  archiver.ts       -- sync archival to SQLite
  db.ts             -- SQLite connection, schema init, pragmas
  state.ts          -- proxy state (cached base, tool loop chain, stop_reason)
  types.ts          -- shared type definitions
```

---

### TASK-002: SQLite Schema + Connection
**Priority**: P0 | **Size**: S

Set up the per-project SQLite database with the Tier 1 schema from the PRD.

**Deliverable:**
- Database initialization at `~/.spotless/<project-hash>/spotless.db`
- All Tier 1 tables, indexes, FTS5 virtual table, and triggers
- Connection pool/factory with required pragmas

**Acceptance Criteria:**
- `PRAGMA foreign_keys` returns ON for every connection
- `PRAGMA journal_mode` returns WAL
- `PRAGMA busy_timeout` returns 5000
- Schema matches PRD exactly (raw_events + raw_events_fts + trigger + all indexes)
- Project hash computed correctly from path (e.g., `/home/user/myproject` -> `-home-user-myproject`)
- Database created automatically on first use
- Idempotent — running schema init on an existing DB is safe (CREATE TABLE IF NOT EXISTS)

**Schema (from PRD):**
```sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS raw_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  message_group INTEGER NOT NULL,
  role TEXT NOT NULL,
  content_type TEXT NOT NULL,
  content TEXT NOT NULL,
  is_subagent INTEGER DEFAULT 0,
  metadata JSON
);

CREATE INDEX IF NOT EXISTS idx_raw_timestamp ON raw_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_raw_not_thinking ON raw_events(timestamp) WHERE content_type != 'thinking';
CREATE INDEX IF NOT EXISTS idx_raw_human_turns ON raw_events(id) WHERE role = 'user' AND content_type = 'text' AND is_subagent = 0;
CREATE INDEX IF NOT EXISTS idx_raw_message_group ON raw_events(message_group);

-- FTS5 doesn't support IF NOT EXISTS, so check programmatically
CREATE VIRTUAL TABLE raw_events_fts USING fts5(content, content=raw_events, content_rowid=id);

CREATE TRIGGER raw_events_fts_insert AFTER INSERT ON raw_events
  WHEN new.content_type != 'thinking' BEGIN
  INSERT INTO raw_events_fts(rowid, content) VALUES (new.id, new.content);
END;
```

---

### TASK-003: Request Classification
**Priority**: P0 | **Size**: S

Implement turn boundary detection per the PRD. The classifier inspects each incoming API request and returns one of: `human_turn`, `tool_loop`, or `subagent`.

**Deliverable:**
- `classifier.ts` — pure function that takes the request body + proxy state, returns classification

**Detection logic:**
- **Subagent**: system prompt lacks "Primary working directory" marker. Check first — subagents are the special case.
- **Human turn**: last message is `role: "user"` with text content (not tool_result). Confirmed by: either no previous response (first request) or previous `stop_reason === "end_turn"`.
- **Tool loop**: last message is `role: "user"` with `tool_result` content.

**Acceptance Criteria:**
- Correctly classifies a first-request-in-conversation as human_turn
- Correctly classifies a tool_result message as tool_loop
- Correctly classifies a request with a short/task-specific system prompt as subagent
- Handles edge cases: empty messages array, messages with mixed content blocks
- Unit tests for all classification paths

---

### TASK-004: SSE Stream Forwarding + Tapping
**Priority**: P0 | **Size**: M

The core proxy loop: receive request from CC, forward to Anthropic, stream SSE response back while capturing content for archival.

This is the most technically sensitive task in the sprint. The proxy must:
1. Forward the request to `api.anthropic.com` (with correct auth headers)
2. Stream the SSE response back to Claude Code byte-for-byte (no buffering that adds latency)
3. Simultaneously tap the stream to extract: text blocks, tool_use blocks, thinking blocks, and stop_reason from `message_delta` events

**Deliverable:**
- `proxy.ts` — HTTP server that handles POST `/v1/messages` (the only endpoint CC uses for chat)
- Passes through all other endpoints unchanged (models list, etc.)
- Auth: reads `ANTHROPIC_API_KEY` from environment (same as CC would)
- SSE tap extracts content blocks and stop_reason without buffering delay

**Key SSE events to tap:**
- `content_block_start` — identifies block type (text, tool_use, thinking)
- `content_block_delta` — accumulates content incrementally
- `content_block_stop` — finalizes a content block
- `message_delta` — contains `stop_reason`
- `message_stop` — end of response

**Acceptance Criteria:**
- `ANTHROPIC_BASE_URL=http://localhost:9000 claude` works for a basic conversation
- Tool use works (Read, Bash, etc.) — CC receives tool_use blocks correctly
- Streaming is visually identical to direct API (no buffering lag)
- Captured response content matches what CC received
- stop_reason correctly extracted from message_delta
- Handles API errors (4xx, 5xx) by forwarding error response to CC
- Handles network errors (Anthropic unreachable) with appropriate error to CC

---

### TASK-005: Proxy State Management
**Priority**: P0 | **Size**: S

Track the conversation state the proxy needs for the tool loop chain (used in Sprint 2) and for turn classification.

**Deliverable:**
- `state.ts` — conversation state object

**State fields:**
- `cachedBase`: the messages array from the last human turn (in Sprint 1, this is just CC's original messages — no rewriting yet). Reset on each human turn.
- `toolLoopChain`: growing array of assistant responses and tool results since last human turn. Captured from SSE tap (assistant) and incoming requests (tool_result). Reset on each human turn.
- `lastStopReason`: extracted from `message_delta` SSE events. Used by classifier to confirm human turns.
- `currentMessageGroup`: sequential integer for grouping content blocks. Initialized from DB on startup (`SELECT COALESCE(MAX(message_group), 0) FROM raw_events`). Incremented per API message.
- `isSubagent`: flag set by classifier, used by archiver.

**Conversation boundary:**
- New conversation: messages array has a single user message (or proxy just started)
- Continuation: everything else (excluding subagents)

**Acceptance Criteria:**
- State resets correctly on new conversation
- State resets correctly on new human turn (cachedBase updated, toolLoopChain cleared)
- message_group increments correctly across content blocks
- stop_reason updates on each response
- State survives tool loops (accumulated chain grows correctly)

---

### TASK-006: Sync Archival to Tier 1
**Priority**: P0 | **Size**: M

Archive content as it flows through the proxy. This is the data capture that makes everything else possible.

**Deliverable:**
- `archiver.ts` — functions to archive request content (sync, before response) and response content (from SSE tap, before next request)

**Archival rules (from PRD):**
- **Human turn request**: extract user's latest message (last item in messages array). Parse content blocks — a text message is one row; a message with multiple content blocks becomes multiple rows sharing the same `message_group`.
- **Tool loop request**: archive the tool_result content from the request.
- **Response stream**: archive each content block captured by the SSE tap. Text, tool_use, and thinking blocks each become a row. Same `message_group` for all blocks in one response.
- **Subagent**: archive all content from the request/response with `is_subagent = 1`.

**message_group assignment:**
- Increment `currentMessageGroup` for each new API message (request user message = one group, response assistant message = next group)
- All content blocks within the same API message share the group number

**metadata column:**
- For tool_use: store `{"tool_name": "Read", "tool_id": "toolu_01..."}`
- For tool_result: store `{"tool_use_id": "toolu_01..."}`
- For thinking: store `{"type": "thinking"}`
- Optional: model name, token counts from message_delta usage field

**Acceptance Criteria:**
- After a conversation with tool use, raw_events contains all messages in order
- message_groups are correctly assigned (all blocks from one API message share a group)
- FTS5 index contains text, tool_use, and tool_result content (not thinking)
- Subagent content is flagged with is_subagent = 1
- Archival is sync — completes before the proxy proceeds with hippocampus (Sprint 2) or next request
- Content matches what actually flowed through (no corruption, no truncation)
- Works with large responses (file reads returning thousands of lines)

---

### TASK-007: Project Path Detection
**Priority**: P1 | **Size**: XS

Extract the project path from the system prompt to determine which SQLite database to use.

**Deliverable:**
- Function that parses system prompt content and extracts the path after "Primary working directory: "
- Computes project hash: replace `/` with `-`, prepend `-`

**Acceptance Criteria:**
- Extracts `/home/user/myproject` from a real Claude Code system prompt
- Returns correct hash: `-home-user-myproject`
- Handles missing marker gracefully (returns a default/fallback)
- Extracted on first request, cached for the session

---

### TASK-008: CLI Entry Point
**Priority**: P1 | **Size**: S

Minimal CLI to start and stop the proxy.

**Deliverable:**
- `spotless start` — starts the proxy on default port 9000 (or `--port N`)
- `spotless stop` — sends SIGTERM to running instance
- `spotless status` — reports if proxy is running and on which port
- PID file at `~/.spotless/spotless.pid` for process management

**Acceptance Criteria:**
- `spotless start` launches proxy in foreground (background/daemon mode is Sprint 5)
- `spotless start --port 9001` works
- `spotless stop` cleanly shuts down the proxy
- `spotless status` correctly reports running/stopped
- SIGINT (Ctrl+C) triggers graceful shutdown
- Double-start is prevented (check PID file)

---

### TASK-009: Integration Test — Full Pass-Through
**Priority**: P1 | **Size**: M

End-to-end test that verifies the complete pass-through + archival pipeline.

**Deliverable:**
- Test script that:
  1. Starts the proxy
  2. Sends a realistic multi-turn conversation through it (using Anthropic SDK pointed at localhost)
  3. Includes: human message, assistant response with tool_use, tool_result, follow-up human message
  4. Verifies raw_events table contains all expected rows
  5. Verifies message_groups are correct
  6. Verifies FTS5 index works (search for a term, get expected hits)
  7. Verifies stop_reason was captured
  8. Stops the proxy

**Acceptance Criteria:**
- Test passes end-to-end with real API calls (requires ANTHROPIC_API_KEY)
- All content blocks accounted for in raw_events
- FTS5 search returns correct results
- No data loss or corruption

---

## Deferred

- **Message rewriting / eidetic trace assembly** — Sprint 2
- **Hippocampus invocation** — Sprint 4
- **Dreaming** — Sprint 3
- **Tier 2 schema** — Sprint 3
- **Background/daemon mode** — Sprint 5
- **Graceful degradation beyond basic error forwarding** — Sprint 5

## Dependencies

- **Anthropic API key**: needed for integration tests and real usage
- **Bun runtime**: must be installed (`curl -fsSL https://bun.sh/install | bash`)

## Risks

- **SSE stream tapping complexity**: simultaneously streaming to CC and extracting content is the trickiest part. If Bun's streams have quirks, this could take longer than expected. Mitigation: prototype TASK-004 early.
- **bun:sqlite + FTS5**: need to verify Bun's built-in SQLite supports FTS5. If not, fall back to `better-sqlite3`. Mitigation: verify in TASK-002 immediately.
- **Auth header forwarding**: CC sets the API key via its own auth mechanism. The proxy needs to forward it correctly or use its own key. Mitigation: inspect actual CC requests in TASK-004.

## Progress Log

*(Updated as work progresses)*
