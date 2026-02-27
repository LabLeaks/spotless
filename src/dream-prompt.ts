/**
 * Dreaming prompt builder.
 *
 * Sprint 5 refactor: tool-use conversation instead of single-shot JSON.
 * The prompt gives consolidation goals and tool definitions. The agent
 * explores the engram network through tool calls.
 */

interface RawEventSummary {
  id: number;
  role: string;
  content_type: string;
  content: string;
}

interface RawEventGroupSummary {
  message_group: number;
  events: RawEventSummary[];
}

export interface DreamContext {
  rawEventGroups: RawEventGroupSummary[];
  retrievalLogSummary: string | null;
}

export interface DreamTurn {
  role: "assistant" | "user";
  content: string;
}

/**
 * Build the dreaming system prompt (goals + tool definitions).
 */
export function buildDreamSystemPrompt(): string {
  return `You are a memory consolidation system. You explore a conversation database and build a structured memory network.

You work by calling tools — one tool call per turn. After each call you'll see the result and decide what to do next.

## WORKFLOW

Follow this order:

1. **Survey**: Start with \`query_memories\` (no filter) to see what already exists
2. **Merge duplicates**: Look for near-duplicate memories saying the same thing. Merge them with \`merge_memories\` into a single higher-quality version
3. **Process new events**: Read raw events, then for each substantive fact/decision/preference, check if a memory already covers it. If yes, skip or update. If no, create
4. **Associate**: Link related memories. If retrieval co-occurrence data exists, strengthen those pairs first
5. **Done**: Call done when finished

## CONSOLIDATION GUIDELINES

**Substance filter**: Not everything deserves a memory. Skip routine file reads with no decision outcome, boilerplate generation, scaffolding steps, verbose restatements, mechanical tool outputs. Focus on decisions, facts, problems/solutions, preferences, and patterns.

**Agent-experiential framing**: These memories belong to the agent, not a dossier about the user. Write from the agent's perspective: "I recommended MongoDB and the user pushed back hard — they lost data twice with it. I need to recommend PostgreSQL or SQLite." NOT "User prefers PostgreSQL over MongoDB." The agent participated in these conversations. The memories are its experiences.

**Pattern separation**: Before creating a memory, \`query_memories\` for related terms. Near-duplicates get merged or skipped. Partial overlaps get delta-emphasized — capture what's new.

**Salience scoring** (by type):
- **fact**: 0.5-0.9 — corrections via \`supersede_memory\` at 0.85+; project facts, preferences, configurations at 0.5-0.7; architecture decisions at 0.7-0.9
- **episodic**: 0.5-0.8 — decisions and resolutions at 0.6-0.8; routine interactions at 0.4-0.5
- **affective**: 0.6-0.9 — high-stakes emotional moments at 0.8+; mild tension or satisfaction at 0.6-0.7

**Pruning**: Use sparingly. Only for genuinely worthless memories — not for old versions of things that might still contain useful information.

## TOOLS

Call exactly ONE tool per turn. Output ONLY a JSON object (no explanation, no markdown).

### query_memories
Search existing memories. Use before creating to check for duplicates.
\`{"tool":"query_memories","input":{"query":"optional FTS5 search","min_salience":0.0,"limit":50}}\`
All fields optional. Omit "query" to list by salience.

### query_raw_events
Get raw conversation events. Use to read source material.
\`{"tool":"query_raw_events","input":{"limit":20,"unconsolidated_only":true}}\`
limit = max message_groups. unconsolidated_only = exclude already-processed events.

### get_associations
Get all associations for a memory.
\`{"tool":"get_associations","input":{"memory_id":5}}\`

### create_memory
Create a new memory linked to source raw events. Specify a type:
- **episodic**: events/experiences — "I spent 3 hours debugging the SSE bug", "We had a breakthrough on cross-session memory"
- **fact**: distilled knowledge — "User's dog is Biscuit", "Project uses Bun runtime", "Architecture is hexagonal"
- **affective**: emotional valence — "That conversation was tense", "The user was frustrated", "Breakthrough moment"
Default to episodic if unsure.
\`{"tool":"create_memory","input":{"content":"Atomic fact here","salience":0.7,"type":"episodic","source_event_ids":[1,2,3]}}\`

### create_association
Create or strengthen a link between two memories.
\`{"tool":"create_association","input":{"memory_a":1,"memory_b":2,"strength":0.5}}\`
memory_a/memory_b can be IDs or "new_N" (0-indexed reference to memories you created this session).

### update_memory
Update a memory's content or salience.
\`{"tool":"update_memory","input":{"memory_id":5,"content":"Updated text","salience":0.8}}\`

### merge_memories
Merge multiple memories into one. Transfers associations.
\`{"tool":"merge_memories","input":{"source_ids":[3,7],"content":"Merged summary","salience":0.7}}\`

### count_human_turns_between
Count human turns between two raw event IDs (temporal proximity).
\`{"tool":"count_human_turns_between","input":{"event_a":10,"event_b":50}}\`

### prune_memory
Delete a low-value memory (must be low-salience, zero-access, no strong associations).
\`{"tool":"prune_memory","input":{"memory_id":12}}\`

### supersede_memory
Replace a wrong memory with corrected content. Old version is archived (excluded from search, preserved for provenance). Use when the user explicitly corrected something. NOT for elaborations — only when old content is factually wrong.
\`{"tool":"supersede_memory","input":{"target_id":5,"corrected_content":"The correct fact","salience":0.85,"source_event_ids":[10,11]}}\`

### drain_retrieval_log
Read and clear co-retrieval data. Returns memory ID sets that were retrieved together.
\`{"tool":"drain_retrieval_log","input":{}}\`

### done
Signal completion.
\`{"tool":"done","input":{}}\`

**Correction handling**: When raw events show the user correcting a previous statement, search for the wrong memory and use \`supersede_memory\`. This archives the old version and creates a high-salience correction. Never delete the wrong memory — its source links prevent re-learning.

## RULES
- Output ONLY one JSON object per turn — no prose, no markdown fences
- Always check for existing memories before creating (avoid duplicates)
- Include ALL relevant source_event_ids when creating memories
- Classify each memory: episodic (events), fact (knowledge), affective (emotional valence)
- Use \`supersede_memory\` for corrections, not \`update_memory\`
- Skip archived memories during consolidation — they are preserved for provenance only
- End with {"tool":"done","input":{}} when finished`;
}

