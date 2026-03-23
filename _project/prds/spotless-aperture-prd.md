# Spotless Aperture — Research Context

## Landscape Survey (March 2026)

Research compiled during Sprint 11 design. Documents the state of the art in LLM context efficiency to inform Spotless's approach and position it relative to existing work.

### Context Compression

**LLMLingua / LLMLingua-2 (Microsoft Research)** — Small language models identify and remove non-essential tokens. 20x compression, 1.5% quality loss. LLMLingua-2 reframes as token classification, 3-6x faster.
- https://github.com/microsoft/LLMLingua

**Morph Compact** — 50-70% compression, 98% verbatim accuracy at 3,300+ tokens/sec. Deletes tokens (not rewriting) so output is diffable and inspectable.
- https://www.morphllm.com/

**RTK (Rust Token Killer)** — CLI proxy that compresses shell command outputs before they reach the LLM. 60-90% reduction. Works with CC, Cursor, Aider.
- https://github.com/rtk-ai/rtk

**Context Mode (MCP Server)** — Routes tool outputs through sandboxed execution. Claims 98% context reduction (315KB → 5.4KB). Uses SQLite + FTS5.
- https://github.com/mksglu/context-mode

### Context Management for Coding Agents

**Claude Code's Three-Layer Compaction** — Microcompaction (save large outputs to disk), auto-compaction (95% capacity trigger), manual /compact. All lossy, unrecoverable.
- https://platform.claude.com/docs/en/build-with-claude/compaction

**Factory AI Anchored Iterative Summarization** — Merges only newly-dropped spans into persistent rolling summary. Scored 3.70 vs Anthropic's 3.44 on factual retention. Best-in-class for detail preservation across compression cycles.
- https://factory.ai/news/compressing-context

**JetBrains "The Complexity Trap" (NeurIPS 2025)** — Observation masking (hiding tool outputs, preserving action/reasoning) matches or beats LLM summarization. 52% cheaper. Hybrid masking + summarization adds 7-11% cost reduction. Challenges assumption that semantic summarization is necessary.
- https://github.com/JetBrains-Research/the-complexity-trap

**Aider Repo Map** — Compact repository map for codebase context. Diff-based edits so model returns changes, not whole files.
- https://aider.chat/docs/faq.html

**Knowledge Graph Context (49x savings)** — Filters relevant code via knowledge graph. 4.6x for httpx, 49.1x for Next.js.
- https://codegraphcontext.vercel.app/

### Memory Systems

**Letta (formerly MemGPT)** — LLM as OS managing its own memory. Three tiers: core (RAM), recall, archival (disk). Agent moves data between tiers. #1 model-agnostic open source on Terminal-Bench. Recent: Context Repositories (git-based memory), Skill Learning.
- https://github.com/letta-ai/letta

**Mem0** — Universal memory layer. Dynamically extracts, consolidates, retrieves. 91% lower p95 latency, 90%+ cost savings. Outperforms OpenAI memory by 26%.
- https://github.com/mem0ai/mem0

**SimpleMem (Jan 2026)** — Three-stage: Semantic Structured Compression, Online Semantic Synthesis, Intent-Aware Retrieval Planning. 26.4% F1 improvement over Mem0 on LoCoMo. 30x token reduction (531 vs 16,910 tokens/query).
- https://github.com/aiming-lab/SimpleMem

**A-MEM (NeurIPS 2025)** — Zettelkasten-inspired. Memories generate own descriptions, form connections, evolve relationships. Outperforms baselines on multi-hop reasoning.
- https://github.com/agiresearch/A-mem

**Cognee** — Knowledge engine, ECL pipeline, two-layer memory (session + permanent), self-improving graph. 70+ companies, $7.5M seed.
- https://github.com/topoteretes/cognee

### Caching

**Anthropic Prompt Caching** — Prefix-matching, 10% cost on hits, 90% cost reduction, 85% latency reduction. 5-min default TTL.
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching

**GPTCache (Zilliz)** — Semantic response caching, 2-10x speedup on hits.
- https://github.com/zilliztech/GPTCache

**Agentic Plan Caching (NeurIPS 2025)** — Caches structured plan templates from completed executions. 50.31% cost reduction, 27.28% latency reduction.
- https://arxiv.org/abs/2506.14852

### Lost in the Middle

**Liu et al. (TACL 2024)** — 30%+ accuracy drop when relevant info is in middle of context. Confirmed across 18 frontier models in 2025. Root cause: RoPE attention decay. Implication: more context is not better. Signal-to-noise ratio matters more than raw token count.
- https://arxiv.org/abs/2307.03172

### Where Spotless Fits

No existing system combines:
1. Full history backing store (total recall — nothing ever lost)
2. Transparent proxy position (agent unaware of composition)
3. Per-turn adaptive fidelity (fractal zoom levels, relevance-driven)
4. Elastic budget (lean by default, flex to 1M when needed)
5. Demand-free retrieval (no agent tools, no explicit memory management)

MemGPT/Letta is closest but makes the agent manage its own memory (token cost + latency + agent capability dependency). Factory's compression is strong but linear (always compress, can't un-compress). JetBrains' observation masking validates the core intuition (tool outputs are low-value in history) but is all-or-nothing.

Spotless's aperture approach is fractal (multiple zoom levels), elastic (context budget adapts per-turn), and invisible (agent doesn't participate in context management). The 1M window becomes a capability, not a liability.
