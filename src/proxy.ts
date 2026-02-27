/**
 * HTTP reverse proxy: receives requests from Claude Code,
 * forwards to Anthropic API, streams SSE responses back.
 *
 * Sprint 5: hippocampus integration. On human turns, injects memory suffix
 * (Tier 2 memories) and starts async hippocampus for next turn.
 */

import type { Database } from "bun:sqlite";
import { classifyRequest } from "./classifier.ts";
import {
  StreamTap,
  archiveAssistantResponse,
  archiveUserMessage,
  archiveSessionBoundary,
} from "./archiver.ts";
import {
  appendAssistantToChain,
  appendToolResultToChain,
  isNewConversation,
  nextMessageGroup,
  resetForHumanTurn,
  resetState,
} from "./state.ts";
import { parseAgentFromUrl, stripAgentPrefix, getAgentDbPath } from "./agent.ts";
import { openDb, initSchema, getMaxMessageGroup } from "./db.ts";
import { buildEideticTrace } from "./eidetic.ts";
import { buildMemorySuffix, injectMemorySuffix } from "./memory-suffix.ts";
import { runHippocampus } from "./hippocampus.ts";
import { touchMemories, logRetrieval } from "./recall.ts";
import type { ApiRequest, ContentBlock, Message, ProxyState, SystemBlock } from "./types.ts";
import { createProxyState } from "./state.ts";
import { handleDashboardRequest } from "./dashboard.ts";

const ANTHROPIC_API_URL = "https://api.anthropic.com";

interface ProxyConfig {
  port: number;
}

export interface AgentContext {
  db: Database;
  state: ProxyState;
}

export interface ProxyStats {
  startedAt: number;
  totalRequests: number;
  agentRequests: Map<string, number>;
}

export interface ProxyInstance {
  server: ReturnType<typeof Bun.serve>;
  stop: () => void;
  getAgentNames: () => string[];
  getStats: () => ProxyStats;
  getAgentContexts: () => Map<string, AgentContext>;
  onEideticTrimmed: ((agentName: string) => void) | null;
}

