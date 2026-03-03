/**
 * Background digest loop — adaptive scheduling based on consolidation pressure.
 *
 * Replaces fixed setInterval with setTimeout-after-completion.
 * After each digest pass, reads pressure from DigestResult and schedules
 * the next pass accordingly. Per-agent state tracks timeouts and pending
 * escalations so no triggers are dropped.
 */

import { runDigestPass } from "./digester.ts";
import { getIntervalForPressure } from "./consolidation.ts";
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
  registerAgent(agentName: string): void;
}

interface AgentState {
  timeout: ReturnType<typeof setTimeout> | null;
  pendingEscalate: boolean;
}

export function createDigestLoop(config?: DigestLoopConfig): DigestLoop {
  const model = config?.model ?? "haiku";
  const maxRawEvents = config?.maxRawEvents ?? 50;

  let getAgentNamesFn: (() => string[]) | null = null;
  let running = false;
  const digesting = new Set<string>();
  const agentStates = new Map<string, AgentState>();

  function getOrCreateState(agentName: string): AgentState {
    let state = agentStates.get(agentName);
    if (!state) {
      state = { timeout: null, pendingEscalate: false };
      agentStates.set(agentName, state);
    }
    return state;
  }

  async function digestAgent(agentName: string): Promise<DigestResult> {
    if (digesting.has(agentName)) {
      // Mark escalation pending — will be picked up after current digest finishes
      const state = getOrCreateState(agentName);
      state.pendingEscalate = true;
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
    console.log(`[digest] ${agentName}: next pass in ${label}`);

    const run = () => {
      state.timeout = null;
      digestAgent(agentName).then((result) => {
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
        console.error(`[digest] ${agentName} error:`, err);
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

      console.log("[digest] Background digesting started (adaptive scheduling)");

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
      console.log("[digest] Background digesting stopped");
    },

    escalate(agentName: string): void {
      if (!running) return;

      if (digesting.has(agentName)) {
        // Agent is currently digesting — queue follow-up
        const state = getOrCreateState(agentName);
        state.pendingEscalate = true;
        console.log(`[digest] ${agentName}: escalation queued (currently digesting)`);
      } else {
        // Agent is idle — trigger immediately (cancels any scheduled timeout)
        console.log(`[digest] ${agentName}: escalation — triggering immediate digest`);
        scheduleAgent(agentName, 0);
      }
    },

    registerAgent(agentName: string): void {
      if (!running) return;
      // No-op if agent already scheduled
      if (agentStates.has(agentName)) return;
      console.log(`[digest] Scheduling agent: ${agentName}`);
      scheduleAgent(agentName, getIntervalForPressure(0));
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
