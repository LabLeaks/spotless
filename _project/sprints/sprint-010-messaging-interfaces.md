# Sprint 10: Messaging Interfaces (v0.2.0)

## Goal

Add Slack (and later WhatsApp, etc.) as first-class interaction interfaces for claw agents. Each message spawns a stateless `claude -p` invocation through the Spotless proxy — memory provides all continuity. This is the alternative to remote control: no persistent session, no auth fragility, no UI bugs.

## Context

- PRD: `_project/prds/spotless-claw-prd.md`
- Sprint 9: Claw mode (tmux, mailbox, peer directory) — tasks 1-7 done
- Current architecture: claw agents run as persistent interactive `claude` sessions inside tmux, controlled via CC's remote control
- Problem: remote control is buggy and fragile. Auth expiry kills the session. Crashes require restart loops
- Insight: **Spotless makes persistent sessions unnecessary.** Every `claude -p` invocation through the proxy gets the full history trace, memory suffix, identity, and peer directory. The agent doesn't need session state — Spotless IS the state

## Architecture

Two claw modes, same agent, same memory:

### Mode 1: Remote Control (Sprint 9, existing)
```
Phone/browser → CC remote control → persistent tmux session → Spotless proxy → Anthropic
```
- Stateful, interactive, fragile
- Agent runs continuously, uses tool loops autonomously
- Good for: hands-on work, debugging, watching the agent think

### Mode 2: Messaging (Sprint 10, new)
```
Slack/WhatsApp → spotless-gateway → claude -p → Spotless proxy → Anthropic → response → Slack/WhatsApp
```
- Stateless, async, resilient
- Each message is an independent invocation — Spotless provides continuity
- Agent can't crash (nothing running between messages)
- Auth expiry: re-auth once, all future messages work
- Good for: async tasks, check-ins, multi-device, always-available agents

### Gateway Process

`spotless gateway --agent maya --slack` starts a long-running process that:
1. Connects to Slack (via Bot Token + Socket Mode — no public URL needed)
2. Listens for messages in a configured channel or DMs
3. On each message: spawns `claude -p "<message>"` with `ANTHROPIC_BASE_URL` pointed at Spotless proxy
4. Streams or posts the response back to Slack
5. That's it. No session, no tmux, no restart loop

The gateway is a thin adapter. All intelligence is in `claude -p` + Spotless.

### Why This Works

Spotless already solves every problem that stateless invocations normally have:
- **No memory?** → History trace + memory suffix + identity
- **No context?** → Selector recalls relevant memories
- **Who am I?** → Working self + `<your identity>`
- **What was I doing?** → History trace shows recent conversation
- **Peer awareness?** → `<spotless-orientation>` with peer directory + mailbox

A `claude -p` through Spotless is indistinguishable from a persistent session, from the agent's perspective.

### Message Flow (Slack)

```
User posts in #maya-agent: "how's the auth migration going?"
    |
    v
Gateway receives Slack event
    |
    v
Gateway spawns: CLAUDECODE="" ANTHROPIC_BASE_URL=http://localhost:9000/agent/maya \
    claude -p "how's the auth migration going?"
    |
    v
Spotless proxy:
    1. Archives the message
    2. Builds history trace (recent turns)
    3. Injects memory suffix (relevant memories)
    4. Injects identity
    5. Checks mailbox (pending inter-agent messages)
    6. Forwards to Anthropic
    |
    v
Claude responds with full context of who it is and what it's been doing
    |
    v
Gateway posts response to Slack
    |
    v
Spotless proxy archives the response
```

### Inter-Agent Messaging

Already works. `spotless send` writes to mailbox, gateway's next `claude -p` picks it up via proxy injection. No tmux trigger needed — the next Slack message triggers the turn naturally.

For proactive messaging (agent wants to reach out), the agent runs `spotless send --agent kai "..."` via Bash tool during its `claude -p` invocation. Kai's gateway picks it up on the next Slack interaction, or Kai's tmux session picks it up immediately.

### Slack Setup

Minimal Slack app:
- **Bot Token** (xoxb-...) — post messages, read channel history
- **App-Level Token** (xapp-...) — Socket Mode (WebSocket, no public URL)
- **Scopes**: `chat:write`, `channels:history`, `im:history`, `im:write`
- **Socket Mode**: enabled (no need to expose server to internet)

Config stored at `~/.spotless/agents/<name>/gateway.json`:
```json
{
  "slack": {
    "bot_token": "xoxb-...",
    "app_token": "xapp-...",
    "channel": "C0123456789"
  }
}
```

### Auth Resilience

The gateway process itself never expires — it's a Bun process with a Slack WebSocket. Only `claude -p` needs CC auth. If auth expires:
1. Gateway catches the error from `claude -p`
2. Runs `claude auth login`, captures the URL
3. Posts the auth URL to Slack: "I need to re-authenticate. Click this link: ..."
4. User clicks, approves in browser
5. Next message works

The agent tells you when it needs help. No monitoring, no SSH, no ntfy.sh.

## Dependencies

- `@anthropic-ai/claude-code` on the server (for `claude -p`)
- Slack Bot Token + App-Level Token (user creates Slack app once)
- No npm Slack SDK — use raw WebSocket for Socket Mode, `fetch` for Web API (zero deps philosophy)

