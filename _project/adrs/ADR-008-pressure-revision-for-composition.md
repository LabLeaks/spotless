# ADR-008: Pressure System Revision for Fractal Composition

**Status:** Proposed
**Date:** 2026-03-19
**Related:** ADR-004 (history consolidation), ADR-006 (fractal context composition)

## Context

### The Current Pressure System

ADR-004 introduced consolidation pressure as a signal for when the digester is falling behind:

```
pressure = unconsolidated_tokens / PRESSURE_BUDGET_CAP
```

Where `PRESSURE_BUDGET_CAP = 144,000` tokens (fixed, independent of context window). This drives two behaviors:

1. **Escalation:** When `pressure >= 0.85 AND trimmedCount > 0`, the proxy fires `digestLoop.escalate(agentName)` for immediate digesting.

2. **Pressure signal:** When `pressure >= 0.60`, a `<memory-pressure level="moderate|high">` tag is injected into the user message. Social backpressure — the agent asks the human to slow down.

### How Fractal Composition Breaks This

ADR-006 replaces the `buildHistoryTrace()` → `trimTobudget()` pipeline with `composeContext()`. The composer curates the messages array by selecting exchanges at appropriate fidelity levels. It doesn't "trim" — it "composes."

**The escalation trigger breaks.** `trimmedCount > 0` was the signal that the history trace had to drop messages because it exceeded the budget. With composition, the budget is elastic (APERTURE_BASELINE to APERTURE_CEILING) and the composer picks what to include rather than trimming what doesn't fit. `trimmedCount` is always 0 or semantically meaningless.

**The pressure value is unchanged.** Pressure measures unconsolidated volume in the database, which is independent of how context is assembled. High pressure still means the digester is behind.

**The pressure signal becomes confusing.** The current message says "your history is being trimmed" and "unconsolidated experience is at risk." With composition, nothing is being trimmed. The agent sees curated context, not a truncated buffer. The message's premise is wrong.

### What Pressure Should Mean

Pressure measures a real thing: how much raw conversation exists that the digester hasn't processed. This matters because:

1. **Memory quality degrades.** Unconsolidated exchanges only have Level 1 summaries (heuristic). Levels 2-3 (LLM-quality summaries) require consolidation. High pressure means much of the agent's history is at heuristic-only fidelity.

2. **Memory graph gaps.** Unconsolidated exchanges don't produce Tier 2 memories. The selector can't recall knowledge from them. The agent's long-term memory has blind spots.

3. **Digester throughput limits.** Haiku's 200K context means each consolidation pass can only process ~50 groups. If pressure builds to 300K+ tokens of unconsolidated content, it takes multiple passes to catch up.

These concerns are real regardless of how context is assembled. Pressure should drive digesting, not be coupled to trimming.

## Decision

### 1. Decouple Escalation from Trimming

**Old trigger:** `pressure >= PRESSURE_HIGH && trimmedCount > 0`
**New trigger:** `pressure >= PRESSURE_HIGH`

The `trimmedCount` condition was a proxy for "we're losing context." With composition, we're always potentially under-serving context when pressure is high — exchanges without Level 2-3 summaries are rendered at Level 1 (heuristic), which may miss nuance. Pressure alone is the right signal.

```typescript
// proxy.ts — after composeContext() returns
if (pressure >= PRESSURE_HIGH && onHistoryTrimmedFn) {
  console.log(`[spotless] [${agentName}] High pressure ${(pressure * 100).toFixed(0)}%, escalating digest`);
  onHistoryTrimmedFn(agentName);
}
```

### 2. Revise Pressure Signal Framing

The pressure signal changes from "your history is being trimmed" to "your memory consolidation is falling behind":

**Moderate (60-84%):**
```xml
<memory-pressure level="moderate">
Your memory consolidation is falling behind — you have {N}k tokens of
unconsolidated experience. Recent interactions may not yet be encoded
into your long-term memory. Consider wrapping up the current thread
to let consolidation catch up.
</memory-pressure>
```

**High (85%+):**
```xml
<memory-pressure level="high">
Your memory consolidation is significantly behind — {N}k tokens of
unconsolidated experience. Your long-term memory has gaps in recent
work. Please pause for a few minutes to allow consolidation to process.
</memory-pressure>
```

The framing shifts from "you're losing context" (no longer true — nothing is lost, composition just renders at lower fidelity) to "your memory has gaps" (true — unconsolidated exchanges don't produce Tier 2 memories or Level 2-3 summaries).

### 3. Composition-Aware Pressure Context

Add a new signal available to the composer: **fidelity coverage.** After composition, the composer knows what percentage of included exchanges had Level 2-3 summaries available vs. falling back to Level 1.

```typescript
interface CompositionResult {
  messages: Message[];
  budgetUsed: number;
  exchangeCount: number;
  fidelityCoverage: {
    level0: number;  // count of exchanges at verbatim
    level1: number;  // count at heuristic condensed
    level2: number;  // count at LLM action summary
    level3: number;  // count at session summary
  };
}
```

Low fidelity coverage (many exchanges at Level 1, few at Level 2-3) indicates the digester hasn't caught up. This is a more precise signal than raw pressure, because it measures the actual impact on context quality rather than raw volume.

For now, this is diagnostic (logged, exposed in dashboard). In the future, it could feed into the pressure signal: "your context quality is degraded because consolidation is behind."

### 4. PRESSURE_BUDGET_CAP Unchanged

The pressure denominator (`PRESSURE_BUDGET_CAP = 144,000`) remains fixed and independent of context window. This was a deliberate design choice in ADR-004: pressure must trigger digesting at the same pace regardless of context budget, because Haiku's 200K context is the bottleneck.

With fractal composition, this is even more correct. The composer's elastic budget doesn't affect how fast the digester needs to run — that's determined by how fast conversations generate unconsolidated content vs. how fast Haiku can process it.

### 5. Adaptive Scheduling Unchanged

The digest loop's pressure-based scheduling (ADR-004) works as-is:

| Pressure | Interval |
|----------|----------|
| < 30% | 10 minutes |
| 30-60% | 3 minutes |
| 60-85% | 1 minute |
| > 85% | Immediate (escalation) |

Escalation now fires on pressure alone (without `trimmedCount`), which means it triggers slightly more often — any time pressure hits 85% on a human turn, not just when trimming occurs. This is desirable: the digester should run urgently when it's behind, regardless of how context is being assembled.

## Consequences

### Positive
- Escalation fires correctly with fractal composition (no false negatives from `trimmedCount = 0`)
- Pressure signal framing is accurate (memory gaps, not trimming)
- Fidelity coverage provides a new quality metric for the dashboard
- No changes needed to consolidation.ts pressure calculation or digest-loop.ts scheduling

### Negative
- Slightly more aggressive escalation (no trimmedCount gate). In practice, this is minimal — pressure >= 85% already implies heavy conversation load, and escalation is fire-and-forget (no-op if already digesting).
- Pressure signal text change requires testing to ensure the agent responds appropriately to the new framing.

### Migration
- Change escalation condition in proxy.ts (remove `trimmedCount > 0`)
- Update pressure signal text in memory-suffix.ts
- Add fidelity coverage tracking to the composition result
- Dashboard: add fidelity coverage display to Health tab
