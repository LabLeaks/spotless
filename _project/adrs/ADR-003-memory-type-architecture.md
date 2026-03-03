# ADR-003: Memory Type Architecture

**Status**: Accepted
**Date**: 2026-02-27
**Supersedes**: Partial — rearchitects the flat `memories` table from Sprint 4-5. ADR-001 and ADR-002 remain valid as behavioral/structural decisions within the new type system.

---

## Problem Statement

The current `memories` table is a flat bag. A distilled fact ("project uses Bun"), a self-model statement ("I am nova, instantiated within a reductionist framework..."), an episodic recollection ("I recommended MongoDB and watched it fail"), and an emotional valence marker ("that conversation was tense") all live in the same table with the same schema. The only differentiation is salience score and free-text content.

This creates concrete problems:

1. **Identity duplication**: `evolveIdentity` creates new memories for each evolution. Over 22 dream passes, 6 near-identical self-model statements accumulated. They can't be pruned (associations, salience too high) and consolidation doesn't merge them (Haiku never calls `merge_memories`). Identity is a *state*, not something you accumulate — but the schema treats it as accumulation.

2. **Facts never get corrected cleanly**: `supersede_memory` demotes the old version with `[SUPERSEDED]` prefix at 0.1 salience, creates a new version, and adds a breadcrumb association. But the old row persists in FTS5, polluting search results. Facts should have current-state semantics — one active version, old versions archived out of search.

3. **No affect processing**: There's no mechanism to capture emotional valence ("that was tense", "user was frustrated", "breakthrough moment"). Salience scores encode importance but not affect. Affective memories are what drive identity formation — without them, the identity pass operates on raw facts rather than lived experience.

4. **Eidetic buffer grows forever**: `raw_events` is append-only with no lifecycle. Once consolidated into memories, the raw events still consume FTS5 index space. The eidetic trace builder budget-trims from the front for context assembly, but the underlying data never shrinks. Neurologically, eidetic memory is *short* — it's a processing buffer, not an archive.

---

## Decision

Introduce a **type taxonomy** for memories with distinct lifecycle semantics. Two lifecycle classes:

- **Permanent**: episodic, affective — experiences that accumulate
- **Current-state**: facts, identity — derived knowledge that gets replaced

Add an `archived_at` column for current-state types. When a fact or identity node is superseded, the old version gets archived (timestamped, excluded from FTS5 search) but preserved for provenance.

Remove consolidated events from `raw_events_fts` after dreaming processes them. Recall (hippocampus) searches typed memory FTS5 instead.

### Type Definitions

#### Eidetic (Tier 1 — `raw_events`, unchanged)

The processing buffer. Raw conversation events archived as content blocks.

- **Lifecycle**: Append-only, kept forever as log
- **FTS5**: Consolidated events removed from `raw_events_fts` after dreaming. Only unconsolidated events remain searchable (by dreaming only)
- **Not directly queried by recall** — hippocampus searches typed memories

#### Episodic (Tier 2 — permanent)

Event memories. "What happened." The agent's experiences.

- "I recommended MongoDB and the user pushed back hard — they lost data twice with it"
- "We spent 3 hours debugging the SSE streaming bug. The root cause was accept-encoding"
- "The user asked me to remember their dog's name across sessions — this was a test of persistence"

**Lifecycle**: Permanent. Created during consolidation. Never auto-deleted. Can be merged if overlapping.
**Salience**: 0.5-0.8 range. Decays only if never accessed.
**Pipeline**: eidetic → episodic (dreaming consolidation extracts episodes from raw events)

#### Atomic Facts (Tier 2 — current-state)

Distilled knowledge. "What's true right now."

- "Project started in March 2024"
- "Project uses Bun runtime, not Node"
- "Architecture: hexagonal with ports and adapters"

**Lifecycle**: Current-state. One active version per fact. When corrected/superseded, old version gets `archived_at` timestamp — preserved for provenance but excluded from FTS5 search.
**Salience**: 0.5-0.9 depending on importance. Corrections get high salience.
**Pipeline**: eidetic → atomic (dreaming extracts facts, checks for existing, supersedes if corrected)

#### Affective (Tier 2 — permanent)

Emotional/valence memories. "What mattered." What shaped the agent.

- "The MongoDB conversation was emotionally charged — user was frustrated, I felt the weight of a bad recommendation"
- "Breakthrough moment when cross-session memory worked for the first time"
- "User's patience during the debugging session — they let me work through it"

**Lifecycle**: Permanent. Created during consolidation when affect is detected in raw events. Never auto-deleted.
**Salience**: 0.6-0.9. High affect events get high salience.
**Pipeline**: eidetic → affective (dreaming detects emotional valence in raw events)

