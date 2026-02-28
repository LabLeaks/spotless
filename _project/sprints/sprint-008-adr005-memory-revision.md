# Sprint 8: ADR-005 Memory Architecture Revision

**Status:** Complete
**ADR:** `_project/adrs/ADR-005-memory-architecture-revision.md`

## Summary

Simplified memory type system from 4 types to 2, replaced monolithic identity evolution with composable self-concept facts and materialized cache, added system prompt augmentation, renamed context tags.

## Changes

### Schema (TASK-1)
- `MemoryType = "episodic" | "fact"` — removed `affective` and `identity`
- `DreamResult.identityOps` → `DreamResult.reflectionOps`
- `migrateAdr005()`: table rebuild with new CHECK constraint, reclassifies old identity/affective → episodic
- CHECK constraint: `CHECK(type IN ('episodic','fact'))`

### Dream Tools (TASK-2)
- **Removed**: `evolveIdentity()`, `evolveRelationship()`, `evolveNode()` internal helper
- **Added**: `updateSelfConcept()` — create/supersede self-concept facts with anchor association
- **Added**: `recompileIdentityCache()` — materialize compiled identity from graph neighbors
- **Modified**: `reflectOnSelf()` — added optional `anchor` param (self/relationship)
- Extracted `replaceIdentityCache()` shared helper from old `evolveNode()`

### Dream Prompt + Dreamer (TASK-3)
- Phase 2 renamed: "identity pass" → "reflection pass"
- `buildIdentitySystemPrompt` → `buildReflectionSystemPrompt` (Korsgaard reflective endorsement framing)
- `buildIdentityInitialMessage` → `buildReflectionInitialMessage`
- `IdentityPassContext` → `ReflectionPassContext`
- `IDENTITY_TOOLS` → `REFLECTION_TOOLS`: `query_memories, reflect_on_self, update_self_concept, mark_significance, done`
- `shouldRunIdentityPass(db, ids)` → `shouldRunReflectionPass(ids)` — no more DB param, triggers only on new memories
- After Phase 2 tool loop: auto-recompile identity cache for both anchors
- `VALID_TYPES` reduced to `episodic, fact`

### Proxy (TASK-4)
- **Added**: `augmentSystemPrompt()` — prepends `<spotless-orientation>` to `body.system`
- **Removed**: `<memory-architecture>` tag injection
- `<your memories>` → `<relevant knowledge>` tag in memory suffix

### Eidetic + Hippo (TASK-5)
- Preamble: "Your identity and knowledge are provided in tags on your current message"
- Ack: "I have my identity and memories available through Spotless"
- Hippo prompt: "Self-Concept" label, "this is your self-concept" section header

### Dashboard (TASK-6)
- Removed CSS for `.type-affective` and `.type-identity` badges
- Removed filter dropdown options for affective/identity

## Test Results

- 351 tests passing, 0 failures, 10 skipped (eval tests gated on SPOTLESS_EVAL)
- TypeScript typecheck: clean
- ~25 new tests added (ADR-005 migration, updateSelfConcept, recompileIdentityCache, augmentSystemPrompt)
