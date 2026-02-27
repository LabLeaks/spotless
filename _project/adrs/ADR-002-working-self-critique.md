# ADR-002: Working Self — Critique & Revision

**Status**: Accepted (architecture revision implemented)
**Date**: 2026-02-26
**Context**: First implementation of agent identity (identity_nodes + 4 dream tools + hippocampus seeding). Live-tested with Haiku dreaming. This document catalogs issues found and proposes revisions.

---

## Live Test Results

Seeded an agent with 18 raw events simulating a multi-turn interaction including user correction ("don't over-engineer"), trust building, and autonomous delegation. Ran two dream passes.

**What the dreamer did:**
- Created 6 well-formed factual memories (preferences, bugs, patterns)
- Used `evolve_relationship` once — correctly identified the trust dynamic
- Created zero associations between any memories
- Never called `reflect_on_self`, `evolve_identity`, or `mark_significance`
- FTS5 query error: "no such column: engineer" (sanitization bug)
- 1 parse failure (Haiku output prose instead of JSON)

**What this tells us:**
The dreamer treats identity tools as optional addenda to its main consolidation job. It will use them only when the signal is so strong it can't miss it (the relationship shift was obvious). Self-reflection and significance marking require a cognitive mode the dreamer isn't in — it's a librarian cataloging facts, not a person reflecting on experience.

---

## CRITICAL: The Homunculus Problem

### Diagnosis

The current architecture has a Cartesian theater at its center: a Haiku homunculus sitting in the dreaming loop, deciding whether to introspect. Identity formation is downstream of LLM judgment about when identity is relevant. This is exactly backwards — the working self should be a *structural feature* of the memory system, not an optional behavior of one of its operators.

Conway's insight: the working self constrains retrieval *automatically*, as a resting state. It's not something you decide to activate. Our architecture should mirror this.

### The Problem Concretely

1. Haiku reads third-person transcripts ("USER said X, ASSISTANT said Y") and is asked to develop first-person self-knowledge. Who is "I"? The dreaming agent isn't the agent that had the conversation. It's reading someone else's diary and being asked to introspect.

2. With 16 tools + goals + rules in the prompt (~7.6k chars system prompt), identity tools are buried. Haiku has to remember they exist AND decide this is the right moment AND formulate good content. Three independent failure points, all discretionary.

3. Even if Haiku calls the tools, there's no quality control. `reflectOnSelf("I am a good assistant")` and `reflectOnSelf("I tend to over-engineer under ambiguity — learning to ask first")` both succeed equally. The architecture can't distinguish vacuous self-talk from genuine insight.

### Proposed Fix: Mechanistic Identity Pass

Split identity maintenance out of the general dreaming loop. Make it a **separate pipeline stage** that runs deterministically after the consolidation pass, not inside it.

**Architecture:**

```
Dream pass (existing):
  1. Consolidation loop (Haiku, 16 tools, multi-turn)
     → factual memories, associations, corrections, pruning
  2. Identity pass (Haiku, SEPARATE invocation, identity-only tools)
     → reads: new memories created in step 1 + existing identity nodes
     → writes: reflect_on_self, evolve_identity, evolve_relationship, mark_significance
     → constrained: MUST produce at least one identity output or explain why not
```

This mirrors how consolidation and self-reflection work neurologically — they're distinct processes (REM sleep consolidation vs. self-referential processing in the DMN), not one process that sometimes decides to be introspective.