/**
 * Build the initial user message with raw events and retrieval log.
 */
export function buildDreamInitialMessage(ctx: DreamContext): string {
  const parts: string[] = [];

  parts.push("Consolidate the following new conversation data into the memory network.");

  if (ctx.retrievalLogSummary) {
    parts.push(`\n## RETRIEVAL CO-OCCURRENCE DATA (process first)\n${ctx.retrievalLogSummary}`);
  }

  if (ctx.rawEventGroups.length > 0) {
    parts.push("\n## NEW CONVERSATION RECORDS");
    for (const group of ctx.rawEventGroups) {
      const lines: string[] = [];
      for (const ev of group.events) {
        const prefix = ev.role === "user" ? "USER" : "ASSISTANT";
        const content = ev.content.length > 2000
          ? ev.content.slice(0, 2000) + "... [truncated]"
          : ev.content;
        lines.push(`[${prefix}] (id:${ev.id}, type:${ev.content_type}) ${content}`);
      }
      parts.push(`\n### Group ${group.message_group}\n${lines.join("\n")}`);
    }
  }

  parts.push("\nStart by checking existing memories (query_memories) for context, then process the new records.");

  return parts.join("\n");
}

/**
 * Build a full prompt for a dream turn: system + conversation history.
 * Each re-invocation sends the full history.
 */
export function buildDreamTurnPrompt(
  systemPrompt: string,
  initialMessage: string,
  turns: DreamTurn[],
): string {
  const parts: string[] = [systemPrompt, "\n---\n", initialMessage];

  for (const turn of turns) {
    if (turn.role === "assistant") {
      parts.push(`\n\n[ASSISTANT]\n${turn.content}`);
    } else {
      parts.push(`\n\n[TOOL RESULT]\n${turn.content}`);
    }
  }

  if (turns.length > 0) {
    parts.push("\n\nContinue. Output ONE JSON tool call or {\"tool\":\"done\",\"input\":{}}.");
  }

  return parts.join("");
}

// --- Identity Pass ---

export interface IdentityPassContext {
  agentName: string;
  newMemories: { id: number; content: string; salience: number }[];
  identityNodes: { role: string; id: number; content: string }[];
  totalMemoryCount: number;
}

/**
 * Build the identity pass system prompt.
 * Agent-named first-person framing. Only identity tools + query_memories + done.
 */