export function startProxy(config: ProxyConfig): ProxyInstance {
  const agents = new Map<string, AgentContext>();
  const stats: ProxyStats = {
    startedAt: Date.now(),
    totalRequests: 0,
    agentRequests: new Map(),
  };
  let onEideticTrimmedFn: ((agentName: string) => void) | null = null;

  function getOrInitAgent(agentName: string): AgentContext {
    const existing = agents.get(agentName);
    if (existing) return existing;

    const dbPath = getAgentDbPath(agentName);
    console.log(`[spotless] Agent "${agentName}" → ${dbPath}`);
    const db = openDb(dbPath);
    initSchema(db);

    const state = createProxyState(getMaxMessageGroup(db));
    state.agentName = agentName;

    const ctx: AgentContext = { db, state };
    agents.set(agentName, ctx);
    return ctx;
  }

  const server = Bun.serve({
    port: config.port,

    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      stats.totalRequests++;

      // Dashboard routes — checked before agent routes
      if (url.pathname.startsWith("/_dashboard")) {
        const dashResp = handleDashboardRequest(url, agents, stats);
        if (dashResp) return dashResp;
      }

      // Extract agent name from URL (if present)
      const agentName = parseAgentFromUrl(url.pathname);

      // Build target URL — strip /agent/<name> prefix before forwarding to Anthropic
      const forwardPath = agentName ? stripAgentPrefix(url.pathname) : url.pathname;
      const targetUrl = `${ANTHROPIC_API_URL}${forwardPath}${url.search}`;

      // Non-messages endpoints: pure pass-through
      if (!forwardPath.endsWith("/v1/messages")) {
        return forwardSimple(req, targetUrl);
      }

      // Only POST /v1/messages gets the full treatment
      if (req.method !== "POST") {
        return forwardSimple(req, targetUrl);
      }

      // No agent prefix → pure pass-through (no archival, no eidetic trace)
      if (!agentName) {
        return forwardSimple(req, targetUrl);
      }

      const rawBody = await req.text(); // Read body before JSON parse so fallback can use it
      try {
        const body = JSON.parse(rawBody) as ApiRequest;
        const { db, state } = getOrInitAgent(agentName);
        stats.agentRequests.set(agentName, (stats.agentRequests.get(agentName) ?? 0) + 1);

        // Classify the request
        const classification = classifyRequest(body, state.lastStopReason);

        // Reset state on new conversation + archive session boundary
        if (body.messages && isNewConversation(body.messages)) {
          archiveSessionBoundary(db, nextMessageGroup(state));
          resetState(state);
          state.currentMessageGroup = getMaxMessageGroup(db);
        }

        // Archive incoming content (sync, before any processing)
        if (classification !== "subagent") {
          const requestMsgGroup = nextMessageGroup(state);

          if (classification === "human_turn") {
            const lastMsg = body.messages[body.messages.length - 1];

            // Build eidetic prefix BEFORE archiving current message —
            // otherwise the trace includes the current message and it appears twice.
            const { messages: eideticPrefix, trimmedCount } = buildEideticTrace(db, undefined, agentName);

            if (lastMsg) {
              archiveUserMessage(db, lastMsg, requestMsgGroup, false);
            }

            // Fire dream if eidetic budget trimmed messages (knowledge falling off prefix)
            if (trimmedCount > 0 && onEideticTrimmedFn) {
              console.log(`[spotless] [${agentName}] Eidetic trim: ${trimmedCount} messages dropped, requesting dream`);
              onEideticTrimmedFn(agentName);
            }

            // Inject memory suffix from previous hippocampus result
            let memorySuffix = buildMemorySuffix(db, state.lastHippocampusResult);

            // Always inject agent identity — even on cold start with no memories
            const identityTag = `<your identity>\nYour name is "${agentName}".\n</your identity>\n\n`;
            memorySuffix = identityTag + memorySuffix;

            const augmentedMsg = lastMsg
              ? injectMemorySuffix(lastMsg, memorySuffix)
              : lastMsg;

            const rewrittenMessages: Message[] = [...eideticPrefix];
            if (augmentedMsg) rewrittenMessages.push(augmentedMsg);
            resetForHumanTurn(state, rewrittenMessages);

            // Cache system prompt for hippocampus
            state.lastSystemPrompt = extractSystemText(body.system);

            // Start hippocampus ASYNC for next turn
            const userText = lastMsg ? extractUserText(lastMsg) : "";
            if (userText) {
              // Abandon any in-flight hippocampus (rapid turn protection)
              state.hippocampusRunning = null;
              const thisGeneration = ++state.hippoGeneration;

              const hippoStart = Date.now();
              const hippoCueText = userText.slice(0, 200);
              state.hippocampusRunning = runHippocampus({
                db,
                userMessage: userText,
                systemPrompt: state.lastSystemPrompt ?? undefined,
              })
                .then(result => {
                  // Discard stale result if a newer hippocampus run started
                  if (state.hippoGeneration !== thisGeneration) return result;

                  const durationMs = Date.now() - hippoStart;
                  state.lastHippocampusResult = result.memoryIds;
                  state.hippocampusRunning = null;
                  if (result.memoryIds.length > 0) {
                    touchMemories(db, result.memoryIds);
                    logRetrieval(db, result.memoryIds);
                  }
                  // Persist hippocampus run for dashboard diagnostics
                  try {
                    db.run(
                      `INSERT INTO hippocampus_runs
                        (timestamp, duration_ms, memory_ids, memory_count, cue_text)
                       VALUES (?, ?, ?, ?, ?)`,
                      [
                        Date.now(),
                        durationMs,
                        JSON.stringify(result.memoryIds),
                        result.memoryIds.length,
                        hippoCueText,
                      ],
                    );
                  } catch {
                    // Non-fatal — diagnostics should never break the proxy
                  }
                  console.log(
                    `[spotless] [${agentName}] Hippocampus: ${durationMs}ms, ${result.memoryIds.length} memories`
                  );
                  return result;
                })
                .catch(err => {
                  console.error(`[spotless] [${agentName}] Hippocampus error:`, err);
                  if (state.hippoGeneration === thisGeneration) {
                    state.hippocampusRunning = null;
                  }
                  return { memoryIds: [] };
                });
            }

            if (memorySuffix) {
              console.log(`[spotless] [${agentName}] Memory suffix injected`);
            }
          } else if (classification === "tool_loop") {
            const lastMsg = body.messages[body.messages.length - 1];
            if (lastMsg) {
              archiveUserMessage(db, lastMsg, requestMsgGroup, false);
              appendToolResultToChain(state, lastMsg);
            }
          }
        } else {
          // Archive all subagent request content
          const requestMsgGroup = nextMessageGroup(state);
          for (const msg of body.messages) {
            archiveUserMessage(db, msg, requestMsgGroup, true);
          }
        }

        // Build the request to forward
        const forwardBody = { ...body, stream: true };

        // Log eidetic trace size for diagnostics
        if (classification === "human_turn" && state.cachedBase) {
          console.log(`[spotless] [${agentName}] Eidetic trace: ${state.cachedBase.length} messages`);
        }


        // Use rewritten messages for main session, original for subagents
        if (classification !== "subagent" && state.cachedBase) {
          if (classification === "human_turn") {
            forwardBody.messages = state.cachedBase;
          } else if (classification === "tool_loop") {
            forwardBody.messages = [...state.cachedBase, ...state.toolLoopChain];
          }

          // Strip cache_control from system and messages — CC's caching strategy
          // doesn't apply to our rewritten messages and exceeds the 4-block limit.
          stripCacheControl(forwardBody);
        }

        return await forwardStreaming(
          forwardBody,
          targetUrl,
          req.headers,
          db,
          state,
          classification === "subagent",
        );
      } catch (err) {
        console.error("[spotless] Error processing request:", err);
        // Fallback: forward original request unchanged (reconstruct with saved body)
        const fallbackReq = new Request(req.url, {
          method: req.method,
          headers: req.headers,
          body: rawBody,
        });
        return forwardSimple(fallbackReq, targetUrl);
      }
    },
  });

  console.log(`[spotless] Proxy listening on http://localhost:${config.port}`);

  const instance: ProxyInstance = {
    server,
    stop() {
      server.stop(true);
      for (const { db } of agents.values()) db.close();
      agents.clear();
      console.log("[spotless] Proxy stopped");
    },
    getAgentNames() {
      return Array.from(agents.keys());
    },
    getStats() {
      return stats;
    },
    getAgentContexts() {
      return agents;
    },
    get onEideticTrimmed() {
      return onEideticTrimmedFn;
    },
    set onEideticTrimmed(fn: ((agentName: string) => void) | null) {
      onEideticTrimmedFn = fn;
    },
  };

  return instance;
}