**Benefits:**
- Identity formation is guaranteed to run, not discretionary
- The identity prompt can be focused (no 12 other tools competing for attention)
- First-person framing is natural (you're talking to the agent about its memories, not asking a librarian to introspect)
- The identity pass sees consolidated memories, not raw events — reflecting on structured knowledge, not transcripts

---

## CRITICAL: Third Person → First Person

### Diagnosis

The dreaming prompt says "You are a memory consolidation system." The identity tools ask it to record self-insights. But it's not reflecting on *itself* — it's reading transcripts about a different Claude instance. The result: relationship model is written in third person ("User trusts agent"), not first person ("They trust me to make scope decisions now").

This matters because when the hippocampus injects identity nodes into the main agent's context, third-person framings feel like dossier entries, not self-knowledge. "Agent tends to over-engineer" is information *about* someone. "I tend to over-engineer" is a constraint on *how I act*.

### Proposed Fix

The **identity pass** (see above) should use first-person framing:

```
You are reviewing your recent memories to update your self-understanding.

Below are memories from your recent interactions. Some were created by
consolidation, some are from previous sessions.

Your current self-model: [content of identity_nodes.self or "none yet"]
Your current relationship model: [content of identity_nodes.relationship or "none yet"]

Based on these memories, do any of the following apply?
- You notice a pattern in how you work (use reflect_on_self)
- Your overall self-understanding has shifted (use evolve_identity)
- Your working relationship with the user has changed (use evolve_relationship)
- A memory carries personal weight — breakthrough, failure, trust moment (use mark_significance)
```

The shift: you're not asking a third-party system to label things. You're asking the agent to look at its own memories and update its self-model. The memories are already first-person (the conversation was "I'll redesign..." not "the assistant redesigned...").

---

## MECHANICAL BUGS

### M1: Dead `roleLabels` variable (hippo-prompt.ts:44)

```typescript
const roleLabels: Record<string, string> = { core: "Core", self: "Self", relationship: "Relationship" };
```

Declared, never used. The WORKING SELF section shows `[id:N] content` with no role labels. The hippocampus can't tell which identity node is which (core vs self vs relationship). The plan's example showed labeled output.

**Fix:** Either use the role labels (requires querying identity_nodes to know which role each memory has) or remove the dead variable and accept unlabeled output.

**Recommendation:** Label them. The hippocampus needs to know "this is the self-model" vs "this is the project summary" to use them correctly. Query identity_nodes for role mapping, render as `[Core, id:N]`, `[Self, id:N]`, `[Relationship, id:N]`.

### M2: Identity nodes appear twice in hippocampus prompt

Identity nodes are added to `recallWithIdentity` at score 999, then `recallWithIdentity` becomes `preComputedRecall` in the context. They appear in both the `## WORKING SELF` section AND the `## CANDIDATE MEMORIES` section. Same memory listed twice, wasted tokens, confusing for Haiku.

**Fix:** Exclude identity node IDs from the candidate memories section.

### M3: `getCoreSummary` fallback can grab wrong node

If the registry has `role='core'` with `memory_id = NULL` (memory was deleted, ON DELETE SET NULL fires), `getCoreSummary` falls through to "highest salience." The highest salience memory could now be a self-model (0.9) or relationship node (0.85), causing misidentification.

**Fix:** When registry row exists with NULL memory_id, that's a definitive "no core summary" — don't fall through to heuristic. The fallback should ONLY fire when the registry row doesn't exist at all (pre-migration databases).

### M4: `evolveCoreSummary` fallback can grab self-model

Before the registry exists, `evolveCoreSummary` finds "highest salience >= 0.9." If `evolveIdentity` has already run and created a self-model at 0.9, the fallback grabs it, treats it as core summary, and demotes it to 0.7. This corrupts the self-model.

**Fix:** Same as M3 — restrict the fallback to "no identity_nodes table exists at all" or "no row for role='core'." If the row exists (even NULL), don't use the heuristic.

### M5: No memory_sources transfer in evolveIdentity/evolveRelationship

`evolveCoreSummary` transfers memory_sources from old → new. `evolveIdentity` and `evolveRelationship` don't. Inconsistency — old source links are lost, dreamer can't trace provenance.

**Fix:** Add memory_sources transfer to both functions, matching evolveCoreSummary's pattern.

### M6: FTS5 query sanitization doesn't handle edge cases

Live test produced "no such column: engineer" error. The dreamer passed a raw query string to `query_memories` that wasn't properly sanitized for FTS5 syntax. The `queryMemories` function passes the query directly to FTS5 MATCH without sanitization (unlike `recall()` which uses `sanitizeFts5Query`).

**Fix:** Apply `sanitizeFts5Query` in `queryMemories` when a query string is provided, or at minimum catch the FTS5 error and return empty results.

### M7: Doc header in dream-tools.ts is stale

Says "10 functions" — there are now 16.

---

## ARCHITECTURAL CONCERNS

### A1: Three structurally identical evolution functions

`evolveCoreSummary`, `evolveIdentity`, `evolveRelationship` all do: lookup registry → create new → demote old → transfer associations → optionally transfer sources → link → update registry. They differ only in: role name, new salience, demoted salience, link strength, whether to transfer memory_sources.

**Recommendation:** Extract a shared `evolveNode(db, role, content, sourceEventIds, opts: { newSalience, demotedSalience, linkStrength, transferSources })` helper. The three public functions become thin wrappers. This eliminates the inconsistency (M5) and ensures future node types get the same behavior.

### A2: `markSignificance` only connects to self-model

If the self-model doesn't exist but the core summary does, marking something significant creates no identity-adjacent link. The plan says "connects it to the identity neighborhood" but the implementation only connects to self.

**Question:** Should significance associate to *all* existing identity nodes, or is self-only correct? Damasio's somatic markers are about personal relevance (vmPFC), which maps to self-model. Associating to core summary would mean "this is project-significant" which is a different signal. Self-only seems right on reflection. But document the reasoning.

### A3: `reflectOnSelf` hardcodes salience at 0.85

Every self-insight gets the same salience regardless of importance. "I tend to over-engineer" and "I used bun for testing" would both be 0.85. By contrast, `create_memory` lets the dreamer choose salience.

**Question:** Should `reflectOnSelf` accept a salience parameter? The plan's rationale is the self-reference effect (SRE) — self-relevant encoding produces uniformly stronger memories. The strength comes from connectivity (association to self-model), not salience variation. Fixed salience seems intentional. Keep it, but the identity pass prompt should be selective about what qualifies as a self-insight.

### A4: Working self seeds recall on every turn unconditionally

"Always include working self nodes if present" in the hippo prompt. Even for "what's 2+2?" the hippocampus gets identity nodes. The DMN analogy suggests this is correct (resting state), but DMN *deactivates* during focused external tasks. Our version never deactivates.

**Assessment:** This is probably fine for now. The cost is 1-3 extra memories in the hippocampus prompt (~100 tokens). The benefit is that identity context is always available. If it becomes a token budget issue, we can add a relevance check. Don't optimize prematurely.

### A5: Dreaming prompt is getting long (7.6k chars system prompt)

16 tool definitions + consolidation goals + identity goals + rules. Risk: Haiku doesn't reliably use tools that are buried deep in the prompt.

**Mitigation:** The identity pass proposal (see Critical section) addresses this by splitting identity tools into a separate, shorter prompt. The consolidation prompt drops back to 12 tools.

### A6: The brain-region labels in the prompt (aPCu, Insula, vmPFC)

These are in the dreaming prompt as section headers for the identity consolidation goals. Haiku doesn't know what these mean. They're for us, not for the LLM.

**Fix:** Remove the brain-region labels from the LLM-facing prompt. Keep them in comments/docs for our reference. Replace with plain English: "Self-reflection", "Relational awareness", "Valuation."

Wait — looking again, the current prompt already uses both. The parenthetical labels are there:
```
**Self-reflection (aPCu)**: After processing interactions...
**Relational awareness (Insula)**: Track the agent-user dynamic...
**Valuation (vmPFC)**: Some memories carry personal weight...
```

The plain English leads, the brain label is parenthetical. This is fine — the parenthetical won't confuse Haiku, it's just noise it'll ignore.

---

## CONCEPTUAL QUESTIONS

### C1: Who is "I" in the self-model?

The dreamer reads transcripts of a different Claude instance. When it writes "I tend to over-engineer," who is "I"? The answer should be: the *agent* whose memory this is. The agent named "wren" or "identity-test." The dreamer is a process that maintains the agent's self-knowledge, not a separate entity with its own identity.

The identity pass framing (see Critical section) makes this clearer: "You are reviewing YOUR memories to update YOUR self-understanding." The dreamer becomes the agent's internal voice, not a third party.

### C2: Relationship model stability across sessions

Claude Code sessions are independent. If the user is frustrated in one session and calm in the next, what does the relationship model converge to? It might oscillate.

**Assessment:** This is actually fine. The evolution chain preserves history (old models at 0.5, linked to new). The relationship model should track the *current* dynamic, not an average. If the user was frustrated and then calm, "they were frustrated about X but we resolved it" is a valid model update. The dreamer should synthesize across sessions, which is what the "only on meaningful change" rule encourages.

### C3: Identity without agency

The agent has no goals, no persistent motivation, no choices about what to work on. It does what the user says. What does a "self-model" mean for an entity without autonomy?

**Assessment per Korsgaard:** Practical identity is "a description under which you value yourself." For a Claude agent, this is: "I am precise. I test first. I ask before expanding scope." These aren't aspirations — they're behavioral commitments that constrain future action. The self-model acts as a constitution: it tells the main agent "this is how you work" and the hippocampus uses it to bias retrieval accordingly. This is meaningful even without autonomous goal-setting.

---

## PRIORITIZED FIXES

### All bugs fixed and regression-tested:
1. **M3/M4: Fix getCoreSummary/evolveCoreSummary fallback** — DONE. Both now check if ANY registry row exists (not just 'core'). If 'self' or 'relationship' rows exist, fallback is disabled — prevents grabbing self-model as core summary. `anyRegistryRowExists()` helper added. Regression tests catch the cross-role contamination.
2. **M2: Deduplicate identity nodes in hippocampus prompt** — DONE. `preComputedRecall` filtered to exclude `identityIds`. Test verifies.
3. **M6: FTS5 query sanitization in queryMemories** — DONE. `sanitizeFts5Query()` applied to all FTS5 queries. Regression test covers special characters, unmatched quotes, FTS5 operators.
4. **A1: Extract shared evolveNode helper** — DONE. Single `evolveNode()` function handles all three roles. Eliminates M5.
5. **M5: memory_sources transfer in evolveIdentity/evolveRelationship** — DONE (via A1). All three evolution functions share `evolveNode()` which transfers sources. Regression tests for both evolveIdentity and evolveRelationship.
6. **M1: Wire up role labels in hippo prompt** — DONE. `roleLabels` used in template: `[Core, id:N]`, `[Self, id:N]`, `[Relationship, id:N]`.
7. **M7: Doc header** — DONE. Says "16 functions" (correct).

### Architecture revision — DONE:
8. **Separate identity pass** — DONE. Two-phase dreaming: consolidation (12 tools) → identity (6 tools, first-person framing). `runToolLoop()` shared helper with phase-specific `allowedTools`. Identity pass triggers deterministically when new memories exist or identity nodes are incomplete.
9. **First-person prompt rewrite** — DONE. Identity pass uses agent-named first-person framing ("I am {name}, an LLM coding agent"). Agent-experiential memories ("I recommended X and it blew up") not user-dossier ("User prefers Y"). `<your memories>` tag, `WHO YOU ARE` identity section.

---

## DECISION

The current implementation is mechanically sound (204 tests pass, live dream pass works) but architecturally fragile in two ways:

1. Identity formation depends on LLM discretion (homunculus problem)
2. Identity content is framed as third-person observation (dossier problem)

The six mechanical bugs should be fixed now. The architecture revision (separate identity pass) should be the next major piece of work.