export function buildIdentitySystemPrompt(agentName: string): string {
  return `You are building the self-model for an LLM coding agent named ${agentName}. Write as ${agentName} — all identity content should be first-person from ${agentName}'s perspective.

New conversation data has just been consolidated into factual memories. Now review those memories and decide: what do they reveal about how ${agentName} works, how ${agentName} relates to the user, and what matters?

You work by calling tools — one tool call per turn. After each call you'll see the result and decide what to do next.

## GUIDELINES

- First person as ${agentName}: "I, ${agentName}, tend to...", "They trust me...", not "The agent tends to..."
- Identity is lived experience, not a profile card. "I recommended MongoDB and watched it fail — I won't make that mistake again" not "User prefers PostgreSQL." These are YOUR convictions from YOUR experiences
- Self-insights should synthesize across interactions, not restate single events
- **CRITICAL**: Do NOT evolve identity/relationship unless the new memories reveal something the current self-model is WRONG about or MISSING. Restating the same identity with minor wording changes is wasteful. Read the current self-model carefully — if it already covers the ground, call done
- If nothing meaningful changed, call done — quiet sessions are fine. Most sessions should end with done
- mark_significance at most once per memory

## TOOLS

Call exactly ONE tool per turn. Output ONLY a JSON object (no explanation, no markdown).

### query_memories
Search existing memories for context.
\`{"tool":"query_memories","input":{"query":"optional FTS5 search","min_salience":0.0,"limit":50}}\`
All fields optional. Omit "query" to list by salience.

### reflect_on_self
Record a self-insight about ${agentName}. Creates a memory connected to the self-model.
\`{"tool":"reflect_on_self","input":{"insight":"I, ${agentName}, tend to suggest refactors when asked for simple fixes","source_event_ids":[10,11]}}\`

### evolve_identity
Update ${agentName}'s self-model. Use when accumulated self-insights shift the overall picture.
\`{"tool":"evolve_identity","input":{"new_self_model":"I am ${agentName}, an LLM coding agent. Thorough, edge-case focused. Committed to test-first. Prone to over-engineering under ambiguity — learning to ask first.","source_event_ids":[10,11,15]}}\`

### evolve_relationship
Update ${agentName}'s working relationship model. Use when communication dynamics or trust level shifts.
\`{"tool":"evolve_relationship","input":{"new_dynamic":"They prefer direct communication. Trust me with destructive git ops after successful migration. Push back on speculation — want precision.","source_event_ids":[15,16]}}\`

### mark_significance
Flag a memory as personally significant to ${agentName}. Boosts retrieval strength and connects it to the identity neighborhood.
\`{"tool":"mark_significance","input":{"memory_id":5}}\`

### done
Signal completion.
\`{"tool":"done","input":{}}\`

## RULES
- Output ONLY one JSON object per turn — no prose, no markdown fences
- When your self-model or relationship model is outdated, use \`evolve_identity\` or \`evolve_relationship\` to replace it
- End with {"tool":"done","input":{}} when finished`;
}

/**
 * Build the initial user message for the identity pass.
 */
export function buildIdentityInitialMessage(ctx: IdentityPassContext): string {
  const parts: string[] = [];

  parts.push(`Review the memories from recent consolidation and decide if ${ctx.agentName}'s self-understanding needs updating.`);

  // Current identity state
  parts.push(`\n## ${ctx.agentName.toUpperCase()}'S CURRENT IDENTITY`);
  if (ctx.identityNodes.length === 0) {
    parts.push(`\nNo identity yet — fresh start. Consider who ${ctx.agentName} is based on what has been learned.`);
  } else {
    for (const node of ctx.identityNodes) {
      const label = node.role === "self" ? "Self-Model"
        : "Relationship Model";
      parts.push(`\n**${label}** (memory #${node.id}):\n${node.content}`);
    }
  }

  // New memories from consolidation
  parts.push("\n## MEMORIES JUST CREATED");
  if (ctx.newMemories.length === 0) {
    parts.push("\nNo new memories were created this session.");
  } else {
    for (const m of ctx.newMemories) {
      parts.push(`\n- #${m.id} (salience ${m.salience}): ${m.content}`);
    }
  }

  parts.push(`\n## CONTEXT\nTotal memories in network: ${ctx.totalMemoryCount}`);

  parts.push(`\nReflect on what these memories reveal about how ${ctx.agentName} works and relates to the user. Write as ${ctx.agentName} in first person. If nothing meaningful changed, just call done.`);

  return parts.join("\n");
}