#### Identity (Tier 2 — current-state)

Self-model and relationship model. "Who I am." Derived from affective and episodic memories.

- Self: "I tend to over-engineer under ambiguity. Learning to ask first."
- Relationship: "They trust me with destructive git ops. Push back on speculation."

**Lifecycle**: Current-state. One active version per role (self, relationship). When evolved, old version archived. Only the current version participates in FTS5 search and recall seeding.
**Salience**: Always high (0.85-0.9). Identity nodes seed recall at score 999 (unchanged from current).
**Pipeline**: affective + episodic → identity (identity pass synthesizes across accumulated experiences)

### Schema Changes

```
memories table (modified):
  + type TEXT NOT NULL DEFAULT 'episodic'
      -- CHECK(type IN ('episodic', 'fact', 'affective', 'identity'))
  + archived_at INTEGER  -- NULL = active, timestamp = archived
      -- Only meaningful for current-state types (fact, identity)

memories_fts:
  -- Rebuild trigger to exclude archived rows
  -- INSERT trigger: only index if archived_at IS NULL
  -- UPDATE trigger: if archived_at set, DELETE from FTS5

raw_events_fts:
  -- After consolidation, remove processed events:
  -- INSERT INTO raw_events_fts(raw_events_fts, rowid, content)
  --   VALUES('delete', event.id, event.content)
  -- for each event linked via memory_sources

identity_nodes table (unchanged):
  -- Still points into memories table
  -- Now constrained: referenced memory must have type='identity'

associations table (unchanged):
  -- Still spans all memory types
  -- Episodic ↔ affective ↔ fact ↔ identity all associate freely
```

### Processing Pipeline

```
                    eidetic buffer (raw_events)
                            │
                    ┌───────┴───────┐
                    │   DREAMING    │
                    │  (Phase 1)    │
                    └───────┬───────┘
                            │
              ┌─────────────┼─────────────┐
              │             │             │
              ▼             ▼             ▼
          episodic       atomic       affective
         (permanent)  (current-state) (permanent)
              │             │             │
              └─────────────┼─────────────┘
                            │
                    ┌───────┴───────┐
                    │   DREAMING    │
                    │  (Phase 2)    │
                    │  Identity     │
                    └───────┬───────┘
                            │
                            ▼
                        identity
                     (current-state)
```

Phase 1 reads eidetic buffer and produces three typed outputs:
- **Episodic**: narrative events worth remembering
- **Atomic**: distilled facts, checked against existing facts, superseded if corrected
- **Affective**: emotional/valence markers from conversations

Phase 2 reads the accumulated episodic + affective memories and evolves identity:
- Self-model derived from pattern of affective experiences
- Relationship model derived from interaction dynamics

### Current-State Replacement Semantics

When a current-state memory (fact or identity) is replaced:

1. Create new version with current content and salience
2. Set `archived_at = now()` on old version
3. FTS5 trigger removes old version from search index
4. Transfer associations from old → new
5. Old version preserved in table (queryable by ID for provenance, invisible to FTS5/recall)
6. `memory_sources` links preserved on both old and new (prevents re-learning)

This replaces the current `[SUPERSEDED]` prefix hack and the `evolveNode` demote-and-strip approach.

### Recall Changes

Hippocampus recall pipeline (FTS5 → spreading activation → scoring) changes minimally:

- FTS5 now searches typed memories (episodic, fact, affective, active identity) — archived rows excluded by trigger
- `raw_events_fts` no longer used by anything (consolidated events removed, unconsolidated only used by dreaming via SQL group queries)
- Identity nodes still seed at score 999
- Scoring unchanged: `α·recency + β·salience`
- Affective memories participate naturally — high salience, permanent, connected to related episodic/fact memories via associations

### Dreaming Prompt Changes

Phase 1 (consolidation) prompt gets a typed `create_memory` tool:

```
create_memory:
  type: "episodic" | "fact" | "affective"
  content: "..."
  salience: 0.7
  source_event_ids: [1, 2, 3]
```

The dreamer must classify each new memory. This is a lightweight LLM judgment — "is this an event, a fact, or an emotional response?" — not a hard classification problem.

`supersede_memory` becomes `replace_fact` or similar — explicitly for current-state types. Archives old, creates new, transfers associations.

Phase 2 (identity) tools unchanged conceptually — `evolve_identity` and `evolve_relationship` now use the current-state replacement semantics (archive old, no demote/strip/chain).

---

## Consequences

### Positive

