# Sprint 9: Claw Mode (v0.2.0)

## Goal

Ship `spotless claw` as a production-ready persistent autonomous agent command. Agents run inside tmux, survive crashes, auto-restart with resume, communicate via mailbox, and are triggerable by `spotless send`.

## Context

- PRD: `_project/prds/spotless-claw-prd.md`
- Current version: 0.1.1
- 406 tests passing, typecheck clean
- Most of the data layer is done (mailbox table, proxy injection, peer directory, `<spotless-orientation>`, descriptions, session lock). The main gap is the **process management layer**: the current daemon mode uses piped stdin which doesn't work (claude waits for EOF). Solution: tmux.
- tmux is a hard dependency for claw mode only. Regular `spotless code` is unchanged.

## What's Already Done

| Component | Status | Notes |
|---|---|---|
| `mailbox` table + schema | Done | `src/mailbox.ts`, 14 tests |
| `consumeMessages()` + budget cap | Done | Newest-first, 2K token budget, deferred |
| Proxy mailbox injection | Done | On human turns, before memory suffix |
| `augmentSystemPrompt()` + peer directory | Done | `<spotless-orientation>`, 8 tests |
| `getCachedDescription()` (60s TTL) | Done | In `src/proxy.ts` |
| `spotless describe` CLI | Done | Writes `description.txt` |
| `spotless send` CLI (storage) | Done | Writes to recipient mailbox |
| `spotless agents` CLI | Done | Lists agents + descriptions + sizes |
| Session lock | Done | `acquireSessionLock` / `releaseSessionLock` |
| `CLAUDE_CODE_TASK_LIST_ID` env | Done | Persistent task list per agent |
| `RESUME_PROMPT` constant | Done | In `src/index.ts` |
| Resume via mailbox injection | Done | Daemon writes to mailbox on restart |
| Restart loop skeleton | Done | Signal handling, exit code checks |

## What Needs Work

| Component | Status | Notes |
|---|---|---|
| tmux session management | **NEW** | Create/destroy tmux sessions |
| Claw mode → tmux | **REWORK** | Replace `Bun.spawn` stdin pipe with tmux |
| `cmdCode --daemon` fix | **FIX** | `stdin: "pipe"` → `stdio: "inherit"` |
| `spotless send` trigger | **REWORK** | Add `tmux send-keys` after mailbox write |
| `spotless send --all` broadcast | **NEW** | Write to all agent mailboxes + `--all` flag |
| `spotless agents` enhancements | **NEW** | Pending counts + running status |
| Tests for tmux wrapper | **NEW** | Unit tests for arg construction |
| PRD update | **UPDATE** | Reflect tmux design, mark phases done |
| Version bump + release prep | **NEW** | 0.2.0, changelog, README |

---

## Tasks

### TASK-001: tmux wrapper module
**Priority:** P0 (everything depends on this)
**Size:** M

Create `src/tmux.ts` — thin wrapper around tmux shell commands.

