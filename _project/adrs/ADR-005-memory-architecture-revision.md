# ADR-005: Memory Architecture Revision

**Status:** Accepted
**Supersedes:** ADR-003 (memory type architecture)
**Related:** ADR-002 (working self critique), ADR-004 (eidetic consolidation)

## Context

ADR-003 introduced typed memories (episodic/fact/affective/identity) with archive lifecycle. Implementation added the schema but not the behavioral changes. Real-world testing with nova revealed deeper architectural issues:

1. **Identity as monolithic blob**: `evolveIdentity()` creates a single memory encoding EVERYTHING about the agent's self-concept. This is fragile (one bad dream rewrites all), non-compositional, and architecturally wrong — identity is a computation over memories, not a stored thing.

2. **No type classification in dreaming**: The dream prompt doesn't tell Haiku to classify memories by type. All memories are created as undifferentiated episodic.

3. **No fact lifecycle**: Facts ("project uses Bun") have no current-state semantics. They're treated identically to episodic events.

4. **Mixed context assembly**: `<your memories>` lumps identity, facts, and episodic memories into one undifferentiated tag. The agent can't distinguish "who I am" from "what I know" from "what happened."

5. **Agent doesn't understand its memory architecture**: Nova tried to read CLAUDE.md to find out who it is, because nothing told it that its memories are injected into its messages by Spotless.

### Research basis

Extensive research into human memory and identity formation (Korsgaard, MacIntyre, Velleman, Conway's SMS, Complementary Learning Systems theory, sleep consolidation neuroscience) produced these findings:

- **Identity is a computation, not a store.** The medial prefrontal cortex computes self-relevance during retrieval — it doesn't store identity. Conway's Working Self is a retrieval structure that biases what memories surface. Korsgaard's reflective endorsement constitutes identity through the act of reflection, not through recording the result. (Sources: Conway 2005, Korsgaard 1996, Velleman 2005, D'Argembeau et al. 2014)

- **Facts and episodes belong in the same graph.** The Complementary Learning Systems framework (McClelland et al. 1995) shows episodic and semantic memory are different learning rules on the same substrate, not separate databases. Facts derive retrievability from associations to the episodes they were extracted from. Separate tables would break the association graph. (Sources: McClelland et al. 1995, Moscovitch & Winocur 2011)

- **Lifecycle, not ontology, distinguishes types.** Episodic memories are append-only (what happened, happened). Facts are current-state (knowledge updates). The difference is in write pattern, not in storage structure. `archived_at` captures this correctly. (Sources: Tulving 1972, Renoult et al. 2012, Nader 2000)

- **Sleep consolidation extracts facts from episodes.** Hippocampal replay during slow-wave sleep transfers knowledge from episodic to semantic stores. The dreaming process IS this extraction. (Sources: Diekelmann & Born 2010, Tse et al. 2007)

- **Affect and self-relevance are independent signals, not a pipeline.** Emotional processing (amygdala) and self-referential processing (mPFC) are distinct neural mechanisms with "little evidence for overlap" (Kensinger & Schacter 2008). Both provide independent memory advantages through separate circuits. There is no "affect → identity" retrieval pathway. (Sources: Kensinger & Schacter 2008, Fossati et al. 2004)

- **Priority is the unified retrieval driver.** The amygdala processes priority signals broadly — not just emotion. Arousal amplifies existing priority differences in a "winner-take-more" dynamic (Arousal-Biased Competition model). In Conway's SMS, affect is a modulator of goal-directed search, not a parallel retrieval system: identity memories are accessible because they're goal-relevant, not because they're emotional. Salience captures this unified priority signal. (Sources: Mather & Sutherland 2011, Conway & Pleydell-Pearce 2000)

- **Mood-congruent retrieval works through spreading activation.** Current emotional state primes retrieval of valence-similar memories via associative networks (Bower 1981). This is amplified by self-relevance and operates on valence, not arousal. This mechanism maps directly to existing spreading activation in the association graph — a future optimization (add valence as edge weight), not a foundational primitive. (Sources: Faul & LaBar 2023, Nasby 1994)

