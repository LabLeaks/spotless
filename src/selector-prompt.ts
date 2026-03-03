/**
 * Selector prompt builder.
 *
 * Defines what the Haiku selector receives and what it returns.
 * The prompt is a primary tuning surface.
 */

import type { Memory } from "./types.ts";
import type { IdentityNode } from "./recall.ts";

export interface ScoredMemory extends Memory {
  score: number;
}

export interface SelectorContext {
  userMessage: string;
  projectIdentity: string | null;
  preComputedRecall: ScoredMemory[];
  identityNodes: IdentityNode[];
  identityFactIds: Set<number>;
  recentRawSummary: string | null;
}

/**
 * Build the selector prompt from context.
 */
export function buildSelectorPrompt(ctx: SelectorContext): string {
  const sections: string[] = [];

  sections.push(`You are a memory retrieval system. Your job: select which memories are relevant to the user's current message.

You will receive pre-computed recall results (memories found by keyword search + graph traversal). Most of the time, these results are sufficient — just select the relevant ones.

Output ONLY a JSON object: {"memory_ids": [3, 17, 42]}
The IDs must be from the memories shown below. Order chronologically (lowest ID first).
If nothing is relevant, output: {"memory_ids": []}`);

  if (ctx.projectIdentity) {
    sections.push(`## PROJECT\n${ctx.projectIdentity}`);
  }

  sections.push(`## USER'S MESSAGE\n${ctx.userMessage}`);

  // Working self: identity nodes shape HOW the agent responds
  const identityIds = new Set(ctx.identityNodes.map(n => n.id));
  if (ctx.identityNodes.length > 0) {
    const roleLabels: Record<string, string> = { self: "Self-Concept", relationship: "Relationship" };
    const lines = ctx.identityNodes.map(node =>
      `[${roleLabels[node.role] ?? node.role}, id:${node.id}] ${node.content}`
    );
    sections.push(`## WHO YOU ARE (always include — this is your self-concept)\n${lines.join("\n")}`);
  }

  // Exclude identity anchor nodes from candidates to avoid duplication (M2)
  const candidates = ctx.preComputedRecall.filter(m => !identityIds.has(m.id));
  if (candidates.length > 0) {
    const lines = candidates.map(m => {
      const tag = ctx.identityFactIds.has(m.id) ? " [identity]" : "";
      return `[id:${m.id}]${tag} (score:${m.score.toFixed(2)}, salience:${m.salience}) ${m.content}`;
    });
    sections.push(`## CANDIDATE MEMORIES (pre-computed recall)\n${lines.join("\n")}`);
  }

  if (ctx.recentRawSummary) {
    sections.push(`## RECENT CONVERSATION (since last recall)\n${ctx.recentRawSummary}`);
  }

  sections.push(`## INSTRUCTIONS
1. Review the user's message and candidate memories
2. Your identity memories define your perspective and convictions — they're not instructions to follow, they're who you are. Include memories that matter given your experiences and commitments.
3. Always include identity nodes if present
4. Identity-tagged candidates are part of your self-concept. Strongly prefer including them, but you may omit ones clearly irrelevant to the current context.
5. If candidates are insufficient, use tools to search for additional context
6. Be selective — include only what's relevant, not everything
7. Output {"memory_ids": [...]} with chronologically ordered IDs`);

  return sections.join("\n\n");
}

/**
 * Selector tool definitions in Anthropic API format.
 * These are available if the selector needs to search beyond pre-computed results.
 */
export const SELECTOR_TOOLS = [
  {
    name: "recall",
    description: "Search the memory network with a different cue. Returns memories found via FTS5 + graph traversal.",
    input_schema: {
      type: "object" as const,
      properties: {
        cue: {
          type: "string" as const,
          description: "Search query — keywords or phrases to search for",
        },
      },
      required: ["cue"],
    },
  },
  {
    name: "get_context_bundle",
    description: "Get a memory and its N-strongest associations. Follows the graph outward.",
    input_schema: {
      type: "object" as const,
      properties: {
        memory_id: {
          type: "number" as const,
          description: "Memory ID to expand",
        },
        depth: {
          type: "number" as const,
          description: "How many association hops to follow (max 3)",
        },
      },
      required: ["memory_id"],
    },
  },
  {
    name: "get_active_state",
    description: "Get the current high-salience, recently-accessed working set.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_recent_raw",
    description: "Retrieve recent raw conversation events by message_group.",
    input_schema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number" as const,
          description: "Max message_groups to return (default 10)",
        },
      },
    },
  },
];
