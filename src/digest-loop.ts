/**
 * Background digest loop — escalation-only.
 *
 * Digesting is triggered by:
 * 1. Escalation from the proxy when consolidation pressure is high and history is being trimmed
 * 2. Manual `spotless digest` command (via triggerNow)
 *
 * No periodic polling — digesting only runs when demanded.
 */

import { runDigestPass } from "./digester.ts";
import type { DigestResult } from "./types.ts";

export interface DigestLoopConfig {
  model?: string;
  maxRawEvents?: number;
}

export interface DigestLoop {
  start(getAgentNames: () => string[]): void;
  stop(): void;
  triggerNow(agentName?: string): Promise<DigestResult[]>;
  escalate(agentName: string): void;
}

export function createDigestLoop(config?: DigestLoopConfig): DigestLoop {
  const model = config?.model ?? "haiku";
  const maxRawEvents = config?.maxRawEvents ?? 50;

  let getAgentNamesFn: (() => string[]) | null = null;
  let running = false;
  const digesting = new Set<string>();
  const pendingEscalations = new Set<string>();

  async function digestAgent(agentName: string): Promise<DigestResult> {
    if (digesting.has(agentName)) {
      // Mark escalation pending — will be picked up after current digest finishes
      pendingEscalations.add(agentName);
      return {
        operationsRequested: 0,
        operationsExecuted: 0,
        memoriesCreated: 0,
        memoriesMerged: 0,
        memoriesSuperseded: 0,
        associationsCreated: 0,
        reflectionOps: 0,
        errors: ["Already digesting"],
        durationMs: 0,
        groupsConsolidated: 0,
        pressure: 0,
      };
    }

    digesting.add(agentName);
    try {
      const result = await runDigestPass({
        agentName,
        model,
        maxRawEvents,
      });

      if (result.operationsExecuted > 0) {
        console.log(
          `[digest] ${agentName}: ${result.memoriesCreated} created, ` +
          `${result.memoriesMerged} merged, ` +
          `${result.memoriesSuperseded} superseded, ` +
          `${result.associationsCreated} associations, ` +
          `${result.reflectionOps} reflection, ` +
          `${result.groupsConsolidated} groups consolidated ` +
          `(${result.durationMs}ms, pressure ${(result.pressure * 100).toFixed(0)}%)`,
        );
      }

      if (result.errors.length > 0) {
        console.error(`[digest] ${agentName} errors:`, result.errors);
      }

      return result;
    } finally {
      digesting.delete(agentName);

      // If an escalation came in while digesting, trigger another pass
      if (running && pendingEscalations.has(agentName)) {
        pendingEscalations.delete(agentName);
        console.log(`[digest] ${agentName}: running queued escalation`);
        digestAgent(agentName).catch((err) => {
          console.error(`[digest] ${agentName} queued escalation error:`, err);
        });
      }
    }
  }

  return {
    start(getAgentNames: () => string[]) {
      if (running) return;
      running = true;
      getAgentNamesFn = getAgentNames;
      console.log("[digest] Background digesting enabled (escalation-only)");
    },

    stop() {
      running = false;
      pendingEscalations.clear();
      console.log("[digest] Background digesting stopped");
    },

    escalate(agentName: string): void {
      if (!running) return;

      if (digesting.has(agentName)) {
        pendingEscalations.add(agentName);
        console.log(`[digest] ${agentName}: escalation queued (currently digesting)`);
      } else {
        console.log(`[digest] ${agentName}: escalation — triggering immediate digest`);
        digestAgent(agentName).catch((err) => {
          console.error(`[digest] ${agentName} escalation error:`, err);
        });
      }
    },

    async triggerNow(agentName?: string): Promise<DigestResult[]> {
      if (agentName) {
        return [await digestAgent(agentName)];
      }

      if (!getAgentNamesFn) return [];
      const agents = getAgentNamesFn();
      const results: DigestResult[] = [];
      for (const name of agents) {
        results.push(await digestAgent(name));
      }
      return results;
    },
  };
}
