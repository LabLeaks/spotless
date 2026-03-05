# Spotless

Persistent memory for Claude Code.

> **v0.1.0 — Early release.** The core works but expect breaking changes. Back up `~/.spotless/` if you have data you care about.

## The problem

Claude Code forgets everything between sessions. Close the terminal, come back, and it has no idea what you were working on. Your architectural decisions, debugging breakthroughs, personal preferences — gone.

Within a session, things aren't much better. Long conversations hit "Compacting Conversation," which lossy-summarizes your context and often undoes hours of careful work. Post-compaction, Claude re-reads the same files, forgets recent corrections, and regresses on code it just fixed. And because memory is per-project-directory, switching between related repos means starting from scratch each time.

## What Spotless fixes

1. **No more amnesia between sessions.** Every conversation is archived to SQLite. When you start a new session, your agent picks up where you left off — across days, weeks, months. "We discussed this yesterday" actually works.

2. **Compaction stops destroying your work.** Spotless maintains its own history trace from the archive, independent of Claude Code's context management. When CC compacts, Spotless replaces the lossy summary with real conversation history, budget-trimmed from the oldest messages rather than arbitrarily summarized.

3. **Memory follows the agent, not the folder.** A named agent remembers across all projects. `spotless code --agent wren` gives you the same persistent memory whether you're in your frontend repo, backend repo, or infrastructure directory.

4. **Knowledge compounds over time.** A background digest process consolidates raw conversation into a memory graph — extracting facts, building associations, tracking corrections. When you told your agent three weeks ago that you prefer PostgreSQL over MongoDB, that surfaces automatically when databases come up again.

5. **Your agent develops a self-concept.** Over time, the digest process builds an identity for your agent — values, working style, relationship dynamics — from the pattern of your interactions. This isn't a static persona file; it evolves as the agent accumulates experience.

## How it works

Spotless is a local reverse proxy. It sits between Claude Code and the Anthropic API, transparently rewriting requests to inject persistent context. Claude doesn't know it's there.

Here's what happens on every turn:

```
Claude Code sends request
        │
        ▼
   ┌─────────┐
   │ Spotless │──→ Build history trace from DB (replaces CC's messages)
   │  Proxy   │──→ Select relevant memories from graph (injected into user message)
   │         │──→ Inject agent identity + orientation
   │         │──→ Archive request + response to SQLite
   └─────────┘
        │
        ▼
  Anthropic API
```

### Before and after

**Without Spotless** — Claude Code sends only the current session's messages:

```
system:  [Claude Code's system prompt]
messages:
  user:      "What's the database schema?"
  assistant: "Let me look at the codebase..."
  user:      "Now add a migration for the new column"
```

**With Spotless** — the request is rewritten with full cross-session history and memories:

```
system:
  <spotless-orientation>                          ← tells the agent about its memory
    You have a persistent memory system...
  </spotless-orientation>
  [Claude Code's system prompt]                   ← preserved unchanged

messages:
  user:      "[Spotless Memory System] Your name   ← memory preamble
               is "wren"..."
  assistant: "Understood. I'm wren..."

  user:      "Tell me about the database"         ← from 3 days ago
  assistant: "The schema uses PostgreSQL with..."
  user:      "--- new session ---                 ← session boundary (prepended)
              Let's add that caching layer"       ← from yesterday
  assistant: "I'll use Redis for the hot path..."

  user:      <your identity>                      ← agent's self-concept
               I tend to be thorough. I've learned
               to ask before over-engineering.
             </your identity>
             <relevant knowledge>                 ← contextually selected memories
               Project uses PostgreSQL 15.
               I learned to use migrations, not raw DDL.
               Redis caching added yesterday.
             </relevant knowledge>
             "Now add a migration for the         ← actual current message
              new column"
```

The history trace is budget-trimmed to fit alongside Claude Code's system prompt and tools (~62K tokens for history in a typical session). Oldest messages are dropped first. Memories are selected by a lightweight Haiku-based selector that runs asynchronously on each human turn — zero added latency (results apply on the next turn).

### Three-tier architecture

```
Tier 1: History Archive     Raw conversation stored as content blocks in SQLite.
                            Source of truth. Append-only.

Tier 2: Memory Graph        Facts, episodes, associations, identity — extracted
                            by background digesting. Searchable via FTS5.

Tier 3: Active Context      Assembled per-request from Tier 1 (history prefix)
                            and Tier 2 (memory suffix). What the agent sees.
```

## Requirements

- [Bun](https://bun.sh) >= 1.0
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) with a Claude Max subscription
- macOS or Linux

## Quick start

### Install from npm

```bash
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
| **What's stored** | Markdown notes (human or Claude-written) | Extracted facts or embeddings | Full raw conversation + synthesized memory graph |
| **Retrieval** | Entire file, or nothing | Vector similarity or manual navigation | FTS5 + graph traversal, scored by recency and salience |
| **Cross-session** | Yes | Yes | Yes |
| **Cross-project** | Per-repo (auto memory) or global (CLAUDE.md) | Varies | Per-agent — same agent remembers across all directories |
| **Consolidation** | None — you maintain it | None, or manual | Automatic background digesting when pressure builds |
| **Identity** | Static persona in a file | Not supported | Evolving self-concept built from accumulated experience |
| **Failure mode** | Missing context | Tool call errors surface to user | Falls back to vanilla Claude Code |

The built-in mechanisms are complementary — CLAUDE.md files pass through Spotless unchanged. Spotless adds the layers that don't exist yet: selective retrieval, associative memory, background synthesis, and a continuous identity that persists across sessions and projects.

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