/**
 * Simple pass-through for non-messages endpoints or non-agent requests.
 * Forwards CC's headers (including auth) unchanged.
 */
async function forwardSimple(
  req: Request,
  targetUrl: string,
): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.delete("host");
  // Force uncompressed — proxy can't transparently pass gzip between CC and Anthropic
  headers.set("accept-encoding", "identity");

  const resp = await fetch(targetUrl, {
    method: req.method,
    headers,
    body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
  });

  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
  });
}

/**
 * Forward a streaming request to Anthropic and pipe SSE back to Claude Code
 * while tapping the stream to extract content for archival.
 */
async function forwardStreaming(
  body: ApiRequest,
  targetUrl: string,
  incomingHeaders: Headers,
  db: Database,
  state: ProxyState,
  isSubagent: boolean,
): Promise<Response> {
  // Forward CC's headers — CC handles its own auth
  const headers = new Headers(incomingHeaders);
  headers.set("content-type", "application/json");
  headers.delete("host");
  headers.delete("content-length");
  // Force uncompressed responses so we can tap the SSE stream as plaintext.
  // Deleting accept-encoding isn't enough — Bun's fetch may re-add gzip.
  headers.set("accept-encoding", "identity");

  const resp = await fetch(targetUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok || !resp.body) {
    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: resp.headers,
    });
  }

  const tap = new StreamTap();
  const responseMsgGroup = nextMessageGroup(state);

  // Create a TransformStream that taps each SSE event as it passes through
  const decoder = new TextDecoder();
  let partial = ""; // Buffer for lines split across TCP chunks
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      // Pass through immediately — no buffering
      controller.enqueue(chunk);

      // Parse SSE events from the chunk for tapping
      try {
        const text = partial + decoder.decode(chunk, { stream: true });
        const lines = text.split("\n");
        // Last element may be incomplete — buffer it for next chunk
        partial = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("data: ") && line !== "data: [DONE]") {
            try {
              const data = JSON.parse(line.slice(6));
              tap.processSSEEvent(data);
            } catch {
              // Individual line parse error — skip this event
            }
          }
        }
      } catch {
        // Parsing errors in the tap are non-fatal — data still streams through
      }
    },

    flush() {
      // Process any remaining buffered partial line
      if (partial) {
        try {
          if (partial.startsWith("data: ") && partial !== "data: [DONE]") {
            const data = JSON.parse(partial.slice(6));
            tap.processSSEEvent(data);
          }
        } catch { /* non-fatal */ }
        partial = "";
      }

      // Stream complete — archive the captured response
      const blocks = tap.getBlocks();
      if (blocks.length > 0) {
        archiveAssistantResponse(db, blocks, responseMsgGroup, isSubagent);
      }

      // Update proxy state
      if (tap.stopReason) {
        state.lastStopReason = tap.stopReason;
      }

      // Build assistant message for tool loop chain
      // Thinking blocks included with signature so Claude retains its reasoning
      if (!isSubagent && tap.getBlocks().length > 0) {
        const contentBlocks: ContentBlock[] = [];
        for (const b of tap.getBlocks()) {
          if (b.type === "text") {
            contentBlocks.push({ type: "text", text: b.content });
          } else if (b.type === "tool_use") {
            contentBlocks.push({
              type: "tool_use",
              id: (b.metadata?.tool_id as string) ?? "",
              name: (b.metadata?.tool_name as string) ?? "",
              input: tryParseJson(b.content),
            });
          } else if (b.type === "thinking" && b.signature) {
            contentBlocks.push({
              type: "thinking",
              thinking: b.content,
              signature: b.signature,
            } as ContentBlock);
          }
          // Thinking without signature is dropped — can't replay without it
        }
        if (contentBlocks.length > 0) {
          const assistantMsg: Message = { role: "assistant", content: contentBlocks };
          appendAssistantToChain(state, assistantMsg);
        }
      }
    },
  });

  const tappedStream = resp.body.pipeThrough(transform);

  return new Response(tappedStream, {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
  });
}

