# Spotless Dashboard: Agent Visibility & Diagnostics

## Problem

Spotless is invisible by design — Claude never knows it exists. But the *operator* also has no visibility into what's happening. There's no way to:
- See if the proxy is running and healthy
- Inspect an agent's memories, identity, and personality
- Monitor selector/digesting performance
- Understand why the agent behaved a certain way
- Browse the memory graph and associations

Currently: run SQL queries against `~/.spotless/agents/<name>/spotless.db` or read test output logs. This is fine for development but unusable for daily operation.

## Solution

A lightweight local dashboard — either a macOS menu bar app or a local web UI (e.g., `localhost:9001`) — that provides real-time visibility into the Spotless system.

## Requirements

### Proxy Status
- Running/stopped indicator
- Port, uptime, active connections
- Request throughput (req/min)
- Error rate

### Agent Overview
- List of all agents with:
  - Memory count (Tier 1 events, Tier 2 memories)
  - Identity summary (self-model, relationship model in full)
  - Last digest pass: when, duration, what changed
  - Last selector run: latency, memories selected
  - DB size on disk

### Agent Detail: Memory Browser
- Search memories (FTS5)
- View memory graph: nodes (memories) + edges (associations) with strength
- Filter by salience, recency, access count
- View identity nodes with role labels
- View supersession chains (correction history)

### Agent Detail: Identity & Personality
- Current self-model (full text)
- Current relationship model (full text)
- Self-concept facts (composable facts connected to identity anchors)
- Significance-marked memories
- Identity evolution timeline (how self-concept changed over time)

### Agent Detail: Diagnostics
- Recent selector runs: what was retrieved, how long, FTS5 hits vs spreading activation
- Recent digest passes: operations performed, errors, duration
- Retrieval log: what's queued for next digest pass
- Raw event timeline: conversation flow with group boundaries

### Digest Cycle Monitor
- Per-agent digest schedule
- Last N digest pass results
- Memory creation/merge/supersede counts over time
- Reflection ops over time

## Design Constraints

- **Local only** — no network exposure, no auth needed
- **Read-only** — dashboard observes, never modifies agent state
- **Low overhead** — shouldn't impact proxy performance
- **Simple tech** — static HTML + JS served by the same Bun process, or a separate lightweight process. No React, no build step
- **SQLite-friendly** — all queries are just `SELECT` against existing tables

## Open Questions

1. **Menu bar vs web UI?** Menu bar (Tray) is more native macOS but harder to build rich views. Web UI at localhost is simpler to implement, richer interface, works cross-platform. Could do both: tray icon with status + "Open Dashboard" link to web UI.

2. **Same process or separate?** Running inside the proxy process shares the DB connections but adds surface area. Separate process is cleaner isolation but needs its own DB access.

3. **Graph visualization?** The memory graph is a graph. Force-directed layout (d3-force, sigma.js) would make associations visible. Worth the complexity?

4. **Real-time updates?** SSE from the proxy to push live updates (new memories, selector results) vs polling. SSE is more elegant but adds complexity to the proxy.

## Non-Goals

- Remote access / multi-user
- Editing memories from the dashboard (write operations)
- Replacing CLI commands (dashboard is supplementary)
- Production monitoring / alerting

## Sprint Estimate

Likely 2 sprints:
1. API endpoints + basic web UI (proxy status, agent list, memory browser)
2. Identity view, diagnostics, graph visualization, digest cycle monitor