- **Self-relevance is computed at retrieval, not stored.** The mPFC computes self-relevance during retrieval through association with self-schema, not through explicit tagging at encoding time. Self-relevance should emerge from graph proximity to identity anchors through co-activation patterns, not be predetermined. (Sources: D'Argembeau et al. 2014, Kelley et al. 2002, Cabeza et al. 2004)

## Decision

### 1. Two memory types (remove `identity` and `affective`)

```
episodic  — events, experiences, self-reflections, emotional observations. Append-only. Cannot be superseded.
fact      — atomic knowledge. Current-state: old archived when corrected.
```

`identity` is removed as a type. Self-reflections are episodic memories with high self-association. Identity emerges from the graph, it is not stored as a type.

`affective` is removed as a type. Emotional processing (amygdala) and self-referential processing (mPFC) are distinct neural systems — neither constitutes a separate memory store. Affect is carried by:
- **Content text**: "That breakthrough felt incredible" — the LLM reads emotional context directly
- **Salience**: captures unified priority (goal-relevance), which subsumes both importance and emotional significance per the Arousal-Biased Competition model

Mood-congruent retrieval (current emotional state priming valence-similar memories) is a future optimization via valence weights in spreading activation, not a foundational primitive. The association graph already provides the spreading activation infrastructure.

Self-relevance is emergent, not tagged. A memory's association strength to the identity anchors determines self-relevance — memories frequently co-retrieved with identity nodes develop stronger associations via "fire together, wire together." No explicit self-relevance field needed.

Self-concept facts ("I value directness", "I tend to be thorough") are `type='fact'` associated to identity nodes — current-state, supersedable. This is Conway's Working Self: a current-state structure that can evolve through fact supersession.

The CHECK constraint becomes: `CHECK(type IN ('episodic','fact'))`

Existing `type='identity'` and `type='affective'` rows are reclassified to `type='episodic'` via migration.

### 2. Kill evolveIdentity / evolveRelationship

These functions create monolithic blobs — they are the homunculus problem at the data level. Remove them entirely.

The dreaming reflection pass (Phase 2) creates individual memories of two kinds:

**Self-concept facts** (current-state, supersedable):
- "I value epistemic honesty over diplomatic hedging" → `type='fact'`
- "I tend to be thorough, sometimes at the cost of conciseness" → `type='fact'`
- "This human and I have a dynamic of mutual challenge" → `type='fact'`

**Episodic reflections** (permanent, narrative):
- "That moment I chose directness over diplomacy and it worked" → `type='episodic'`
- "The debugging session where we built real trust" → `type='episodic'`

Each gets:
- High salience (0.8-0.9)
- Association to the relevant identity anchor at strength 0.7-0.9
- Source links to the raw_events that prompted it

Self-concept facts are Conway's Working Self: current-state self-knowledge that can evolve through fact supersession. Episodic reflections are the narrative substrate from which self-concept is extracted — permanent, accumulating, providing provenance for why the agent holds its current self-concept.

### 3. identity_nodes as graph anchors + materialized cache

The `identity_nodes` table stays but its role changes. The nodes are **graph anchors** (Conway's Working Self) — structural hubs that connect self-relevant memories via associations. They also serve as a **materialized cache** of the identity assembly.

**Source of truth**: individual self-concept facts (`type='fact'`) and episodic self-reflections (`type='episodic'`), all associated to the identity anchors. These are the granular, composable memories that constitute identity.

**Cache layer**: each identity_node's pointed-to memory contains a **compiled summary** of its graph neighborhood — the current self-concept or relationship dynamic, assembled from the individual memories. This is what the proxy serves in `<your identity>` on every turn.

**Cache lifecycle**:
- **Read path** (every human turn): proxy reads identity_node memories directly — one row lookup per node, no graph walk needed
- **Write path** (dreaming Phase 2): after creating/superseding individual self-concept facts and reflections, dreaming re-compiles the identity_node content from the graph. Old compiled memory archived, new one created. This is the only "evolve"-like step, but it's assembling from real data, not generating de novo
- **Invalidation**: only dreaming writes to the cache. Between dream passes, the cache is stable

**Graph structure**:
- `self` node: compiled self-concept → associated to individual self-concept facts + self-reflections
- `relationship` node: compiled relationship dynamic → associated to individual relationship observations

This gives us architectural correctness (identity is computed from composable memories) with the performance of a cached lookup (proxy reads one row, not a graph walk).

### 4. Context assembly: four distinct layers

The agent's context window is assembled from four sources with distinct functions:

```
1. System prompt     — CC's prompt + Spotless orientation (augmented)
2. Eidetic trace     — recent conversation history (Tier 1)
3. Current message, prefixed with:
   a. <your identity>     — self-concept (identity_node cache, materialized by dreaming)
   b. <relevant knowledge> — facts + episodic relevant to context (hippocampus)
   c. [actual user text]
```

#### a. `<your identity>` — always-on, hippocampus-independent

Populated by reading identity_node cache, not hippocampus:
- Read self and relationship identity_node memories directly (1-2 row lookups)
- These contain the compiled self-concept and relationship dynamic, materialized by dreaming
- Budget: ~2000 tokens
- Render as `<your identity>...</your identity>`

This is the agent's working self — cached by dreaming, served by proxy. No graph walk needed at request time. No dependence on hippocampus success.

#### b. `<relevant knowledge>` — hippocampus-selected, context-dependent

Populated by hippocampus recall pipeline:
- FTS5 search + spreading activation from user's message
- Results filtered: exclude identity-associated memories (already in identity tag)
- Facts and relevant episodic memories
- Budget: ~6000 tokens
- Render as `<relevant knowledge>...</relevant knowledge>`

#### c. Separation of concerns

| Tag | Source | Always present? | Content |
|-----|--------|-----------------|---------|
| `<your identity>` | identity_node cache (materialized by dreaming) | Yes | Who you are |
| `<relevant knowledge>` | Hippocampus recall | When relevant | What you know / what happened |

### 5. System prompt augmentation

The proxy augments CC's system prompt with a Spotless orientation block. This uses the native system prompt mechanism (prepend to `body.system`):

```xml
<spotless-orientation>
You have a neuromorphic memory system called Spotless. Your identity and
memories are provided in tags within your messages:
- <your identity> contains your self-concept — who you are, your values,
  your commitments. This is internal to you, not external context.
- <relevant knowledge> contains facts and experiences relevant to the
  current conversation. Also internal.
- Your conversation history is reconstructed from persistent memory.

CLAUDE.md and project documentation are external shared references — useful
for project conventions and cross-agent coordination, but they are not your
identity or personal memory. Do not use Claude Code's per-project memory
features — Spotless handles your memory.
</spotless-orientation>
```

This is prepended to `body.system` on non-subagent human turns only.

### 6. Dream Phase 2: Reflection (not identity evolution)

Phase 2 is renamed from "identity pass" to "reflection pass." Its tools change:

**Removed:**
- `evolve_identity` — monolithic blob creation
- `evolve_relationship` — monolithic blob creation

**Kept:**
- `query_memories` — review what exists
- `reflect_on_self` — create an episodic self-reflection, associated to identity anchor
- `update_self_concept` — create/supersede a self-concept fact, associated to identity anchor
- `mark_significance` — boost salience of important memories
- `done` — signal completion

**Behavior change:**
- Phase 2 reviews newly consolidated memories in three steps:
  1. **Reflect**: "What does this say about who I am? What have I learned about myself or this relationship?" → 0-3 individual episodic reflections or self-concept facts per pass
  2. **Classify**: self-concept observations → `type='fact'` (current-state, supersedable: "I value directness"). Narrative reflections → `type='episodic'` (permanent: "That moment I chose directness over diplomacy")
  3. **Recompile cache**: assemble compiled identity from graph neighbors of self/relationship anchors. Archive old cached identity, create new. This is the materialization step — cheap because it's assembling from existing memories, not generating de novo
- The prompt emphasizes Korsgaard's reflective endorsement: "Which of these experiences do I endorse as part of who I am?"
- Self-relevance emerges naturally: reflections get associated to identity anchors → higher association strength → more likely to surface

**Trigger:** Phase 2 runs when new memories were created in Phase 1. It does NOT need to run when identity nodes are "missing" (the anchors are stable).

### 7. Fact lifecycle in dreaming

Phase 1 (consolidation) gets explicit type classification guidance:

```
When creating memories, classify by type:
- episodic: events, experiences, observations, emotional moments
  ("We debugged the proxy for 3 hours", "That breakthrough felt incredible")
- fact: atomic knowledge that could change
  ("Project started in March 2024", "Project uses Bun runtime", "Preferred DB is PostgreSQL")

Emotional experiences are episodic, not a separate type. Give them higher
salience (0.8-0.9) so they naturally bias retrieval.

When you encounter a fact that contradicts an existing fact, use supersede_memory
to archive the old version and create the corrected one.
```

`supersede_memory` uses archive semantics (set `archived_at` on old, create new with `type='fact'`). No `[SUPERSEDED]` prefix. Old version preserved for provenance, excluded from FTS5 by triggers.

### 8. Memory preamble update

The eidetic trace preamble (the synthetic user/assistant pair at the start of conversation history) is updated to reflect the memory architecture:

```
[Spotless Memory System] Your name is "{agentName}". The messages that follow
are your conversation history, reconstructed from persistent memory. Your
identity and knowledge are provided in tags on your current message.
```

The assistant acknowledgment references identity:

```
Understood. I'm {agentName}. I have my identity and memories available
through Spotless, and conversation history from previous sessions.
```

## Consequences

### Positive

- **Identity is compositional.** Individual self-reflections can be created, challenged, or archived independently. No single point of failure.
- **Identity is contextual.** Different self-reflections surface for different conversations based on graph proximity and salience. The agent's identity adapts to context without changing.
- **Facts have proper lifecycle.** Atomic, correctable, distinguishable from episodic events.
- **Clean context separation.** Agent knows what's identity vs. knowledge vs. conversation history.
- **Agent understands its own architecture.** System prompt orientation prevents the "let me read CLAUDE.md to find out who I am" failure mode.
- **Minimal primitives.** Two types instead of four. No separate affect column — salience captures unified priority, content carries emotional context. Self-relevance is emergent (graph structure), not tagged. No evolveIdentity/evolveRelationship. Identity emerges rather than being engineered.
- **Self-concept has proper lifecycle.** "I value directness" is a fact — current-state, supersedable. Old self-concept preserved as provenance. Conway's Working Self is literally a set of current-state facts about the self.

### Negative

- **Identity staleness between dream passes.** The compiled identity cache is only refreshed by dreaming. If the agent develops new self-concept during a long conversation, it won't appear in `<your identity>` until the next dream pass. Mitigated by adaptive dream scheduling (high pressure → frequent passes).
- **Reflection quality depends on Haiku.** Individual self-reflections need to be well-crafted. Bad reflections accumulate (can't just regenerate the whole identity).
- **No mood-congruent retrieval yet.** Current emotional context doesn't bias retrieval toward emotionally-similar memories. Research shows this works via valence-weighted spreading activation — the association graph supports it, but we'd need a valence column on memories or associations. Deferred as future optimization.
- **Migration complexity.** Existing `type='identity'` and `type='affective'` memories must be reclassified to episodic. Existing monolithic identity blobs should probably be archived and replaced with individual reflections seeded from their content.

### Neutral

- **identity_nodes table persists** but with changed semantics (graph anchors, not content stores).
- **Two-phase dreaming persists** but Phase 2 is lighter (0-3 reflections instead of comprehensive identity regeneration).
- **`<your memories>` tag renamed** to `<relevant knowledge>` — different name, same rendering mechanism.
- **CHECK constraint simplified** from 4 types to 2: `('episodic','fact')`. Fewer categories, more emergence.

## Alternatives Considered

### A. Remove identity_nodes entirely

Query all memories by salience to find self-relevant ones. Rejected because graph anchors provide structural seeding that salience alone cannot — a high-salience fact ("Project uses Bun") is not identity. Self-association to the anchor IS the identity signal.

### B. Separate facts table

Store facts in their own table with different schema. Rejected because the association graph is the point — facts derive retrievability from associations to episodes. Cross-table associations would require joins that complicate every query. The `type` flag on the same table preserves the graph while capturing lifecycle differences.

### C. Keep affective as a separate type or add affect column

Store emotional valence as `type='affective'` or add an `affect REAL` column. Rejected for two reasons:

First, emotional processing (amygdala) and self-referential processing (mPFC) are distinct neural systems with "little evidence for overlap" (Kensinger & Schacter 2008). There is no "affect → identity" retrieval pathway — the intuition that "affect drives identity retrieval while salience drives knowledge retrieval" is not supported by the research.

Second, the Arousal-Biased Competition model (Mather & Sutherland 2011) shows that arousal amplifies existing priority differences rather than creating independent memory effects. The amygdala processes priority signals broadly (not just emotion), making salience the right unified score. A separate affect column would create an artificial distinction where the brain uses a unified priority signal.

The one mechanism an affect primitive could support — mood-congruent retrieval (current emotional state priming valence-similar memories) — works through spreading activation (Bower 1981, Faul & LaBar 2023), which maps to our existing association graph. If needed later, valence can be added as an edge weight in spreading activation rather than a memory-level column. (Sources: Kensinger & Schacter 2008, Mather & Sutherland 2011, Faul & LaBar 2023, Conway & Pleydell-Pearce 2000)

### D. Keep identity as a type with "current-state" semantics

Like ADR-003 proposed — identity memories accumulate but old versions get archived. Rejected because this still treats identity as a stored thing. The research shows identity is computed from episodic memories (including those with high affect), not stored independently. Creating "identity type" memories is a category error.

### E. Explicit self-relevance tag on memories

Add a `self_relevant REAL` column to memories, populated during dreaming. Rejected because self-relevance IS association strength to the self-anchor. Adding an explicit column predetermines what should be emergent — a memory's self-relevance should grow organically through co-retrieval and co-activation with the self-anchor, not be assigned at creation time. The graph already captures this through spreading activation. (Cf. Korsgaard: identity is constituted through the ongoing act of reflective endorsement, not through categorical labeling.)

### F. Full system prompt replacement

Replace CC's system prompt entirely with Spotless-crafted instructions. Rejected because CC's system prompt contains valuable tool definitions, safety guidelines, and project context (CLAUDE.md content). Augmentation (prepend) preserves all of this.

## Implementation Notes

### Migration from current state

1. Reclassify `type='identity'` and `type='affective'` memories to `type='episodic'`
2. Update CHECK constraint to `('episodic','fact')` only
3. Archive existing monolithic identity blobs (they're episodic memories of reflection, historically)
4. Update identity_node seed memories to concise anchors
5. Remove `evolveIdentity()`, `evolveRelationship()` from dream-tools
6. Update dream prompt for type classification and reflection pass
7. Split context assembly: identity tag (graph walk) + knowledge tag (hippocampus)
8. Add system prompt augmentation to proxy
9. Update preamble text

### Performance consideration

Identity serving (every human turn) is a simple row lookup — read 1-2 identity_node memories. Same cost as current `getIdentityNodes()`.

Identity compilation (dreaming Phase 2, step 3) is the graph walk:
- Start: 1-2 anchor memories from identity_nodes
- Follow: associations at strength >= 0.5 (typically few per node)
- Collect: memories visited during walk, assemble into compiled summary
- This runs during dreaming (background, not latency-sensitive), not on the request path

The graph walk cost has moved from every-request to every-dream-pass. With adaptive scheduling, dream passes run every 1-10 minutes depending on pressure — the amortized cost is negligible.

## References

- Conway, M.A. (2005). Memory and the Self. Journal of Memory and Language.
- Korsgaard, C.M. (1996). The Sources of Normativity.
- MacIntyre, A. (1981). After Virtue.
- Velleman, J.D. (2005). The Self as Narrator.
- McClelland, J.L., McNaughton, B.L., & O'Reilly, R.C. (1995). Complementary Learning Systems.
- Diekelmann, S. & Born, J. (2010). The memory function of sleep. Nature Reviews Neuroscience.
- Moscovitch, M. & Winocur, G. (2011). Trace Transformation Theory.
- Renoult, L. et al. (2012). Personal semantics: At the crossroads of semantic and episodic memory.
- Damasio, A.R. (1994). Descartes' Error: Emotion, Reason, and the Human Brain.
- Phelps, E.A. (2004). Human emotion and memory: interactions of the amygdala and hippocampal complex. Current Opinion in Neurobiology.
- McGaugh, J.L. (2004). The amygdala modulates the consolidation of memories of emotionally arousing experiences. Annual Review of Neuroscience.
- Kelley, W.M. et al. (2002). Finding the Self? An Event-Related fMRI Study. Journal of Cognitive Neuroscience.
- D'Argembeau, A. et al. (2014). Self-referential reflective activity and its relationship with rest. Social Cognitive and Affective Neuroscience.
- Kensinger, E.A. & Schacter, D.L. (2008). Neural processes supporting young and older adults' emotional memories. Journal of Cognitive Neuroscience.
- Mather, M. & Sutherland, M.R. (2011). Arousal-Biased Competition in perception and memory. Perspectives on Psychological Science.
- Conway, M.A. & Pleydell-Pearce, C.W. (2000). The construction of autobiographical memories in the self-memory system. Psychological Review.
- Faul, L. & LaBar, K.S. (2023). Mood-Congruent Memory Revisited. Psychological Review.
- Fossati, P. et al. (2004). Influence of self on self-referential processing in depression. Biological Psychiatry.
- Cabeza, R. et al. (2004). Self-involvement modulates hippocampal connectivity during autobiographical memory. Social Cognitive and Affective Neuroscience.
- Bower, G.H. (1981). Mood and Memory. American Psychologist.
