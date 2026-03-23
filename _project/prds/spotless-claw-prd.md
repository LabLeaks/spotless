# Spotless Claw: Persistent Autonomous Agents

## Problem

Spotless gives Claude Code agents memory, identity, and contextual recall across sessions. But each session is still manually initiated — a human runs `spotless code --agent maya`, works interactively, exits. The agent's soul persists but its body doesn't.

The emerging "claw" pattern (persistent cloud agents) solves this: an agent runs continuously on a remote machine, accessible via Claude Code's built-in remote control from a phone. The agent works autonomously on tasks, survives crashes and restarts, and picks up where it left off.

Spotless is uniquely positioned here. Every other claw implementation (OpenClaw, Epiphyte, Agent Farm) uses flat files for memory — `SOUL.md`, `MEMORY.md`, `progress.txt`. Spotless has an associative memory graph with FTS5 search, contextual selector, background digesting, and working self. The soul already exists. We just need the body.

## Goals

1. **`spotless claw`** — a dedicated command that runs an agent as a persistent autonomous process
2. **Auto-restart with resume** — crash recovery and periodic restarts (for CC updates) that resume in-flight work via persistent task list + memory
3. **Multi-agent** — multiple named agents running simultaneously on the same machine, each with their own session
4. **Inter-agent communication** — agents can send messages to each other through Spotless-mediated channels
5. **Stay native to Claude Code** — no custom tools, no MCP servers, no forks. Use CC's built-in capabilities (remote control, task API, `--dangerously-skip-permissions`). Legally compatible with Max subscription.

## Non-Goals

- Multi-machine coordination — single machine for now
- Custom orchestration layer — CC is the orchestrator, Spotless is the soul
- API key billing — designed for Max subscription via `claude` binary

## Architecture

```
Phone (remote control)
    |
    v
tmux session "spotless-maya"
    |
    v
Claude Code (interactive, --dangerously-skip-permissions)
    |
    v
Spotless proxy (localhost:9000)
    |
    +---> Agent "maya" DB (memory, identity, tasks, mailbox)
    +---> Agent "kai" DB (memory, identity, tasks, mailbox)
    |
    v
Anthropic API
```

Each agent is an independent `claude` process running inside a tmux session, managed by `spotless claw`. The proxy is shared — all agents route through the same `Bun.serve()` on the same port, differentiated by URL path (`/agent/maya`, `/agent/kai`).

tmux provides:
- A pseudo-terminal so claude runs interactively (remote control works)
- Keystroke injection via `tmux send-keys` (for `spotless send` triggers)
- Process isolation (attach/detach without killing the agent)

tmux is a hard dependency for claw mode only. Regular `spotless code` uses inherited stdio.

## Agent Registry & Peer Awareness

Agents need two layers of awareness about their peers:

### Layer 1: Registry (Structural)

Each agent has a self-description — a short line explaining what it does. Stored at `~/.spotless/agents/<name>/description.txt`. Set via CLI or by the agent itself:

```
spotless describe --agent maya "backend infrastructure, API design, database migrations"
```

An agent can update its own description by writing to its description file. This is the agent's **advertisement** — how it wants to be known.

The proxy reads all agent descriptions at request time and injects a peer directory into `<spotless-orientation>`:

```xml
<spotless-orientation>
...
You can communicate with other agents on this machine:
- To send: run `spotless send --agent <name> --from <your-name> "<message>"` via Bash
- Incoming messages appear as <message from="..."> tags in your input
- Known agents:
  - kai: frontend development, React, design systems
  - rio: devops, CI/CD, infrastructure
</spotless-orientation>
```

This is factual plumbing — "here are the names and self-descriptions of agents you can reach." The current agent is excluded from the list.

### Layer 2: Relational Memory (Experiential)

The agent's *own understanding* of its peers is built through interaction, not configuration. When Maya receives `<message from="kai">` content, it flows through the normal pipeline:

1. Message content is in the API request → archived as `raw_events`
2. Digester processes it → creates memories ("Kai told me the React migration is blocked on the new auth tokens")
3. Over time, the agent accumulates experiential knowledge: who's reliable, who's fast, who gives good advice, who tends to over-engineer

This is just Spotless working as designed. No new mechanism needed. The agent-experiential framing already ensures memories are first-person: "Kai told me X" not "Kai said X to Maya."

The registry tells the agent *who exists*. Memory tells the agent *who they really are*.

## Command: `spotless claw`

```
spotless claw --agent <name> [--port 9000] [--local-tasks] [-- ...claude args]
```

Equivalent to `spotless code --agent <name> --yolo --daemon` but as a first-class command. Implies:

- `--dangerously-skip-permissions` passed to `claude` (autonomous operation)
- Persistent task list (`CLAUDE_CODE_TASK_LIST_ID=spotless-<name>`)
- Auto-restart loop on exit (crash recovery)
- Resume prompt on restart (check tasks, continue work)
- Session lock (prevents concurrent sessions on same agent)

### Lifecycle

```
spotless claw --agent maya
    |
    +---> Ensure proxy running (start if needed)
    +---> Acquire session lock
    +---> Launch: claude --dangerously-skip-permissions [...claude args]
    |       env: ANTHROPIC_BASE_URL, CLAUDE_CODE_TASK_LIST_ID
    |
    |     (agent runs autonomously, controlled via remote control)
    |
    +---> Agent exits (crash, CC update, natural completion)
    |
    +---> Was it SIGTERM/SIGINT? → Release lock, exit
    +---> Otherwise → Wait 5s, re-launch with resume prompt:
    |       claude --dangerously-skip-permissions -p "<resume prompt>"
    |
    +---> Loop
```

### Resume Prompt

On restart (not first run), the agent receives:

```
You just restarted. Check your task list for any in-progress or pending
work and continue where you left off. Your memory and identity are intact.
```

This combines with:
- **Persistent task list** — CC reads from `~/.claude/tasks/spotless-<name>/` on startup
- **History trace** — Spotless injects the agent's recent conversation history
- **Memory suffix** — selector provides relevant memories from Tier 2
- **Identity** — working self is always present via `<your identity>`

The agent has everything it needs to orient and resume.

### Planned Restart (CC Updates)

To pick up a new CC version:

1. Send the agent a message via remote control: "finish your current task and exit"
2. Agent completes, exits naturally
3. Daemon restarts with new `claude` binary
4. Resume prompt kicks in

Alternatively, `SIGTERM` the `claude` process directly. The daemon detects the signal exit and stops (no restart). Then manually re-run `spotless claw`. For automated rolling restarts, a wrapper script or systemd timer can handle this.

## Inter-Agent Communication

### Problem

Multiple agents on the same machine may need to coordinate. Maya finishes the auth migration and needs to tell Kai the API contracts changed. Without a channel, they're isolated — each sees only their own memory and history.

### Design: CLI Send + Proxy Inject

Communication uses two components:

1. **`spotless send`** — CLI command that writes a message to the recipient's mailbox
2. **Proxy injection** — messages appear in the recipient's context on the next turn

#### Sending

```
spotless send --agent kai --from maya "auth migration done, new endpoints are..."
spotless send --agent kai --from ci "build #847 failed on main"
spotless send --agent kai "hey, check the deploy"   # --from defaults to "human"
```

Anyone can send: another agent (via Bash tool), a human, a CI script, a webhook handler. The command writes to the recipient's `mailbox` table in their SQLite DB.

The agent sends messages to other agents by running `spotless send` via the Bash tool. The `<spotless-orientation>` prompt explains this capability.

#### Receiving

On each human turn, the proxy checks the agent's `mailbox` table for undelivered messages (`delivered_at IS NULL`). If any exist, they're injected into the user message as tagged content:

```xml
<message from="maya" time="2026-03-12T14:30:00Z">
Auth migration is complete. The new token format is JWT with RS256.
Updated endpoints: /api/v2/auth/token, /api/v2/auth/refresh.
</message>
```

Multiple messages are injected in chronological order, newest-first priority, capped at 2K tokens. Messages exceeding the budget are deferred to the next turn. After injection, messages are marked `delivered_at = now`. The content is now part of the API request — it flows through archival into `raw_events` like any other user message content, and gets digested naturally. "Maya told me the auth migration is done" becomes a memory through the normal pipeline. No special handling needed.

#### Message Delivery Timing

Messages are **not pushed** — they're delivered on the next turn. In claw mode, this means:

- **Remote control command** — user sends something via phone, proxy picks up pending messages on that turn
- **Daemon restart** — resume prompt triggers a turn, proxy picks up pending messages
- **Agent working autonomously** — each tool loop turn is a proxy request, messages get picked up

There is no stdin injection or trigger mechanism. Claw agents are controlled via CC's remote control, not stdin. Messages accumulate in the mailbox and flow naturally into the next conversation turn.

If the agent isn't running, messages accumulate. On next startup, the first turn picks them up.

#### Schema

Each agent's SQLite database gets a `mailbox` table:

```sql
CREATE TABLE mailbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT NOT NULL,       -- sender name ("maya", "human", "ci")
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT                -- NULL until proxy injects it
);
```

Minimal. No `to_agent` (it's in the recipient's DB). No `acknowledged_at` (delivery = done). Messages are plain text rows that get injected once and then exist only as conversation history.

#### Broadcast

```
spotless send --all --from maya "deploying to staging, hold off on pushes"
```

Writes to every agent's mailbox. Triggers each running agent.

#### Why Not Shared Memory?

Agents have separate memory graphs by design. An agent's memories are experiential and first-person. Maya's memory: "I finished the auth migration." Kai's memory: "Maya told me the auth migration is done." These are different memories owned by different agents. Inter-agent communication is explicit messaging, not shared state.

## Persistence & Recovery

### What Survives a Restart

| State | Mechanism | Survives? |
|---|---|---|
| Memory graph | SQLite (Tier 2) | Yes |
| Identity | `identity_nodes` + facts | Yes |
| Task list | `~/.claude/tasks/spotless-<name>/` | Yes |
| Conversation history | SQLite (Tier 1) → history trace | Yes |
| In-flight tool execution | CC process state | No — but tasks track progress |
| Mailbox (undelivered) | SQLite | Yes |
| `/loop` schedules | CC session state | No — re-establish after restart |

### What the Agent Sees on Restart

1. `<spotless-orientation>` — knows it has persistent memory and messaging capability
2. `<your identity>` — knows who it is
3. `<relevant knowledge>` — memories relevant to recent work
4. History trace — recent conversation context
5. Resume prompt — explicit instruction to check tasks and continue
6. Task list — structured list of pending/in-progress work
7. Pending messages — any messages received while down, injected on first turn

## Implementation Plan

### Phase 1: `spotless claw` Command — DONE
- `cmdClaw()` is a self-contained function using tmux for process management
- Claude runs interactively inside a tmux session (`spotless-<agentName>`)
- Restart loop: detect exit via `isShellPrompt()` polling, wait 5s, relaunch
- Resume on restart: inject resume prompt into mailbox, trigger with "." via tmux
- Signal handling: SIGTERM/SIGINT → Ctrl-C to tmux, cleanup, exit (no restart)
- `--yolo` and `--daemon` on `spotless code` as composable primitives (uses inherited stdio, no tmux)
- tmux is a hard dependency for claw mode only
- Help text and docs updated

### Phase 2: Agent Registry — DONE
- `spotless describe --agent <name> "<description>"` CLI command
- Description stored at `~/.spotless/agents/<name>/description.txt`
- Proxy caches descriptions (60s TTL) — no per-request disk reads
- `<spotless-orientation>` includes dynamic peer directory
- `spotless agents` shows descriptions, DB sizes, running status, pending message counts