- **Identity duplication eliminated**: Identity is current-state. One active self-model, one active relationship model. Old versions archived, not accumulated.
- **Fact correction is clean**: `archived_at` excludes old versions from FTS5. No `[SUPERSEDED]` prefix hack. No stale facts polluting search.
- **Affect drives identity**: Affective memories provide the experiential substrate that identity is built from. "I felt the weight of a bad recommendation" → "I tend to over-recommend complex solutions." This is psychologically accurate.
- **Eidetic buffer semantically shrinks**: Consolidated events leave FTS5. Dreaming naturally works from unconsolidated events. No FTS5 pollution from old raw data.
- **Recall improves**: FTS5 searches typed memories with clear lifecycle. No stale/archived content in results. Affective memories add emotional context to recall.
- **Backward compatible**: Existing memories can be migrated with `type='episodic'` default. Identity nodes already point at memories. Schema migration is additive.

### Negative

- **Classification burden on Haiku**: Dreaming must now decide type for each memory. Risk: Haiku might default to one type (like it currently defaults to `create_memory` over `merge_memories`). Mitigation: make the type decision simple — the prompt can give clear heuristics ("if it's about what happened → episodic, if it's a standalone fact → fact, if it describes feeling/tone/tension → affective").
- **Migration complexity**: Existing memories need type classification. Could be done by a one-time migration dream pass, or conservatively tagged `episodic` (safest default for permanent type).
- **More schema surface area**: Two new columns, FTS5 trigger changes, archive semantics. Modest increase in complexity.

### Neutral

- **Associations unchanged**: The graph still works the same way. Edges can connect any types. Spreading activation is type-agnostic.
- **Eidetic trace builder unchanged**: Still reads raw_events by message_group, still budget-trims. Doesn't care about FTS5.
- **Hippocampus orchestration unchanged**: Still spawns Haiku, still returns memory IDs. Type-awareness is in the prompt, not the orchestrator.

---

## Alternatives Considered

### A: Keep flat memories table, fix consolidation prompt

Just make Haiku better at merging/pruning by improving the prompt.

**Why rejected**: We tried. 0 merges and 0 prunes across 22 dream passes. The prompt says to merge and prune; Haiku doesn't. The problem is structural — the schema doesn't distinguish things that should accumulate from things that should be replaced. No amount of prompt engineering fixes a type error in the data model.

### B: Separate tables per type (episodic, facts, affective, identity)

Four distinct tables instead of a type column.

**Why rejected**: Associations become cross-table foreign keys (complex). FTS5 would need per-table indexes or a union view. Spreading activation BFS would need to join across tables. The type distinction is important for lifecycle but not for retrieval — at recall time, all types participate equally in the association graph. A type column preserves this.

### C: Type column without archive semantics

Add the type column but keep the current supersede/demote pattern for current-state types.

**Why rejected**: The whole point is that current-state types shouldn't accumulate. Without archive semantics (excluded from FTS5), old versions still pollute search results. The `archived_at` column with FTS5 trigger exclusion is the mechanism that makes current-state semantics real.

### D: Vector embeddings for deduplication

Use embedding similarity to detect and merge near-duplicates mechanically.

**Why rejected**: Adds an external dependency (embedding model), significant complexity, and latency. The duplication problem is better solved by making identity/facts current-state (structural fix) than by detecting duplicates after the fact (symptomatic fix). Embeddings might be useful later for recall quality, but they don't solve the lifecycle problem.

---

## Migration Path

1. **Schema migration**: Add `type` and `archived_at` columns to `memories`. Default existing rows to `type='episodic'`.
2. **Classify identity nodes**: Any memory pointed to by `identity_nodes` gets `type='identity'`.
3. **Classify obvious facts**: Memories with `[SUPERSEDED]` prefix get `type='fact'`, `archived_at=created_at`.
4. **FTS5 rebuild**: Recreate `memories_fts` with trigger that excludes `archived_at IS NOT NULL`.
5. **Update dream tools**: `create_memory` accepts `type` parameter. `evolveNode` uses archive semantics. `supersede_memory` uses archive semantics.
6. **Update dream prompt**: Phase 1 produces typed outputs. Simple classification heuristic in prompt.
7. **Remove `raw_events_fts` consolidation cleanup**: After dreaming, delete FTS5 entries for consolidated events.

Steps 1-4 can be done in one migration. Steps 5-7 are the sprint work.

---

## References

- ADR-001: Neuromorphic Memory Behaviors (salience, pattern separation, substance filter — all still apply per-type)
- ADR-002: Working Self Critique (two-phase dreaming, homunculus fix — Phase 2 now explicitly produces `type='identity'`)
- Conway's Self-Memory System: episodic ↔ working self distinction maps to episodic ↔ identity types
- Tulving (1972): Episodic vs semantic memory distinction. Our episodic/atomic split follows this taxonomy.
- Damasio's somatic marker hypothesis: affective memories as the substrate for decision-making and identity. `markSignificance` becomes affect-typed memory creation.
