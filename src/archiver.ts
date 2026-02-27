/**
 * Sync archival to SQLite Tier 1.
 *
 * Archives content deltas as they flow through the proxy.
 * Never archives from the full messages array — only live content.
 */

import type { Database } from "bun:sqlite";
import type { ContentBlock, Message, RawEvent } from "./types.ts";

const INSERT_RAW_EVENT = `
  INSERT INTO raw_events (timestamp, message_group, role, content_type, content, is_subagent, metadata)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Archive a single raw event to the database.
 */
function archiveEvent(db: Database, event: Omit<RawEvent, "id">): void {
  db.run(INSERT_RAW_EVENT, [
    event.timestamp,
    event.message_group,
    event.role,
    event.content_type,
    event.content,
    event.is_subagent,
    event.metadata,
  ]);
}

/**
 * Archive a user message (from a human turn request).
 * Extracts the last message from the messages array and archives its content blocks.
 */
export function archiveUserMessage(
  db: Database,
  message: Message,
  messageGroup: number,
  isSubagent: boolean,
): void {
  const now = Date.now();
  const subagentFlag = isSubagent ? 1 : 0;

  if (typeof message.content === "string") {
    archiveEvent(db, {
      timestamp: now,
      message_group: messageGroup,
      role: "user",
      content_type: "text",
      content: message.content,
      is_subagent: subagentFlag,
      metadata: null,
    });
    return;
  }

  for (const block of message.content) {
    switch (block.type) {
      case "text":
        archiveEvent(db, {
          timestamp: now,
          message_group: messageGroup,
          role: "user",
          content_type: "text",
          content: block.text,
          is_subagent: subagentFlag,
          metadata: null,
        });
        break;

      case "tool_result":
        archiveEvent(db, {
          timestamp: now,
          message_group: messageGroup,
          role: "user",
          content_type: "tool_result",
          content: typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content ?? ""),
          is_subagent: subagentFlag,
          metadata: JSON.stringify({ tool_use_id: block.tool_use_id }),
        });
        break;
    }
  }
}

/**
 * Archive a session boundary marker.
 * Inserted when a new conversation is detected so the eidetic trace
 * can show session breaks to the model.
 */
export function archiveSessionBoundary(
  db: Database,
  messageGroup: number,
): void {
  archiveEvent(db, {
    timestamp: Date.now(),
    message_group: messageGroup,
    role: "user",
    content_type: "text",
    content: "<session-boundary />",
    is_subagent: 0,
    metadata: null,
  });
}

/**
 * Archive an assistant response captured from the SSE stream.
 * Takes the accumulated content blocks from the stream tap.
 */
export function archiveAssistantResponse(
  db: Database,
  blocks: CapturedBlock[],
  messageGroup: number,
  isSubagent: boolean,
): void {
  const now = Date.now();
  const subagentFlag = isSubagent ? 1 : 0;

  for (const block of blocks) {
    archiveEvent(db, {
      timestamp: now,
      message_group: messageGroup,
      role: "assistant",
      content_type: block.type,
      content: block.content,
      is_subagent: subagentFlag,
      metadata: block.metadata ? JSON.stringify(block.metadata) : null,
    });
  }
}

/**
 * A content block captured from the SSE stream.
 */
export interface CapturedBlock {
  type: "text" | "tool_use" | "thinking";
  content: string;
  signature?: string;
  metadata?: Record<string, unknown>;
}

/**
 * SSE stream tap: accumulates content blocks from SSE events.
 * Call processSSELine() for each SSE data line, then getBlocks() for the result.
 */
export class StreamTap {
  private blocks: CapturedBlock[] = [];
  private currentBlock: {
    type: "text" | "tool_use" | "thinking";
    chunks: string[];
    id?: string;
    name?: string;
    signature?: string;
  } | null = null;
  stopReason: string | null = null;

  processSSEEvent(data: unknown): void {
    if (!data || typeof data !== "object") return;
    const event = data as Record<string, unknown>;

    switch (event.type) {
      case "content_block_start": {
        const block = event.content_block as Record<string, unknown>;
        this.currentBlock = {
          type: block.type as "text" | "tool_use" | "thinking",
          chunks: [],
          id: block.id as string | undefined,
          name: block.name as string | undefined,
        };
        break;
      }

      case "content_block_delta": {
        if (!this.currentBlock) break;
        const delta = event.delta as Record<string, unknown>;
        if (delta.text) this.currentBlock.chunks.push(delta.text as string);
        if (delta.thinking) this.currentBlock.chunks.push(delta.thinking as string);
        if (delta.partial_json) this.currentBlock.chunks.push(delta.partial_json as string);
        if (delta.signature) this.currentBlock.signature = delta.signature as string;
        break;
      }

      case "content_block_stop": {
        if (!this.currentBlock) break;
        const content = this.currentBlock.chunks.join("");
        const captured: CapturedBlock = {
          type: this.currentBlock.type,
          content,
        };
        if (this.currentBlock.type === "tool_use") {
          captured.metadata = {
            tool_name: this.currentBlock.name,
            tool_id: this.currentBlock.id,
          };
        }
        if (this.currentBlock.signature) {
          captured.signature = this.currentBlock.signature;
        }
        this.blocks.push(captured);
        this.currentBlock = null;
        break;
      }

      case "message_delta": {
        const delta = event.delta as Record<string, unknown>;
        if (delta.stop_reason) {
          this.stopReason = delta.stop_reason as string;
        }
        break;
      }
    }
  }

  getBlocks(): CapturedBlock[] {
    return this.blocks;
  }

  reset(): void {
    this.blocks = [];
    this.currentBlock = null;
    this.stopReason = null;
  }
}
