# ADR-001: Neuromorphic Memory Behaviors

**Status:** Accepted
**Date:** 2026-02-25

## Context

After completing Sprint 4 (dreaming), research into biological memory systems and survey of AI memory implementations revealed behavioral gaps in Spotless. The research covered:

- **ABC theory (amygdala-hippocampus circuit):** Emotional salience modulates memory consolidation strength. High-arousal events (errors, breakthroughs, explicit decisions) are consolidated preferentially over routine activity.
- **Complementary Learning Systems (CLS) theory:** Fast learning in hippocampus (raw events), slow consolidation in neocortex (engram network). Pattern separation in the dentate gyrus prevents similar memories from interfering — near-duplicates are actively differentiated or merged rather than accumulated.
- **Generative Agents (Park et al.):** Retrieval scoring combines recency + importance + relevance with tunable weights. Core character summary maintained as a living document. Reflection generates higher-order insights.
- **A-MEM:** Agentic memory with self-organizing retrieval and consolidation.
- **Mem0:** Production memory layer with scoring and deduplication.

Current Spotless (through Sprint 4) lacks: substance filtering, salience burst detection for high-stakes events, pattern separation (deduplication), core summary, and retrieval scoring.

### Rejected behaviors

Three behaviors from the research were considered and rejected:

- **Temporal decay** — active salience reduction on unused memories. Rejected: ordinal displacement already handles this. Active memories get reinforced (higher salience, more access, stronger associations), inactive ones stay flat and naturally fall below pruning thresholds. Adding an explicit decay rate introduces a tuning knob that's hard to calibrate — with 5-minute dreaming passes, even gentle decay (0.05/pass) would zero out a 0.5-salience memory in under an hour. The original "no explicit decay" position is correct.
- **Competitive salience** — high-salience events suppress adjacent low-salience neighbors. Rejected: "adjacent" is undefined in a useful way. The dreaming agent sees memories holistically, not sequentially. Substance filtering already prevents noise from becoming memories in the first place, and ordinal displacement handles the rest.
- **Stakes weighting** — hippocampus prompt instruction to favor decisions over incidental facts. Rejected: redundant with the retrieval scoring formula. Salience burst detection gives high-stakes events high salience at creation time. The retrieval scorer already ranks them higher. A separate prompt instruction telling the hippocampus to do what the numbers already do adds complexity without value.

## Decision

Fold 5 behaviors into existing Spotless surfaces — the dreaming prompt and hippocampus pre-computation. No new modules, no new tables, no new infrastructure.

The directive: **capture the outcome, not the architecture.** Each behavior is a prompt instruction or a lightweight computation, not a separate system.

| # | Behavior | Primary Surface |
|---|----------|----------------|
| 1 | Substance filter | Dreaming prompt |
| 2 | Pattern separation | Dreaming prompt + merge_memories tool |
| 3 | Salience burst detection | Dreaming prompt |
| 4 | Core summary | Dreaming prompt + hippocampus prompt |
| 5 | Retrieval scorer | Hippocampus pre-computation (proxy-side) |

Behaviors 1-4 are dreaming-side: they modify how the dreaming agent creates, scores, and merges memories. The dreaming prompt is the primary tuning surface — these behaviors become consolidation goals that guide the agent's judgment.

Behavior 5 is hippocampus-side: a formula the proxy computes before invoking the hippocampus, so it starts with better-ranked candidates.

## Alternatives Considered

### Separate amygdala module
A dedicated process that scores emotional/salience weight independently of dreaming. Rejected: adds a third subprocess, increases latency, and the dreaming agent already has full context to make salience judgments. Salience scoring is a prompt concern, not an architectural one.

### Vector embeddings for pattern separation
Use embedding similarity to detect near-duplicate memories. Rejected: requires an embedding model (external dependency), adds latency, and Spotless's design principle is "fire together, wire together" — association strength via co-activation, not vector similarity. FTS5 keyword matching plus the dreaming agent's judgment handles deduplication without embeddings.

### External scoring service
A separate service that computes retrieval scores using a learned model. Rejected: over-engineering for the current stage. A weighted formula (recency + salience + relevance) with inputs normalized to 0-1 is sufficient and tunable. Can always be replaced later if needed.

## Consequences

### Positive

- **No new infrastructure.** All behaviors fold into existing dreaming prompt and hippocampus pre-computation. No new tables, no new processes, no new dependencies.
- **Intelligence stays in prompts.** The dreaming prompt and hippocampus prompt remain the primary tuning surfaces. Behaviors can be adjusted, rebalanced, or removed by editing prompts — no code changes required for behavioral tuning.
- **Grounded in neuroscience.** Pattern separation, salience burst detection, and CLS-style consolidation all have biological analogues. The system behaves in ways that are intuitive to reason about.
- **Retrieval scoring formula is simple and tunable.** Two weights (alpha, beta) starting at 1.0 each, both inputs normalized to 0-1. Topical relevance excluded from the formula — FTS5 is just the trigger into the association graph, the hippocampus judges relevance directly.

### Negative

- **Dreaming prompt complexity increases.** The prompt now carries consolidation goals (substance filter, pattern separation, salience burst detection, core summary maintenance). Risk of prompt overload causing the dreaming agent to miss instructions. Mitigation: structured prompt with clear priorities.
- **Core summary is a convention-based memory type.** One memory is special — the dreaming agent creates and maintains it, the hippocampus always includes it. This breaks the "a memory is a memory" principle slightly. Mitigation: it's stored in the same `memories` table. The convention is enforced by prompts, not by code. It can be removed by editing the prompts.
- **Retrieval scoring weights need empirical tuning.** Starting weights of 1.0 each are arbitrary. Real usage data needed to find the right balance. No automated tuning mechanism — manual observation and adjustment for now.

## References

- PRD: `_project/prds/spotless-prd.md` — Dreaming process, Hippocampus Retrieval Scoring, Resolved Decisions
- Park, J.S. et al. (2023). "Generative Agents: Interactive Simulacra of Human Behavior" — retrieval scoring trinity (recency + importance + relevance), core character summary
- CLS theory (McClelland et al., 1995) — complementary learning systems, fast hippocampal + slow neocortical consolidation
- Pattern separation in dentate gyrus — similar inputs mapped to distinct representations to prevent interference