/**
 * Strip all cache_control markers from the request body.
 *
 * CC adds cache_control to system blocks and message content blocks for prompt
 * caching. Since we rewrite messages with the eidetic trace, CC's caching
 * breakpoints don't apply. The Anthropic API limits cache_control to 4 blocks
 * total — CC's system prompt alone can use 3-4, so any additional markers in
 * messages push us over the limit.
 */
function stripCacheControl(body: ApiRequest): void {
  // Strip from system blocks
  if (Array.isArray(body.system)) {
    for (const block of body.system) {
      if ("cache_control" in block) {
        delete (block as unknown as Record<string, unknown>).cache_control;
      }
    }
  }

  // Strip from message content blocks
  for (const msg of body.messages) {
    if (typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if ("cache_control" in block) {
        delete (block as unknown as Record<string, unknown>).cache_control;
      }
    }
  }

  // Strip from tool definitions
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (tool && typeof tool === "object" && "cache_control" in tool) {
        delete (tool as unknown as Record<string, unknown>).cache_control;
      }
    }
  }
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/**
 * Extract text from the system prompt (string or SystemBlock[] format).
 */
export function extractSystemText(system: string | SystemBlock[] | undefined): string | null {
  if (!system) return null;
  if (typeof system === "string") return system;
  return system
    .filter((b): b is SystemBlock => b.type === "text")
    .map(b => b.text)
    .join("\n");
}

/**
 * Extract text content from a user message (string or ContentBlock[] format).
 */
export function extractUserText(msg: Message): string {
  if (typeof msg.content === "string") return msg.content;
  return msg.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map(b => b.text)
    .join("\n");
}
