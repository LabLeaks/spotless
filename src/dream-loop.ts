/**
 * Background dream loop — adaptive scheduling based on consolidation pressure.
 *
 * Replaces fixed setInterval with setTimeout-after-completion.
 * After each dream pass, reads pressure from DreamResult and schedules
 * the next pass accordingly. Per-agent state tracks timeouts and pending
 * escalations so no triggers are dropped.
 */

import { runDreamPass } from "./dreamer.ts";
import { getIntervalForPressure } from "./consolidation.ts";
import type { DreamResult } from "./types.ts";

export interface DreamLoopConfig {
  model?: string;
  maxRawEvents?: number;
}

export interface DreamLoop {
  start(getAgentNames: () => string[]): void;
  stop(): void;
  triggerNow(agentName?: string): Promise<DreamResult[]>;
  escalate(agentName: string): void;
}

interface AgentState {
  timeout: ReturnType<typeof setTimeout> | null;
  pendingEscalate: boolean;
}

export function createDreamLoop(config?: DreamLoopConfig): DreamLoop {
  const model = config?.model ?? "haiku";
  const maxRawEvents = config?.maxRawEvents ?? 50;

  let getAgentNamesFn: (() => string[]) | null = null;
  let running = false;
  const dreaming = new Set<string>();
  const agentStates = new Map<string, AgentState>();

  function getOrCreateState(agentName: string): AgentState {
    let state = agentStates.get(agentName);
    if (!state) {
      state = { timeout: null, pendingEscalate: false };
      agentStates.set(agentName, state);
    }
    return state;
  }

  async function dreamAgent(agentName: string): Promise<DreamResult> {
    if (dreaming.has(agentName)) {
      // Mark escalation pending — will be picked up after current dream finishes
      const state = getOrCreateState(agentName);
      state.pendingEscalate = true;
      return {
        operationsRequested: 0,
        operationsExecuted: 0,
        memoriesCreated: 0,
        memoriesMerged: 0,
        memoriesPruned: 0,
        memoriesSuperseded: 0,
        associationsCreated: 0,
        reflectionOps: 0,
        errors: ["Already dreaming"],
        durationMs: 0,
        groupsConsolidated: 0,
        pressure: 0,
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
          `${result.reflectionOps} reflection, ` +
          `${result.groupsConsolidated} groups consolidated ` +
          `(${result.durationMs}ms, pressure ${(result.pressure * 100).toFixed(0)}%)`,
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

  function scheduleAgent(agentName: string, intervalMs: number): void {
    if (!running) return;
    const state = getOrCreateState(agentName);

    // Clear any existing timeout
    if (state.timeout) {
      clearTimeout(state.timeout);
      state.timeout = null;
    }

    const label = intervalMs === 0 ? "immediate" :
      intervalMs < 60000 ? `${intervalMs / 1000}s` :
      `${intervalMs / 60000}min`;
    console.log(`[dream] ${agentName}: next pass in ${label}`);

    const run = () => {
      state.timeout = null;
      dreamAgent(agentName).then((result) => {
        if (!running) return;

        // Check for pending escalation
        const s = getOrCreateState(agentName);
        if (s.pendingEscalate) {
          s.pendingEscalate = false;
          scheduleAgent(agentName, 0);
        } else {
          const nextInterval = getIntervalForPressure(result.pressure);
          scheduleAgent(agentName, nextInterval);
        }
      }).catch((err) => {
        console.error(`[dream] ${agentName} error:`, err);
        if (running) {
          // On error, schedule a relaxed retry
          scheduleAgent(agentName, getIntervalForPressure(0));
        }
      });
    };

    if (intervalMs === 0) {
      // Immediate — use setImmediate-like behavior to avoid stack buildup
      state.timeout = setTimeout(run, 0);
    } else {
      state.timeout = setTimeout(run, intervalMs);
    }
  }

  return {
    start(getAgentNames: () => string[]) {
      if (running) return;
      running = true;
      getAgentNamesFn = getAgentNames;

      console.log("[dream] Background dreaming started (adaptive scheduling)");

      // Initial sweep: schedule all known agents with relaxed interval
      const agents = getAgentNames();
      for (const name of agents) {
        scheduleAgent(name, getIntervalForPressure(0));
      }
    },

    stop() {
      running = false;
      for (const [, state] of agentStates) {
        if (state.timeout) {
          clearTimeout(state.timeout);
          state.timeout = null;
        }
        state.pendingEscalate = false;
      }
      agentStates.clear();
      console.log("[dream] Background dreaming stopped");
    },

    escalate(agentName: string): void {
      if (!running) return;

      if (dreaming.has(agentName)) {
        // Agent is currently dreaming — queue follow-up
        const state = getOrCreateState(agentName);
        state.pendingEscalate = true;
        console.log(`[dream] ${agentName}: escalation queued (currently dreaming)`);
      } else {
        // Agent is idle — trigger immediately (cancels any scheduled timeout)
        console.log(`[dream] ${agentName}: escalation — triggering immediate dream`);
        scheduleAgent(agentName, 0);
      }
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