## Tasks

### TASK-001: Gateway core
**Priority:** P0
**Size:** L

Create `src/gateway.ts` — the adapter between messaging platforms and `claude -p`.

Core abstraction:
```typescript
interface MessageAdapter {
  connect(): Promise<void>
  onMessage(handler: (text: string, reply: (text: string) => Promise<void>) => void): void
  disconnect(): Promise<void>
}
```

Gateway process:
- Reads `gateway.json` config for the agent
- Instantiates the appropriate adapter (Slack first)
- On each message: spawns `claude -p` with correct env vars
- Captures output, calls `reply()`
- Handles `claude -p` failures (auth expired, crash, timeout)

CLI: `spotless gateway --agent maya`

**Acceptance criteria:**
- Gateway starts and connects to messaging platform
- Messages trigger `claude -p` invocations
- Responses posted back to channel
- Auth failure detected and reported via messaging platform
- Clean shutdown on SIGTERM

### TASK-002: Slack adapter
**Priority:** P0
**Size:** M

Implement `SlackAdapter` using raw WebSocket (Socket Mode) and `fetch` (Web API). No Slack SDK.

Socket Mode protocol:
1. POST `apps.connections.open` with app token → get WebSocket URL
2. Connect WebSocket, receive `hello` event
3. Receive `events_api` envelopes containing `message` events
4. Acknowledge each envelope immediately (within 3s)
5. Process message async, post response via `chat.postMessage`

Handle:
- Reconnection on WebSocket close
- Ignore bot's own messages (check `bot_id`)
- Thread replies (optional: respond in thread vs channel)
- Rate limiting (Slack tier 1: 1 msg/sec)

**Acceptance criteria:**
- Connects via Socket Mode (no public URL)
- Receives messages, ignores own messages
- Posts responses to correct channel
- Reconnects on disconnect
- Rate limit aware

### TASK-003: Gateway config CLI
**Priority:** P1
**Size:** S

`spotless gateway setup --agent maya --slack` — interactive setup that:
1. Prompts for bot token and app token
2. Prompts for channel ID (or offers to list channels)
3. Writes `~/.spotless/agents/<name>/gateway.json`
4. Tests connection (posts "Gateway connected" to channel)

**Acceptance criteria:**
- Interactive prompts for credentials
- Config written to correct path
- Connection test on setup
- Tokens never logged or displayed after entry

### TASK-004: Auth recovery via messaging
**Priority:** P1
**Size:** S

When `claude -p` fails with an auth error:
1. Run `claude auth login`, capture the URL from stdout
2. Post to Slack: "Authentication expired. Please visit: <url>"
3. Retry the failed message after a delay (poll auth status or wait for next message)

**Acceptance criteria:**
- Auth failure detected from `claude -p` exit code/output
- Auth URL posted to messaging channel
- Next message after re-auth succeeds
- No infinite retry loop

### TASK-005: Multi-response handling
**Priority:** P1
**Size:** M

`claude -p` can produce long responses. Handle:
- Slack's 4000 char message limit (split into multiple messages)
- Streaming (optional): post initial message, edit with updates
- Tool use output (claude -p with tools can produce multi-part output)
- Timeout: kill `claude -p` after configurable duration (default 5min), post partial

**Acceptance criteria:**
- Long responses split correctly at message boundaries
- Timeout prevents runaway invocations
- Partial responses posted on timeout

### TASK-006: `spotless agents` gateway status
**Priority:** P2
**Size:** XS

Add gateway status to `spotless agents` output:
```
  maya    3.42 MB  "backend infra"     RUNNING (claw)
  kai     1.87 MB  "frontend"          RUNNING (slack)    [2 pending]
  rio     0.54 MB                      offline
```

Detect gateway process via PID file at `~/.spotless/agents/<name>/gateway.pid`.

**Acceptance criteria:**
- Gateway status shown (claw/slack/offline)
- PID file written by gateway, cleaned up on exit

### TASK-007: Tests + docs
**Priority:** P1
**Size:** M

- Unit tests for gateway core (mock adapter)
- Unit tests for Slack message parsing/formatting
- Unit tests for auth recovery flow
- Update PRD with Mode 2 architecture
- Update CLAUDE.md
- Update README with gateway section

**Acceptance criteria:**
- All existing tests pass
- New tests for gateway + adapter
- `bun test` and `bun run typecheck` clean
- Docs current

## Execution Order

```
TASK-001 (gateway core)
    |
    +---> TASK-002 (slack adapter)
    |         |
    |         +---> TASK-004 (auth recovery)
    |         +---> TASK-005 (multi-response)
    |
    +---> TASK-003 (config CLI)
    |
    All above complete:
    +---> TASK-006 (agents status)
    +---> TASK-007 (tests + docs)
```

## Deferred

- WhatsApp adapter (Business API or unofficial bridges)
- Discord adapter
- Telegram adapter
- Web chat adapter (simple HTTP endpoint)
- Proactive messaging (agent initiates conversation without being prompted)
- File/image handling in messages
- Slash commands in Slack (`/ask-maya how's the migration?`)
- Multi-channel per agent (different channels for different topics)
