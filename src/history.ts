/**
 * History trace builder.
 *
 * Queries Tier 1 (raw_events) and reconstructs recent conversation
 * as a messages array — the "history prefix" in the layered message format.
 */

import type { Database } from "bun:sqlite";
import type { Message, ContentBlock } from "./types.ts";
import { estimateMessageTokens, HISTORY_BUDGET, PRESSURE_BUDGET_CAP } from "./tokens.ts";
import { getConsolidationPressure } from "./consolidation.ts";
import { logWarn } from "./logger.ts";

export interface HistoryResult {
  messages: Message[];
  trimmedCount: number;
  pressure: number;
  unconsolidatedTokens: number;
}

const SESSION_BOUNDARY_MARKER = "<session-boundary />";
const SESSION_DIVIDER = "\n\n--- new session ---\n\n";

export function buildMemoryPreamble(agentName: string | null): string {
  const identity = agentName
    ? `Your name is "${agentName}". `
    : "";
  return `[Spotless Memory System] ${identity}The messages that follow are your conversation history, reconstructed from persistent memory. Your identity and knowledge are provided in tags on your current message.

Messages separated by "--- new session ---" markers occurred in different sessions. When you encounter these:
- Acknowledge context from prior sessions naturally (e.g., "From our previous session, we discussed X — would you like to continue?")
- Don't treat prior session content as part of the current request
- The user's current message is the last one in the sequence`;
}

interface RawEventRow {
  id: number;
  message_group: number;
  role: string;
  content_type: string;
  content: string;
  metadata: string | null;
}

/**
 * Build the history prefix from Tier 1.
 *
 * Queries recent non-subagent raw_events, groups by message_group,
 * reconstructs as Message[] with proper content blocks.
 * Trims oldest turns from front to stay within token budget.
 *
 * Thinking blocks are excluded from output (archived but not replayed).
 * System reminders (CC's <system-reminder> blocks) are excluded — they're
 * session-specific injections, not conversation content.
 * Session boundaries are converted to visible "--- new session ---" dividers.
 */
export function buildHistory(
  db: Database,
  budget: number = HISTORY_BUDGET,
  agentName: string | null = null,
): HistoryResult {
  // Compute consolidation pressure (cheap query, uses idx_raw_consolidated)
  // Cap the pressure denominator so that large context budgets don't suppress digesting.
  // Haiku (the digest model) has a 200K window — pressure must trigger at the old scale.
  let pressure = 0;
  let unconsolidatedTokens = 0;
  try {
    const pressureBudget = Math.min(budget, PRESSURE_BUDGET_CAP);
    const pr = getConsolidationPressure(db, pressureBudget);
    pressure = pr.pressure;
    unconsolidatedTokens = pr.unconsolidatedTokens;
  } catch {
    // Non-fatal — default to 0
  }

  // Query non-subagent, non-thinking events, ordered by id (insertion order)
  const rows = db.query(`
    SELECT id, message_group, role, content_type, content, metadata
    FROM raw_events
    WHERE is_subagent = 0
      AND content_type != 'thinking'
    ORDER BY id ASC
  `).all() as RawEventRow[];

  if (rows.length === 0) return { messages: [], trimmedCount: 0, pressure, unconsolidatedTokens };

  // Group by message_group, tracking which groups contain session boundaries
  const groups = new Map<number, RawEventRow[]>();
  const boundaryGroups = new Set<number>();

  for (const row of rows) {
    if (row.content === SESSION_BOUNDARY_MARKER) {
      boundaryGroups.add(row.message_group);
      continue; // Don't include the marker in content rows
    }
    let group = groups.get(row.message_group);
    if (!group) {
      group = [];
      groups.set(row.message_group, group);
    }
    group.push(row);
  }

  // Reconstruct messages from groups.
  // Check each group against ALL boundary group IDs to detect when we've
  // crossed a session boundary. Boundary groups have no content rows and
  // won't appear in the groups map — we detect them by checking if any
  // boundary group ID falls between the previous and current group.
  const messages: Message[] = [];
  let pendingBoundary = false;
  let lastGroupId = -1;

  for (const [groupId, groupRows] of groups) {
    // Check if any boundary group falls between the last group and this one
    for (const bId of boundaryGroups) {
      if (bId > lastGroupId && bId <= groupId) {
        pendingBoundary = true;
        break;
      }
    }
    lastGroupId = groupId;

    const msg = reconstructMessage(groupRows);
    if (!msg) continue;

    // Inject session divider into the first user message after a boundary,
    // but NOT into tool_result messages — the API rejects text blocks mixed
    // into tool_result responses. Defer to next text-only user message.
    if (pendingBoundary && msg.role === "user" && !hasToolResult(msg)) {
      prependTextToMessage(msg, SESSION_DIVIDER);
      pendingBoundary = false;
    }

    messages.push(msg);
  }

  // Also check for boundaries after the last group (the current session's
  // boundary falls after all archived content). If pending, the proxy will
  // append the current user message — we need to mark it.
  for (const bId of boundaryGroups) {
    if (bId > lastGroupId) {
      pendingBoundary = true;
      break;
    }
  }
  if (pendingBoundary && messages.length > 0) {
    // Append a synthetic end-of-history marker that the current user message
    // will follow. The proxy appends the real message after this array.
    messages.push({
      role: "assistant",
      content: "[End of conversation history — new session starting]",
    });
  }

  // Validate tool_use/tool_result pairing — skip broken pairs.
  const validated = validateToolPairing(messages);

  // Deduplicate consecutive identical user messages (from retried failed requests).
  const deduped = deduplicateConsecutive(validated);

  // Enforce strict user/assistant alternation.
  // Skipped tool_use pairs can leave adjacent user messages — insert synthetic
  // assistant placeholders so old requests read as history, not current asks.
  const alternating = enforceAlternation(deduped);

  if (alternating.length === 0) return { messages: [], trimmedCount: 0, pressure, unconsolidatedTokens };

  // Prepend memory context preamble
  const preambleText = buildMemoryPreamble(agentName);
  const ack = agentName
    ? `Understood. I'm ${agentName}. I have my identity and memories available through Spotless, and conversation history from previous sessions.`
    : "Understood. I have my identity and memories available through Spotless, and conversation history from previous sessions.";
  const preamble: Message[] = [
    { role: "user", content: preambleText },
    { role: "assistant", content: ack },
  ];

  const withPreamble = [...preamble, ...alternating];

  // Trim from front to fit within budget
  const { messages: trimmed, trimmedCount } = trimTobudget(withPreamble, budget);
  return { messages: trimmed, trimmedCount, pressure, unconsolidatedTokens };
}

