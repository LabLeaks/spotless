# Spotless

Persistent memory for Claude Code.

## What it does

- **Remembers across sessions** — your agent knows what you discussed yesterday, last week, last month
- **Never hit context limits again** — raw history is stored in SQLite; only relevant context is loaded per turn
- **Zero config** — just a local proxy. No MCP servers, no plugins, no API keys. `spotless start` and go
- **Learns what matters** — background process consolidates raw conversation into a memory graph. Facts, corrections, identity — all tracked automatically

Spotless is a local reverse proxy that sits between Claude Code and Anthropic's API. It archives every conversation to per-agent SQLite, selects and injects relevant memories each turn, and consolidates raw data into a structured memory graph in the background. Claude doesn't know it's there — it just remembers.

## Quick start

**Prerequisites:** [Bun](https://bun.sh) >= 1.0, [Claude Code](https://docs.anthropic.com/en/docs/claude-code) with a Claude Max subscription.

```bash
git clone https://github.com/didgeoridoo/spotless.git
cd spotless
bun install
bun link
```

```bash
spotless start
spotless code --agent myagent
```

That's it. Your agent now has persistent memory.

## How it works

The proxy intercepts Claude Code's API calls. Every request and response is archived to a per-agent SQLite database. A background digest process consolidates raw conversation into a memory graph — extracting facts, building associations, and tracking identity. On each turn, a lightweight selector picks relevant memories and injects them into the conversation. The agent never sees a tool or prompt about memory — it's a transparent brain implant.

## CLI reference

| Command | Description |
|---------|-------------|
| `spotless start [--port 9000] [--no-digest]` | Start the proxy. Background digesting enabled by default. |
| `spotless stop` | Stop the running proxy. |
| `spotless status` | Check if the proxy is running. |
| `spotless code [--agent <name>] [--port 9000] [-- ...claude args]` | Launch Claude Code through the proxy. Auto-starts proxy if needed. |
| `spotless agents` | List all agents with DB sizes. |
| `spotless digest [--agent <name>] [--dry-run] [--model haiku\|sonnet]` | Run a digest pass (memory consolidation). |
| `spotless repair [--agent <name>] [--fix] [--purge-history]` | Diagnose and repair database issues. |

## Dashboard

While the proxy is running, open `http://localhost:9000/_dashboard/` to browse agent memories, identity, digest passes, selector runs, and raw history events.

## Agents

Memory is keyed by **agent name**, not project directory. The same agent remembers across all projects. Storage lives at `~/.spotless/agents/<name>/spotless.db`.

```bash
spotless code --agent wren          # use agent "wren" in any project
spotless code                       # pick or create an agent interactively
```

## Development

```bash
bun test              # run unit tests
bun run typecheck     # type-check
```

## License

[MIT](LICENSE)
