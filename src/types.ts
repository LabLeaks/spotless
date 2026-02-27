/**
 * Shared type definitions for Spotless proxy.
 */

// --- Request Classification ---

export type RequestClass = "human_turn" | "tool_loop" | "subagent";

// --- Anthropic API types (subset we care about) ---

export interface ContentBlockText {
  type: "text";
  text: string;
}

export interface ContentBlockToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ContentBlockToolResult {
  type: "tool_result";
  tool_use_id: string;
  content?: string | ContentBlock[];
  is_error?: boolean;
}

export interface ContentBlockThinking {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export type ContentBlock =
  | ContentBlockText
  | ContentBlockToolUse
  | ContentBlockToolResult
  | ContentBlockThinking;

export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: string };
}

export interface ApiRequest {
  model: string;
  system?: string | SystemBlock[];
  messages: Message[];
  max_tokens?: number;
  temperature?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  stream?: boolean;
  [key: string]: unknown;
}

// --- SSE types ---

export interface SSEContentBlockStart {
  type: "content_block_start";
  index: number;
  content_block: {
    type: "text" | "tool_use" | "thinking";
    id?: string;
    name?: string;
    text?: string;
    thinking?: string;
  };
}

export interface SSEContentBlockDelta {
  type: "content_block_delta";
  index: number;
  delta: {
    type: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
  };
}

export interface SSEContentBlockStop {
  type: "content_block_stop";
  index: number;
}

export interface SSEMessageDelta {
  type: "message_delta";
  delta: {
    stop_reason: string | null;
  };
  usage?: {
    output_tokens: number;
  };
}

export type SSEEvent =
  | SSEContentBlockStart
  | SSEContentBlockDelta
  | SSEContentBlockStop
  | SSEMessageDelta
  | { type: "message_start"; message: unknown }
  | { type: "message_stop" }
  | { type: "ping" };

// --- Raw Event (Tier 1 row) ---

export interface RawEvent {
  id?: number;
  timestamp: number;
  message_group: number;
  role: "user" | "assistant";
  content_type: "text" | "tool_use" | "tool_result" | "thinking";
  content: string;
  is_subagent: number;
  metadata: string | null; // JSON string
}

// --- Tier 2: Engram Network types ---

export type MemoryType = "episodic" | "fact" | "affective" | "identity";

export interface Memory {
  id: number;
  content: string;
  salience: number;
  created_at: number;
  last_accessed: number;
  access_count: number;
  type: MemoryType;
  archived_at: number | null;
}

export interface Association {
  source_id: number;
  target_id: number;
  strength: number;
  reinforcement_count: number;
  last_reinforced: number;
}

// --- Dream Operations (discriminated union) ---

export interface DreamOpCreateMemory {
  op: "create_memory";
  content: string;
  salience: number;
  source_event_ids: number[];
}

export interface DreamOpCreateAssociation {
  op: "create_association";
  memory_a: number;
  memory_b: number;
  strength: number;
}

export interface DreamOpUpdateMemory {
  op: "update_memory";
  memory_id: number;
  content?: string;
  salience?: number;
}

export interface DreamOpMergeMemories {
  op: "merge_memories";
  source_ids: number[];
  content: string;
  salience: number;
}

export interface DreamOpStrengthenAssociation {
  op: "strengthen_association";
  memory_a: number;
  memory_b: number;
  strength: number;
}

export interface DreamOpPruneMemory {
  op: "prune_memory";
  memory_id: number;
}

export interface DreamOpDone {
  op: "done";
}

export type DreamOperation =
  | DreamOpCreateMemory
  | DreamOpCreateAssociation
  | DreamOpUpdateMemory
  | DreamOpMergeMemories
  | DreamOpStrengthenAssociation
  | DreamOpPruneMemory
  | DreamOpDone;

// --- Dream Result ---

export interface DreamResult {
  operationsRequested: number;
  operationsExecuted: number;
  memoriesCreated: number;
  memoriesMerged: number;
  memoriesPruned: number;
  memoriesSuperseded: number;
  associationsCreated: number;
  identityOps: number;
  errors: string[];
  durationMs: number;
}

// --- Hippocampus Result ---

export interface HippoResult {
  memoryIds: number[];
}

// --- Proxy State ---

export interface ProxyState {
  cachedBase: Message[] | null;
  toolLoopChain: Message[];
  lastStopReason: string | null;
  currentMessageGroup: number;
  agentName: string | null;
  lastHippocampusResult: number[] | null;
  hippocampusRunning: Promise<HippoResult> | null;
  lastSystemPrompt: string | null;
  hippoGeneration: number;
}