Functions:
- `checkTmux()` — verify tmux is installed, throw with install instructions if not
- `createSession(name)` — `tmux new-session -d -s <name>`. If stale session exists (from previous crash), kill it first and recreate
- `hasSession(name)` — `tmux has-session -t <name>` (boolean)
- `sendKeys(session, text)` — uses paste-buffer for safe escaping: `tmux set-buffer`, `tmux paste-buffer`, `tmux send-keys Enter`
- `isShellPrompt(session)` — checks `#{pane_current_command}` against known shells (bash/zsh/sh/fish). Returns true when claude has exited and the pane fell back to the shell. Returns false when claude or any subprocess is running
- `killSession(name)` — `tmux kill-session -t <name>` (no-op if doesn't exist)
- `sendCtrlC(session)` — `tmux send-keys -t <session> C-c`

All functions use `Bun.spawnSync` (fast shell commands).

For testability, export pure arg-building helpers separately:
- `buildSendKeysArgs(session, text): string[]`
- `buildCreateSessionArgs(name): string[]`
- etc.

These are purely functional and unit-testable without tmux installed.

**Acceptance criteria:**
- Module exports all 7 functions + arg-building helpers
- `checkTmux()` throws descriptive error if tmux missing
- `sendKeys()` uses paste-buffer to avoid shell escaping issues
- `createSession()` handles stale sessions (kill + recreate)
- `isShellPrompt()` checks for shell names, not "not claude"
- Unit tests for arg-building helpers (no tmux required)

### TASK-002: `cmdClaw()` — tmux-based persistent agent
**Priority:** P0
**Size:** L

Replace the broken `Bun.spawn` + stdin pipe in claw mode with tmux-based lifecycle. `cmdClaw()` becomes a self-contained function (no longer delegates to `cmdCode()`).

Resume delivery: mailbox only. No resume via tmux sendKeys (avoids redundancy). On restart, resume prompt is written to mailbox, then "." trigger wakes the agent. Proxy injects the resume content on that first turn.

Flow:
```
cmdClaw(agentName):
  checkTmux()
  ensure proxy running (existing code)
  acquireSessionLock (existing code)
  session = "spotless-<agentName>"
  createSession(session)

  loop:
    sendKeys(session, "claude --dangerously-skip-permissions ..." with env vars)

    if restart:
      inject resume prompt into mailbox (existing code)
      sleep 3s  // wait for claude to start
      sendKeys(session, ".")  // trigger first turn, proxy delivers resume

    waitForExit(session):
      poll isShellPrompt() every 2-3s
      when shell detected → claude exited

    if shouldStop → break
    sleep 5s
    continue loop (isRestart = true)

  killSession(session)
  releaseSessionLock()
```

Signal handling:
- SIGTERM/SIGINT → set `shouldStop = true`, `sendCtrlC(session)`, wait 2s, `killSession(session)`, exit

The env vars for the claude command inside tmux:
- `ANTHROPIC_BASE_URL=http://localhost:<port>/agent/<name>`
- `CLAUDE_CODE_TASK_LIST_ID=spotless-<name>` (unless `--local-tasks`)

**Acceptance criteria:**
- `spotless claw --agent maya` creates tmux session `spotless-maya`
- Claude runs interactively inside tmux (remote control works)
- On claude exit: waits 5s, restarts with resume via mailbox + "." trigger
- On SIGTERM: graceful shutdown, no restart
- Session lock prevents concurrent claw on same agent
- `tmux attach -t spotless-maya` works for local debugging
- Stale tmux sessions from previous crashes are cleaned up

### TASK-003: Fix `cmdCode --daemon` to use inherited stdio
**Priority:** P1
**Size:** XS

Current daemon mode in `cmdCode()` uses `stdin: "pipe"` (line 508-513) which breaks claude's interactivity. Change to `stdio: ["inherit", "inherit", "inherit"]`.

Remove the broken mailbox polling timer (lines 516-532) — it writes to the pipe which doesn't trigger turns. Daemon mode without tmux simply restarts on crash; triggering idle agents requires claw mode.

Keep `--yolo` and `--daemon` flags on `cmdCode` — they're composable and useful independently.

**Acceptance criteria:**
- `spotless code --daemon --agent maya` restarts on crash with inherited stdio
- No stdin pipe, no mailbox poll timer
- `--yolo` still works independently
- Resume prompt still injected via mailbox on restart

### TASK-004: `spotless send` with tmux trigger
**Priority:** P0
**Size:** S

After writing to the mailbox (existing code), check if a tmux session exists for the recipient and send a "." trigger.

```
cmdSend():
  ... existing mailbox write ...

  session = "spotless-<agentName>"
  if hasSession(session):
    sendKeys(session, ".")
    log: "triggered agent"
  else:
    log: "message queued (agent not running)"
```

**Acceptance criteria:**
- Messages still written to mailbox (no regression)
- If tmux session exists: sends "." trigger
- If no tmux session: message queued silently (log, no error)
- Log indicates whether trigger was sent

### TASK-005: `spotless send --all` broadcast
**Priority:** P1
**Size:** S

Add `--all` flag to `parseArgs()` and send command. Writes message to every known agent's mailbox (excluding sender if `--from` matches an agent name). Triggers each running agent.

**Acceptance criteria:**
- `spotless send --all --from maya "message"` writes to all agents except maya
- `spotless send --all "message"` writes to all agents (from=human, no exclusion)
- Each running agent gets tmux trigger
- Count of recipients logged

### TASK-006: `spotless agents` enhancements
**Priority:** P2
**Size:** S

Add two columns to `spotless agents` output:

1. **Running status** — check `hasSession("spotless-<name>")` for each agent
2. **Pending message count** — `countPendingMessages()` (already exists)

```
  maya    3.42 MB  "backend infra"     RUNNING  [2 pending]
  kai     1.87 MB  "frontend"          offline
  rio     0.54 MB                      offline
```

Running status check is best-effort — if tmux isn't installed, skip the column entirely (claw mode is optional).

**Acceptance criteria:**
- Running status shown when tmux is available
- Pending count shown when > 0
- Graceful degradation without tmux (no error, just no status column)
- DB opened read-only for count check

### TASK-007: Tests
**Priority:** P1
**Size:** M

- `test/tmux.test.ts` — test pure arg-building helpers (`buildSendKeysArgs`, `buildCreateSessionArgs`, etc.). No tmux installation required
- `test/claw.test.ts` — existing 8 peer directory tests plus:
  - Session name construction (`spotless-<agentName>`)
  - Broadcast logic (send to all excluding sender)
- `test/mailbox.test.ts` — existing 14 tests, no changes needed (broadcast is CLI-level, not mailbox-level)

**Acceptance criteria:**
- All existing 406 tests still pass
- New tests for arg-building helpers
- `bun test` and `bun run typecheck` clean

### TASK-008: Update PRD + docs
**Priority:** P1
**Size:** S

- Update PRD: mark Phase 1-3 done, document tmux architecture, remove stdin references
- Update CLAUDE.md sprint status with Sprint 9
- Update README with claw mode section + tmux requirement note

**Acceptance criteria:**
- PRD accurately reflects implemented architecture
- CLAUDE.md sprint status current
- README has claw mode section

### TASK-009: Version bump + release prep
**Priority:** P1
**Size:** S

- Bump version to 0.2.0 in package.json
- Ensure `bun test` and `bun run typecheck` pass
- Tag and publish

**Acceptance criteria:**
- package.json version = 0.2.0
- All tests pass, typecheck clean
- Git tagged v0.2.0

---

## Deferred (v0.3.0+)

- `spotless install --agent maya` — systemd/launchd service file generation
- Dashboard integration for claw status, restart history, message log
- Health endpoint for external monitoring
- Graceful shutdown protocol (finish current turn then exit)
- External communication channels (Slack, Telegram)
- Replace tmux with embedded pty (if a good Bun-compatible lib emerges)
- tmux pane log capture (`tmux pipe-pane` → `~/.spotless/agents/<name>/claw.log`)

## Execution Order

```
TASK-001 (tmux wrapper)
    |
    +---> TASK-002 (claw daemon — tmux)
    |         |
    |         +---> TASK-004 (send trigger)
    |                   |
    |                   +---> TASK-005 (broadcast)
    |
    +---> TASK-003 (fix cmdCode daemon — XS, independent)
    +---> TASK-006 (agents enhancements — independent)
    |
    All above complete:
    +---> TASK-007 (tests)
    +---> TASK-008 (docs)
    +---> TASK-009 (release)
```

## Progress Log

### 2026-03-13
- Sprint created. Inventory of done vs needed. 406 tests passing, typecheck clean.
- Design: tmux-based architecture. tmux is hard dep for claw only.
- Audit: fixed exit detection (isShellPrompt, not getPaneCommand), removed redundant resume delivery (mailbox only), sized TASK-002 as L, kept --yolo/--daemon on cmdCode, added running status to agents, added stale session cleanup.
- TASK-001: ✅ `src/tmux.ts` — 7 functions + arg builders. 13 tests.
- TASK-002: ✅ `cmdClaw()` rewritten as self-contained tmux lifecycle. Resume via mailbox + "." trigger. isShellPrompt polling. Signal handling.
- TASK-003: ✅ `cmdCode --daemon` fixed: `stdio: "inherit"`, removed broken stdin pipe + poll timer. Extracted `injectResumePrompt()` helper.
- TASK-004: ✅ `spotless send` triggers via tmux. `sendToAgent()` extracted. Logs trigger status.
- TASK-005: ✅ `spotless send --all` broadcast. `--all` flag in parseArgs. Excludes sender.
- TASK-006: ✅ `spotless agents` shows RUNNING/offline status + pending message counts. Graceful without tmux.
- TASK-007: ✅ 422 tests passing (16 new). tmux arg builders, session naming, claw tests.
- Remaining: TASK-008 (docs), TASK-009 (release).