/**
 * Prepend text to a message's content, handling both string and array formats.
 */
function prependTextToMessage(msg: Message, text: string): void {
  if (typeof msg.content === "string") {
    msg.content = text + msg.content;
  } else {
    // Find the first text block and prepend, or insert a new text block
    const firstText = msg.content.find((b) => b.type === "text");
    if (firstText && "text" in firstText) {
      firstText.text = text + firstText.text;
    } else {
      msg.content.unshift({ type: "text", text });
    }
  }
}

/**
 * Reconstruct a single Message from its raw_event rows.
 * All rows share the same message_group and role.
 */
function reconstructMessage(rows: RawEventRow[]): Message | null {
  if (rows.length === 0) return null;

  const role = rows[0]!.role as "user" | "assistant";

  // Filter out system reminders — they're session-specific, not conversation content
  const contentRows = rows.filter((r) => !isSystemReminder(r.content));
  if (contentRows.length === 0) return null;

  // Single text block → simple string content
  if (contentRows.length === 1 && contentRows[0]!.content_type === "text") {
    return { role, content: contentRows[0]!.content };
  }

  // Multiple blocks → array content
  const blocks: ContentBlock[] = [];
  for (const row of contentRows) {
    const block = rowToContentBlock(row);
    if (block) blocks.push(block);
  }

  if (blocks.length === 0) return null;
  return { role, content: blocks };
}

/**
 * Convert a raw_event row to a ContentBlock.
 */
function rowToContentBlock(row: RawEventRow): ContentBlock | null {
  switch (row.content_type) {
    case "text":
      return { type: "text", text: row.content };

    case "tool_use": {
      const meta = row.metadata ? JSON.parse(row.metadata) : {};
      const parsed = tryParseJson(row.content);
      const input = typeof parsed === "object" && parsed !== null ? parsed : {};
      if (parsed !== input) {
        logWarn(`[spotless] tool_use input not a dict in history: id=${row.id} tool=${meta.tool_name} raw=${JSON.stringify(row.content).slice(0, 200)}`);
      }
      return {
        type: "tool_use",
        id: meta.tool_id ?? "",
        name: meta.tool_name ?? "",
        input,
      };
    }

    case "tool_result": {
      const meta = row.metadata ? JSON.parse(row.metadata) : {};
      return {
        type: "tool_result",
        tool_use_id: meta.tool_use_id ?? "",
        content: row.content,
      };
    }

    default:
      return null;
  }
}

/**
 * Validate tool_use / tool_result pairing across the message sequence.
 *
 * The Anthropic API requires that every assistant tool_use has a matching
 * tool_result in the immediately following user message. Walk the array
 * and SKIP broken pairs (don't truncate the rest) so that valid content
 * after interrupted sessions is preserved.
 */
