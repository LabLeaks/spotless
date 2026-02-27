/**
 * Background dream loop — runs REM cycles at configurable intervals.
 *
 * Iterates active agents, runs a dream pass for each with unconsolidated data.
 * Skips agents with no new data. No concurrent dreams per agent.
 */

import { runDreamPass } from "./dreamer.ts";
import type { DreamResult } from "./types.ts";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface DreamLoopConfig {
  intervalMs?: number;
  model?: string;
  maxRawEvents?: number;
}

export interface DreamLoop {
  start(getAgentNames: () => string[]): void;
  stop(): void;
  triggerNow(agentName?: string): Promise<DreamResult[]>;
}

export function createDreamLoop(config?: DreamLoopConfig): DreamLoop {
  const intervalMs = config?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const model = config?.model ?? "haiku";
  const maxRawEvents = config?.maxRawEvents ?? 50;

  let timer: ReturnType<typeof setInterval> | null = null;
  let getAgentNamesFn: (() => string[]) | null = null;
  let running = false;
  const dreaming = new Set<string>(); // agents currently being dreamed

  async function dreamAgent(agentName: string): Promise<DreamResult> {
    if (dreaming.has(agentName)) {
      return {
        operationsRequested: 0,
        operationsExecuted: 0,
        memoriesCreated: 0,
        memoriesMerged: 0,
        memoriesPruned: 0,
        memoriesSuperseded: 0,
        associationsCreated: 0,
        identityOps: 0,
        errors: ["Already dreaming"],
        durationMs: 0,
      };
    }

    dreaming.add(agentName);
    try {
      const result = await runDreamPass({
        agentName,
        model,
        maxRawEvents,
      });

      if (result.operationsExecuted > 0) {
        console.log(
          `[dream] ${agentName}: ${result.memoriesCreated} created, ` +
          `${result.memoriesMerged} merged, ${result.memoriesPruned} pruned, ` +
          `${result.memoriesSuperseded} superseded, ` +
          `${result.associationsCreated} associations, ` +
          `${result.identityOps} identity (${result.durationMs}ms)`,
        );
      }

      if (result.errors.length > 0) {
        console.error(`[dream] ${agentName} errors:`, result.errors);
      }

      return result;
    } finally {
      dreaming.delete(agentName);
    }
  }

  async function runCycle(): Promise<void> {
    if (!getAgentNamesFn) return;

    const agents = getAgentNamesFn();
    for (const agentName of agents) {
      if (!running) break; // stop requested during cycle
      await dreamAgent(agentName);
    }
  }

  return {
    start(getAgentNames: () => string[]) {
      if (running) return;
      running = true;
      getAgentNamesFn = getAgentNames;

      console.log(`[dream] Background dreaming started (interval: ${intervalMs / 1000}s)`);

      timer = setInterval(() => {
        runCycle().catch((err) => {
          console.error("[dream] Cycle error:", err);
        });
      }, intervalMs);
    },

    stop() {
      running = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      console.log("[dream] Background dreaming stopped");
    },

    async triggerNow(agentName?: string): Promise<DreamResult[]> {
      if (agentName) {
        return [await dreamAgent(agentName)];
      }

      if (!getAgentNamesFn) return [];
      const agents = getAgentNamesFn();
      const results: DreamResult[] = [];
      for (const name of agents) {
        results.push(await dreamAgent(name));
      }
      return results;
    },
  };
}
