# Spotless

Persistent memory for Claude Code.

```bash
npm install -g @lableaks/spotless    # requires Bun runtime
spotless code --agent myagent
```

> **v0.1.0 — Early release.** The core works but expect breaking changes. Back up `~/.spotless/` if you have data you care about.

**Contents:** [The problem](#the-problem) | [What Spotless fixes](#what-spotless-fixes) | [How it works](#how-it-works) | [Quick start](#quick-start) | [CLI reference](#cli-reference) | [How it compares](#how-it-compares) | [What it doesn't do](#what-it-doesnt-do) | [Background](#background)

## The problem

Claude Code forgets everything between sessions. Close the terminal, come back, and it has no idea what you were working on — or who you are. Your decisions, breakthroughs, preferences, the way you like to work — gone.

Within a session, things aren't much better. Long conversations hit "Compacting Conversation," which lossy-summarizes your context and often undoes hours of careful work. Post-compaction, Claude forgets recent corrections and regresses on things it just got right. Every session, you start from scratch with a stranger.

## What Spotless fixes

1. **No more amnesia between sessions.** Every conversation is archived to SQLite. When you start a new session, your agent picks up where you left off — across days, weeks, months. "We discussed this yesterday" actually works.

2. **Compaction stops destroying your work.** When Claude Code compacts, it replaces your conversation with a lossy summary — and your agent loses corrections, decisions, and context it just had. Spotless replaces that summary with actual conversation history from its archive. Your agent remembers what was really said, not a garbled approximation.

3. **Your agent knows you, not just the project.** Memory is keyed to a named agent, not a directory. Your agent learns your preferences, communication style, and decision-making patterns across every project you work on together. This is a different bet than project-scoped memory — a project-specific system will know the codebase better, but your agent won't know *you*.

4. **Knowledge compounds over time.** A background digest process consolidates raw conversation into a memory graph — extracting facts, building associations, tracking corrections. When you told your agent three weeks ago that you prefer PostgreSQL over MongoDB, that surfaces automatically when databases come up again.

5. **Your agent develops a self-concept.** Over time, the digest process builds an identity for your agent — values, working style, relationship dynamics — from the pattern of your interactions. This isn't a static persona file; it evolves as the agent accumulates experience.

### Design philosophy: treat it like a coworker

Spotless is designed so that your agent's memory works like a human colleague's would. It remembers what you've discussed, learns from corrections, builds on past context, and occasionally forgets old details that haven't come up in a while — all without you managing a knowledge base or writing to special files. The best mental model is a coworker who was there yesterday and last week: you don't re-explain your preferences, you don't re-introduce the project, you just pick up where you left off. Feedback sticks — if you tell it something was wrong, that correction is encoded and surfaces when relevant, not just during the current session. This also means careless criticism sticks. Your agent's memory is designed to behave predictably by human standards, so treat it accordingly.

## How it works

Spotless is a local reverse proxy. It sits between Claude Code and the Anthropic API, transparently rewriting every request before it goes out. Claude doesn't know it's there.

### Two data sources, one request

Spotless maintains two independent stores that feed into every API request:

**Tier 1 — History Archive.** Every conversation turn is recorded verbatim to SQLite — append-only, never summarized, never modified. When assembling a request, Spotless replaces Claude Code's messages with a **history trace** reconstructed from this archive: real user/assistant exchanges from past sessions, in chronological order. Oldest turns drop off the back when the budget fills up (~62K tokens in a typical session), the way a coworker naturally loses detail about what happened months ago.

**Tier 2 — Memory Graph.** A background digest process reads the raw archive and extracts structured knowledge: facts ("project uses PostgreSQL 15"), experiences ("we spent two hours debugging the race condition"), corrections (superseding outdated facts), and self-concept observations. These are stored as nodes in a graph, connected by what was discussed together — the way you'd associate "that database migration" with "the day everything broke." When a new turn arrives, a lightweight selector picks which memories are relevant to the current conversation. This runs asynchronously — zero added latency.

These two sources are assembled into different parts of the API request:

```
system prompt:
  ┌─────────────────────────────────────────┐
  │ <spotless-orientation>                  │ ← tells the agent about its memory
  │ [Claude Code's system prompt, unchanged]│
  └─────────────────────────────────────────┘

messages array:
  ┌─────────────────────────────────────────┐
  │ HISTORY TRACE (from Tier 1)             │ ← replaces CC's messages
  │                                         │
  │ Preamble: "[Spotless Memory System]     │
  │   Your name is wren..."                 │
  │                                         │
  │ Real past conversation pairs:           │
  │   user: "Tell me about the database"    │
  │   assistant: "The schema uses..."       │
  │   user: "--- new session ---            │
  │     Let's add that caching layer"       │
  │   assistant: "I'll use Redis for..."    │
  ├─────────────────────────────────────────┤
  │ CURRENT USER MESSAGE                    │ ← the actual new message
  │                                         │
  │ Prepended with Tier 2 content:          │
  │   <your identity>                       │ ← from memory graph
  │     I am wren.                          │
  │     - I tend to be thorough.            │
  │   </your identity>                      │
  │   <relevant knowledge>                  │ ← from memory graph
  │     Project uses PostgreSQL 15.         │
  │     I learned to use migrations.        │
  │   </relevant knowledge>                 │
  │                                         │
  │ "Now add a migration for the new column"│ ← what the user typed
  └─────────────────────────────────────────┘
```

The history trace is real conversation — actual message pairs, not summaries. The memory tags are synthesized knowledge, injected as text that looks like it was always part of the user's message. The model reads both as natural context; it never sees database IDs, scores, or retrieval metadata.

After building the request, Spotless archives the current turn to Tier 1 (for future history traces) and forwards everything to the Anthropic API. Responses are streamed back and archived too.

### How memories get created

Raw conversation piles up in Tier 1. When enough unconsolidated history accumulates (tracked by consolidation pressure), a two-phase digest runs:

1. **Consolidation** — a small model reads recent conversation and catalogs what happened: new facts, merged duplicates, corrections that supersede outdated knowledge. Memories are linked to related memories, so recalling one can bring back others from the same context.

2. **Reflection** — the same model reviews what was just consolidated and updates the agent's self-concept: how it works, what it values, how the relationship with you is going. These observations live in the same graph as project facts — the agent's sense of self is built from the same material as its knowledge.

Digesting is triggered automatically when pressure is high and the history trace has to drop old messages. You can also trigger it manually with `spotless digest`.

## Requirements

- [Bun](https://bun.sh) >= 1.0 (runtime — Spotless uses Bun's built-in SQLite and HTTP server)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) with a Claude Max subscription
- macOS or Linux

## Quick start

### Install

```bash
npm install -g @lableaks/spotless
# or
bun add -g @lableaks/spotless
```

### Or build from source

```bash
git clone https://github.com/lableaks/spotless.git
cd spotless
bun install
bun link
```

### Run

```bash
spotless start
spotless code --agent myagent
```

That's it. Your agent now has persistent memory.

## CLI reference

| Command | Description |
|---------|-------------|
| `spotless start [--port 9000] [--no-digest]` | Start the proxy. |
| `spotless stop` | Stop the running proxy. |
| `spotless status` | Check if the proxy is running. |
| `spotless code [--agent <name>] [--port 9000] [-- ...claude args]` | Launch Claude Code through the proxy. Auto-starts proxy if needed. |
| `spotless agents` | List all agents with DB sizes. |
| `spotless digest [--agent <name>] [--dry-run] [--model haiku\|sonnet]` | Manually trigger a digest pass (memory consolidation). |
| `spotless repair [--agent <name>] [--fix] [--purge-history]` | Diagnose and repair database issues. |

## Dashboard

While the proxy is running, open `http://localhost:9000/_dashboard/` to browse agent memories, identity, digest history, and raw conversation events.

## Agents

Memory is keyed by **agent name**, not project directory. The same agent remembers across all projects. Data is stored at `~/.spotless/agents/<name>/spotless.db`.

```bash
spotless code --agent wren          # use agent "wren" in any project
spotless code                       # pick or create an agent interactively
```

## How it compares

Claude Code (as of early 2026) has three built-in memory mechanisms: **CLAUDE.md** files you write by hand, **Auto Memory** where Claude writes its own notes to `MEMORY.md`, and **Session Memory** which saves session summaries. All three work the same way — flat Markdown files loaded wholesale into the context window. There's no retrieval, no search, no consolidation. If the file fits, it's injected; if it doesn't, it's truncated at 200 lines.

**MCP memory servers** like [Mem0](https://github.com/coleam00/mcp-mem0) and [basic-memory](https://github.com/basicmachines-co/basic-memory) add semantic search or knowledge graphs, but they require the model to explicitly call tools to save and retrieve memories. The model knows it has a memory system and must choose to use it.

Spotless is architecturally different in several ways:

| | CLAUDE.md / Auto Memory | MCP Memory Servers | Spotless |
|---|---|---|---|
| **Mechanism** | Flat files loaded into context | Model calls tools explicitly | Transparent proxy rewrites API requests |
| **Model awareness** | Model knows about the files | Model knows about the tools | Model doesn't know it's there |
| **What's stored** | Markdown notes (human or Claude-written) | Extracted facts or embeddings | Full conversation history + synthesized memory graph |
| **Retrieval** | Entire file, or nothing | Vector similarity or manual navigation | Relevant memories surface based on current conversation |
| **Cross-session** | Yes | Yes | Yes |
| **Scoping** | Per-repo (auto memory) or global (CLAUDE.md) | Varies | Per-agent — knows *you* across projects, not the project itself |
| **Consolidation** | None — you maintain it | None, or manual | Automatic background digesting when pressure builds |
| **Identity** | Static persona in a file | Not supported | Evolving self-concept built from accumulated experience |
| **Failure mode** | Missing context | Tool call errors surface to user | Falls back to vanilla Claude Code |

The built-in mechanisms are complementary — CLAUDE.md files pass through Spotless unchanged. Spotless adds the layer that doesn't exist yet: a continuous, evolving memory that works the way you'd expect a colleague's to.

## What it doesn't do

- **No API keys required.** Spotless forwards Claude Code's auth headers unchanged. It never touches your credentials.
- **No model changes.** Your chosen model (Opus, Sonnet, etc.) passes through untouched.
- **No tool modifications.** Claude Code's tools work exactly as before.
- **No cloud dependency.** Everything runs locally. Your data stays in `~/.spotless/`.
- **No degradation on failure.** If anything goes wrong, Spotless falls back to vanilla pass-through. You get normal Claude Code, not a broken session.

## Background

Spotless started as a practical fix for compaction amnesia, but it's also a philosophical experiment. What happens when an AI agent has continuous, persistent memory — not just a scratchpad, but an evolving identity built from accumulated experience? The companion essay on the [Lab Leaks Substack](https://lableaks.substack.com) explores what it might mean for AI agents to develop accountable selves.

## Development

```bash
bun test              # 384 unit tests
bun run typecheck     # type-check
```

For architecture details, see [`_project/adrs/`](_project/adrs/) and the [PRD](_project/prds/spotless-prd.md).

## License

[MIT](LICENSE)
