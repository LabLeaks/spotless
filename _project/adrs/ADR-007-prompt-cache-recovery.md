# ADR-007: Prompt Cache Recovery

**Status:** Proposed
**Date:** 2026-03-19
**Related:** ADR-006 (fractal context composition), Sprint 11 (Aperture)

## Context

### The Problem

Spotless strips ALL `cache_control` markers from forwarded requests (`stripCacheControl()` in proxy.ts). This was a necessary fix — Claude Code places up to 4 `cache_control: {type: "ephemeral"}` breakpoints on its original messages, but Spotless replaces those messages with a history trace. CC's breakpoints no longer align with the rewritten content, and extra breakpoints push over the API's 4-block limit → 400 error.

The cost: **~45K tokens (system + tools) are sent as full input every turn** instead of being cached. Over a 20-turn session, this wastes ~45K × 19 × 0.9 = **~770K tokens** that would otherwise be cache reads at 10% cost.

With fractal context composition (ADR-006), the typical request drops from ~500K to ~60-100K tokens. System + tools (~45K) become a much larger fraction of each request. Recovering prompt caching has proportionally higher impact.

### API Research

Anthropic's prompt caching has specific mechanics verified from documentation:

1. **Breakpoint placement:** `cache_control: {type: "ephemeral"}` can be placed on system text blocks, tool definitions, and message content blocks.

2. **Limit:** Maximum 4 explicit `cache_control` breakpoints per request. Exceeding → 400 error.

3. **Prefix ordering:** The cache key is a cumulative hash built in order: `tools → system → messages`. A breakpoint on the last tool caches all tools. A breakpoint on the last system block caches tools + system together.

4. **Minimum tokens:** 4,096 tokens per breakpoint for Opus 4.6. Below this, `cache_control` is silently ignored (no error, no caching).

5. **Response fields:** `usage.cache_creation_input_tokens` and `usage.cache_read_input_tokens` in the response (and `message_start` SSE event) report cache behavior.

6. **Cost:** Cache write = 1.25x base input. Cache read = 0.1x base input. Break-even after 1 read.

7. **TTL:** 5 minutes default, refreshed on each hit. 1-hour option available at 2x write cost.

8. **Stability requirement:** Changing tool definitions, system prompt, or thinking parameters invalidates the cache. Tools and system prompt are stable across turns in a Spotless session.

## Decision

### Replace Blanket Stripping with Strategic Breakpoint Placement

Instead of stripping all `cache_control` markers, Spotless:

1. **Strips CC's original markers** (they reference CC's message positions, which no longer exist after rewriting)
2. **Places its own breakpoints** at positions that make sense for the rewritten request

### Breakpoint Strategy: 2 Breakpoints

**Breakpoint 1: Last tool definition.**
- Caches the entire tools array (~30K tokens)
- Tools are unchanged across turns (Spotless never modifies them)
- Consistent cache hits on every turn after the first

**Breakpoint 2: Last system text block.**
- Caches tools + system together (~45K tokens combined)
- System prompt is stable across turns (CC's prompt + `<spotless-orientation>`)
- The `<spotless-orientation>` block is prepended once per session and doesn't change

**Breakpoints NOT placed:**
- On messages: The composed history changes every turn. No stable prefix to cache within messages.
- On preamble messages: The history preamble (first 2 messages) is stable, but at ~300 tokens it's below the 4,096 minimum for Opus 4.6. Silently ignored.

**Spare breakpoints:** 2 of 4 slots are unused. Reserved for future optimizations (e.g., if a stable history prefix emerges from fractal composition where older sessions at Level 3 are identical across turns).

### Implementation

```typescript
function placeCacheBreakpoints(body: RequestBody): void {
  // 1. Strip all existing cache_control markers
  stripCacheControl(body);

  // 2. Place breakpoint on last tool definition
  if (body.tools && body.tools.length > 0) {
    const lastTool = body.tools[body.tools.length - 1];
    lastTool.cache_control = { type: "ephemeral" };
  }

  // 3. Place breakpoint on last system block
  if (Array.isArray(body.system) && body.system.length > 0) {
    const lastBlock = body.system[body.system.length - 1];
    lastBlock.cache_control = { type: "ephemeral" };
  } else if (typeof body.system === "string") {
    // Convert to array form to add cache_control
    body.system = [{
      type: "text",
      text: body.system,
      cache_control: { type: "ephemeral" }
    }];
  }
}
```

### Expected Impact

| Metric | Before | After |
|--------|--------|-------|
| Cached tokens/turn | 0 | ~45K (system + tools) |
| Cache cost (first turn) | N/A | 45K × 1.25x = 56K token-equivalents |
| Cache cost (subsequent) | 45K × 1.0x = 45K/turn | 45K × 0.1x = 4.5K/turn |
| Savings over 20 turns | 0 | ~45K × 0.9 × 19 = ~770K token-equivalents |

With fractal composition reducing typical requests to ~100K, the cached 45K represents nearly half the request on most turns. The effective cost per turn drops from ~100K to ~59.5K (45K cached at 0.1x + 55K uncached).

### Subagent Exclusion

Subagent requests pass through unchanged (no rewriting). CC's original `cache_control` markers are preserved for subagents — they're valid for CC's own message structure. Only non-subagent requests get breakpoint relocation.

### Diagnostics

Parse cache metrics from the `message_start` SSE event's `usage` object:

```typescript
// In StreamTap, extract from message_start event:
{
  cache_creation_input_tokens: number,  // tokens written to cache (1.25x cost)
  cache_read_input_tokens: number,      // tokens read from cache (0.1x cost)
  input_tokens: number                  // uncached tail tokens (1.0x cost)
}
```

Log these to the existing `ProxyStats` and expose in the dashboard Health tab. This provides visibility into whether caching is working and how much it's saving.

## Rejected Alternatives

### Top-level `cache_control` (automatic caching)
The API supports `cache_control: {type: "ephemeral"}` at the top level of the request body, which automatically applies a breakpoint to the last cacheable block. Rejected: this uses one of the 4 slots and applies to the wrong location (the last message, which changes every turn). Explicit placement gives more control.

### 3 breakpoints (tools + system + preamble)
Place a third breakpoint after the history preamble messages. Rejected: the preamble is ~300 tokens, below the 4,096 minimum for Opus 4.6. Would be silently ignored — wasted slot.

### 1-hour TTL
Use `{type: "ephemeral", ttl: "1h"}` for system+tools since they're stable for the entire session. The 1-hour TTL costs 2x for cache writes vs 1.25x for 5-minute. Rejected for now: 5-minute TTL refreshes on every hit, and Spotless requests come more frequently than every 5 minutes during active use. 1-hour TTL is only valuable if there are gaps > 5 minutes between requests, which is uncommon during a coding session. Can revisit for claw mode (persistent agents with longer idle periods).

### Cache history prefix
Place a breakpoint partway through the history messages to cache the stable prefix. Rejected for now: with fractal composition, the history changes every turn (different fidelity levels, different exchanges included). There's no guaranteed stable prefix. Future optimization: if Level 3 session summaries are always included in the same order, they form a stable prefix worth caching.