### Phase 3: Inter-Agent Mailbox — DONE
- `mailbox` table in `src/mailbox.ts` (ensured lazily, not in main schema)
- `spotless send` CLI command (write to recipient DB + tmux trigger)
- `spotless send --all` broadcast (excludes sender)
- Proxy: check mailbox on human turns, inject `<message>` tags, mark delivered
- Message budget: 2K tokens, newest-first priority, deferred if over budget
- `<spotless-orientation>` explains messaging syntax
- 422 tests passing

### Phase 4: Operational Polish — TODO
- Systemd/launchd service file generation: `spotless install --agent maya`
- Dashboard: claw status, restart history, message log, peer messages
- Health endpoint for external monitoring
- Graceful shutdown protocol (finish current turn, then exit)
- tmux pane log capture (`tmux pipe-pane` → log file)

## Mode 2: Messaging Gateway (Sprint 10)

Claw mode's tmux + remote control architecture (Mode 1) is stateful and fragile — auth expiry, CC bugs, and crashes kill the session. Mode 2 inverts the model: **stateless `claude -p` invocations triggered by messaging platforms, with Spotless providing all continuity.**

### Why This Works

Spotless already solves every problem that stateless invocations normally have:
- History trace provides recent conversation context
- Memory suffix provides accumulated knowledge
- Working self provides identity
- Peer directory provides agent awareness
- Mailbox provides inter-agent messages

A `claude -p` through Spotless is indistinguishable from a persistent session, from the agent's perspective. The session is an illusion Spotless creates.

### Architecture

```
Slack/WhatsApp → spotless gateway → claude -p → Spotless proxy → Anthropic
                                                    |
                                                    +→ history trace + memory + identity
```

`spotless gateway --agent maya --slack` runs a long-running process that:
1. Connects to Slack via Socket Mode (WebSocket, no public URL needed)
2. On each incoming message: spawns `claude -p "<message>"` through the Spotless proxy
3. Posts the response back to Slack
4. No session state, no tmux, no restart loop

### Auth Recovery

If `claude -p` fails with an auth error, the gateway:
1. Runs `claude auth login`, captures the auth URL
2. Posts it to the Slack channel: "I need to re-authenticate. Click this link: ..."
3. User clicks, approves in browser, next message works

The agent tells you when it needs help. No SSH required.

### Mode 1 vs Mode 2

| | Mode 1: Remote Control | Mode 2: Messaging |
|---|---|---|
| Session | Persistent (tmux) | Stateless (`claude -p`) |
| Interface | CC remote control | Slack, WhatsApp, etc. |
| Continuity | CC session state + Spotless | Spotless only |
| Resilience | Fragile (auth, crashes) | Resilient (nothing to crash) |
| Autonomy | Continuous tool loops | Per-message invocations |
| Best for | Hands-on work, debugging | Async tasks, always-available agents |

Both modes use the same agent, same memory, same identity. An agent can be accessed via both simultaneously.

See `_project/sprints/sprint-010-messaging-interfaces.md` for implementation plan.

## Open Questions

1. **Rate limiting messages**: No cap currently beyond the 2K token budget per turn. Two agents messaging each other in a tight loop could burn Max quota. Mitigated by the fact that messages are only delivered on turn boundaries, not pushed. Monitor in practice.

2. **Remote control + claw**: Does CC's remote control work with `--dangerously-skip-permissions`? Need to verify before shipping.

3. **Stateless tool use**: In Mode 2, `claude -p` can use tools (Bash, Read, etc.) within a single invocation, but can't do multi-turn autonomous work across invocations. Is this a limitation or a feature? The agent can do a lot in one `claude -p` call, and the human drives the next turn via Slack.

4. **Proactive messaging**: Mode 2 agents are reactive (respond to messages). For proactive behavior (agent initiates), need either Mode 1 or a scheduler that sends periodic trigger messages.