function validateToolPairing(messages: Message[]): Message[] {
  const result: Message[] = [];
  const seenToolUseIds = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;

    if (msg.role === "assistant" && hasToolUse(msg)) {
      // Assistant has tool_use — next message MUST be user with matching tool_results
      const next = messages[i + 1];
      if (!next || next.role !== "user" || !hasToolResult(next)) {
        // Broken pair — skip this assistant message (and continue scanning)
        continue;
      }

      // Check for duplicate tool_use_ids — the API rejects multiple tool_results
      // for the same tool_use_id (can happen from retried requests or subagent leaks)
      const toolUseIds = getToolUseIds(msg);
      const hasDuplicate = toolUseIds.some(id => seenToolUseIds.has(id));
      if (hasDuplicate) {
        i++; // skip the paired user message too
        continue;
      }
      for (const id of toolUseIds) seenToolUseIds.add(id);

      // Pair looks valid — include both
      result.push(msg);
      result.push(next);
      i++; // skip the user message we just added
    } else if (msg.role === "user" && hasToolResult(msg)) {
      // Orphaned tool_result with no preceding assistant tool_use — skip it.
      // This happens when tool_use was in a different session or was trimmed
      // by budget constraints. The API rejects tool_results without a matching
      // tool_use in the immediately preceding assistant message.
      const prev = result[result.length - 1];
      if (!prev || prev.role !== "assistant" || !hasToolUse(prev)) {
        continue;
      }
      // If the previous result message IS an assistant with tool_use, this was
      // already handled by the branch above — shouldn't reach here, but include
      // for safety.
      result.push(msg);
    } else {
      result.push(msg);
    }
  }

  return result;
}

/**
 * Extract tool_use IDs from an assistant message.
 */
function getToolUseIds(msg: Message): string[] {
  if (typeof msg.content === "string") return [];
  return msg.content
    .filter((b): b is { type: "tool_use"; id: string; name: string; input: unknown } => b.type === "tool_use")
    .map(b => b.id);
}

/**
 * Enforce strict user/assistant alternation. After skipping broken tool_use
 * pairs, adjacent user messages can appear. Insert synthetic assistant
 * placeholders to maintain alternation — this keeps old requests as history
 * rather than making them look like current multi-part requests.
 */
export function enforceAlternation(messages: Message[]): Message[] {
  if (messages.length === 0) return [];

  const result: Message[] = [messages[0]!];

  for (let i = 1; i < messages.length; i++) {
    const msg = messages[i]!;
    const prev = result[result.length - 1]!;

    if (msg.role === prev.role) {
      if (msg.role === "user") {
        // Insert synthetic assistant between consecutive user messages
        result.push({
          role: "assistant",
          content: "[Session interrupted — response not captured]",
        });
      } else {
        // Insert synthetic user between consecutive assistant messages
        result.push({
          role: "user",
          content: "[continued]",
        });
      }
    }

    result.push(msg);
  }

  return result;
}

/**
 * Remove consecutive messages with identical text content (from retried
 * failed requests hitting the proxy multiple times).
 */
function deduplicateConsecutive(messages: Message[]): Message[] {
  if (messages.length === 0) return [];

  const result: Message[] = [messages[0]!];

  for (let i = 1; i < messages.length; i++) {
    const msg = messages[i]!;
    const prev = result[result.length - 1]!;

    if (msg.role === prev.role && textContent(msg) === textContent(prev)) {
      continue; // skip duplicate
    }
    result.push(msg);
  }

  return result;
}

function textContent(msg: Message): string {
  if (typeof msg.content === "string") return msg.content;
  return msg.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function hasToolUse(msg: Message): boolean {
  if (typeof msg.content === "string") return false;
  return msg.content.some((b) => b.type === "tool_use");
}

function hasToolResult(msg: Message): boolean {
  if (typeof msg.content === "string") return false;
  return msg.content.some((b) => b.type === "tool_result");
}

/**
 * Check if content is a CC system reminder (session-specific, not conversation).
 */
function isSystemReminder(content: string): boolean {
  return content.trimStart().startsWith("<system-reminder>");
}

/**
 * Trim messages from the front (oldest) to fit within token budget.
 * Returns trimmed messages and the count of messages dropped.
 */
function trimTobudget(messages: Message[], budget: number): { messages: Message[]; trimmedCount: number } {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }

  // Trim from front until under budget
  let start = 0;
  while (total > budget && start < messages.length - 1) {
    total -= estimateMessageTokens(messages[start]!);
    start++;
  }

  // After trimming, the first remaining message might be an orphaned tool_result
  // (its preceding assistant tool_use was trimmed). Skip past any such orphans.
  while (start < messages.length - 1 && hasToolResult(messages[start]!) &&
         messages[start]!.role === "user") {
    total -= estimateMessageTokens(messages[start]!);
    start++;
  }

  return { messages: messages.slice(start), trimmedCount: start };
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
