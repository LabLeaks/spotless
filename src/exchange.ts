/**
 * Exchange detection, Level 1 heuristic compression, and per-exchange reconstruction.
 *
 * An "exchange" is a human turn + the agent's full response (including tool loops).
 * Bounded by: start = human_turn message_group, end = group before next human_turn.
 *
 * Level 1 compression replaces tool_result content with structural summaries
 * while preserving all user text and assistant reasoning. Rendered as plain text
 * user/assistant pairs (no tool_use/tool_result blocks — the API requires every
 * tool_use to have an adjacent tool_result, making partial structure impossible).
 */

import type { Database } from "bun:sqlite";
import type { Message, ContentBlock } from "./types.ts";
import { estimateTokens } from "./tokens.ts";

// --- Types ---

export interface ExchangeLevel {
  startGroup: number;
  endGroup: number;
  sessionId: number | null;
  level: number;
  content: string; // JSON-encoded [Message, Message] (user + assistant plain text pair)
  tokens: number;
}

interface RawEventRow {
  id: number;
  message_group: number;
  role: string;
  content_type: string;
  content: string;
  metadata: string | null;
}

// --- Level 1 Heuristic Templates ---

interface ToolUseMeta {
  tool_name?: string;
  tool_id?: string;
}

interface ToolResultMeta {
  tool_use_id?: string;
}

/**
 * Generate a Level 1 structural summary for a tool_result, matched to its tool_use.
 * Returns a bracket-notation summary like [Read src/proxy.ts — 342 lines, TypeScript].
 */
export function summarizeToolResult(
  toolName: string,
  toolInput: Record<string, unknown>,
  resultContent: string,
): string {
  switch (toolName) {
    case "Read": {
      const path = toolInput.file_path ?? toolInput.path ?? "unknown";
      const lineCount = resultContent.split("\n").length;
      const ext = String(path).split(".").pop() ?? "";
      const lang = extToLanguage(ext);
      return `[Read ${path} — ${lineCount} lines${lang ? `, ${lang}` : ""}]`;
    }

    case "Edit": {
      const path = toolInput.file_path ?? "unknown";
      const oldLen = typeof toolInput.old_string === "string" ? toolInput.old_string.length : 0;
      const newLen = typeof toolInput.new_string === "string" ? toolInput.new_string.length : 0;
      return `[Edit ${path} — replaced ${oldLen}→${newLen} chars]`;
    }

    case "Write": {
      const path = toolInput.file_path ?? "unknown";
      const contentStr = typeof toolInput.content === "string" ? toolInput.content : "";
      const lineCount = contentStr.split("\n").length;
      return `[Write ${path} — ${lineCount} lines]`;
    }

    case "Grep": {
      const pattern = toolInput.pattern ?? "?";
      const matchCount = resultContent.split("\n").filter(l => l.trim()).length;
      return `[Grep '${pattern}' — ${matchCount} matches]`;
    }

    case "Glob": {
      const pattern = toolInput.pattern ?? "?";
      const matchCount = resultContent.split("\n").filter(l => l.trim()).length;
      return `[Glob '${pattern}' — ${matchCount} files]`;
    }

    case "Bash": {
      const command = typeof toolInput.command === "string"
        ? toolInput.command.slice(0, 80)
        : "?";
      const lineCount = resultContent.split("\n").length;
      return `[Bash '${command}' — ${lineCount} lines output]`;
    }

    case "Agent": {
      const desc = toolInput.description ?? toolInput.prompt ?? "task";
      return `[Agent '${String(desc).slice(0, 60)}' — completed]`;
    }

    case "WebFetch": {
      const url = toolInput.url ?? "?";
      return `[WebFetch ${url} — ${resultContent.length} chars]`;
    }

    case "WebSearch": {
      const query = toolInput.query ?? "?";
      return `[WebSearch '${query}' — ${resultContent.length} chars]`;
    }

    default: {
      // Unknown tool — truncate result
      const preview = resultContent.slice(0, 200);
      const suffix = resultContent.length > 200 ? ` [...${resultContent.length} chars]` : "";
      return `[${toolName} — ${preview}${suffix}]`;
    }
  }
}

function extToLanguage(ext: string): string {
  const map: Record<string, string> = {
    ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript",
    py: "Python", rs: "Rust", go: "Go", java: "Java", rb: "Ruby",
    md: "Markdown", json: "JSON", yaml: "YAML", yml: "YAML",
    sql: "SQL", sh: "Shell", bash: "Shell", zsh: "Shell",
    css: "CSS", html: "HTML", xml: "XML", toml: "TOML",
  };
  return map[ext] ?? "";
}

// --- Level 1 Generation ---

/**
 * Generate a Level 1 summary for a completed exchange.
 * Queries raw_events for the group range and produces a plain text
 * user/assistant pair with tool results replaced by structural summaries.
 *
 * Returns null if no meaningful content found.
 */
export function generateLevel1(
  db: Database,
  startGroup: number,
  endGroup: number,
): { userText: string; assistantText: string; tokens: number } | null {
  const rows = db.query(`
    SELECT id, message_group, role, content_type, content, metadata
    FROM raw_events
    WHERE message_group >= ? AND message_group <= ?
      AND is_subagent = 0
      AND content_type != 'thinking'
      AND content != '<session-boundary />'
      AND content NOT LIKE '<system-reminder>%'
    ORDER BY id ASC
  `).all(startGroup, endGroup) as RawEventRow[];

  if (rows.length === 0) return null;

  // Build a map of tool_use_id → {tool_name, input} from assistant tool_use blocks
  const toolUseMap = new Map<string, { toolName: string; input: Record<string, unknown> }>();
  for (const row of rows) {
    if (row.role === "assistant" && row.content_type === "tool_use" && row.metadata) {
      const meta = JSON.parse(row.metadata) as ToolUseMeta;
      const toolId = meta.tool_id ?? "";
      const toolName = meta.tool_name ?? "unknown";
      let input: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(row.content);
        if (typeof parsed === "object" && parsed !== null) input = parsed;
      } catch { /* leave empty */ }
      toolUseMap.set(toolId, { toolName, input });
    }
  }

  // Collect user text and assistant text separately
  const userParts: string[] = [];
  const assistantParts: string[] = [];

  for (const row of rows) {
    if (row.role === "user") {
      if (row.content_type === "text") {
        userParts.push(row.content);
      } else if (row.content_type === "tool_result") {
        // Replace tool_result with structural summary
        const meta = row.metadata ? JSON.parse(row.metadata) as ToolResultMeta : {};
        const toolUseId = meta.tool_use_id ?? "";
        const matched = toolUseMap.get(toolUseId);
        if (matched) {
          assistantParts.push(summarizeToolResult(matched.toolName, matched.input, row.content));
        } else {
          // Unmatched tool_result — truncate
          const preview = row.content.slice(0, 200);
          const suffix = row.content.length > 200 ? ` [...${row.content.length} chars]` : "";
          assistantParts.push(`[tool result — ${preview}${suffix}]`);
        }
      }
    } else if (row.role === "assistant") {
      if (row.content_type === "text") {
        assistantParts.push(row.content);
      }
      // tool_use blocks: the summary is generated when the matching tool_result is processed.
      // We don't emit anything for the tool_use itself — the summary covers the interaction.
    }
  }

  const userText = userParts.join("\n").trim();
  const assistantText = assistantParts.join("\n").trim();

  if (!userText && !assistantText) return null;

  const tokens = estimateTokens(userText) + estimateTokens(assistantText) + 8; // role overhead
  return { userText: userText || "[no user text]", assistantText: assistantText || "[no response]", tokens };
}

/**
 * Store a Level 1 summary in the exchange_levels table.
 */
export function storeExchangeLevel(
  db: Database,
  startGroup: number,
  endGroup: number,
  sessionId: number | null,
  level: number,
  content: string,
  tokens: number,
): void {
  db.run(
    `INSERT OR REPLACE INTO exchange_levels
      (start_group, end_group, session_id, level, content, tokens)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [startGroup, endGroup, sessionId, level, content, tokens],
  );
}

/**
 * Finalize the previous exchange: generate Level 1 and store it.
 * Called when a new human_turn is detected, closing the prior exchange.
 *
 * Returns true if a Level 1 was generated and stored.
 */
export function finalizeExchange(
  db: Database,
  startGroup: number,
  endGroup: number,
  sessionId: number | null,
): boolean {
  if (endGroup < startGroup) return false;

  const result = generateLevel1(db, startGroup, endGroup);
  if (!result) return false;

  // Store as JSON-encoded pair of plain text messages
  const content = JSON.stringify([
    { role: "user", content: result.userText },
    { role: "assistant", content: result.assistantText },
  ]);

  storeExchangeLevel(db, startGroup, endGroup, sessionId, 1, content, result.tokens);
  return true;
}

// --- Per-Exchange Level 0 Reconstruction ---

/**
 * Reconstruct a single exchange at Level 0 (verbatim) from raw_events.
 * Returns a self-contained, API-valid Message[] for the group range.
 *
 * Shares reconstruction logic with history.ts but operates on a single exchange
 * rather than the full history. Does NOT wrap buildHistoryTrace().
 */
export function reconstructExchange(
  db: Database,
  startGroup: number,
  endGroup: number,
): Message[] {
  const rows = db.query(`
    SELECT id, message_group, role, content_type, content, metadata
    FROM raw_events
    WHERE message_group >= ? AND message_group <= ?
      AND is_subagent = 0
      AND content_type != 'thinking'
      AND content != '<session-boundary />'
      AND content NOT LIKE '<system-reminder>%'
    ORDER BY id ASC
  `).all(startGroup, endGroup) as RawEventRow[];

  if (rows.length === 0) return [];

  // Group by message_group
  const groups = new Map<number, RawEventRow[]>();
  for (const row of rows) {
    let group = groups.get(row.message_group);
    if (!group) {
      group = [];
      groups.set(row.message_group, group);
    }
    group.push(row);
  }

  // Reconstruct messages
  const messages: Message[] = [];
  for (const [, groupRows] of groups) {
    const msg = reconstructMessageFromRows(groupRows);
    if (msg) messages.push(msg);
  }

  // Validate tool pairing within this exchange
  return validateToolPairingLocal(messages);
}

/**
 * Reconstruct a single Message from raw_event rows sharing the same message_group.
 * Equivalent to history.ts reconstructMessage but exported for reuse.
 */
function reconstructMessageFromRows(rows: RawEventRow[]): Message | null {
  if (rows.length === 0) return null;

  const role = rows[0]!.role as "user" | "assistant";

  // Filter out system reminders
  const contentRows = rows.filter(r => !r.content.trimStart().startsWith("<system-reminder>"));
  if (contentRows.length === 0) return null;

  // Single text block → simple string content
  if (contentRows.length === 1 && contentRows[0]!.content_type === "text") {
    return { role, content: contentRows[0]!.content };
  }

  // Multiple blocks → array content
  const blocks: ContentBlock[] = [];
  for (const row of contentRows) {
    const block = rowToContentBlockLocal(row);
    if (block) blocks.push(block);
  }

  if (blocks.length === 0) return null;
  return { role, content: blocks };
}

function rowToContentBlockLocal(row: RawEventRow): ContentBlock | null {
  switch (row.content_type) {
    case "text":
      return { type: "text", text: row.content };

    case "tool_use": {
      const meta = row.metadata ? JSON.parse(row.metadata) : {};
      let input: unknown = {};
      try {
        const parsed = JSON.parse(row.content);
        if (typeof parsed === "object" && parsed !== null) input = parsed;
      } catch {
        input = {};
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
 * Validate tool_use/tool_result pairing within a single exchange.
 * Skips broken pairs (same logic as history.ts validateToolPairing).
 */
function validateToolPairingLocal(messages: Message[]): Message[] {
  const result: Message[] = [];
  const seenToolUseIds = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;

    if (msg.role === "assistant" && hasToolUse(msg)) {
      const next = messages[i + 1];
      if (!next || next.role !== "user" || !hasToolResult(next)) {
        continue; // broken pair
      }

      const toolUseIds = getToolUseIds(msg);
      if (toolUseIds.some(id => seenToolUseIds.has(id))) {
        i++; // skip duplicate pair
        continue;
      }
      for (const id of toolUseIds) seenToolUseIds.add(id);

      result.push(msg);
      result.push(next);
      i++;
    } else if (msg.role === "user" && hasToolResult(msg)) {
      const prev = result[result.length - 1];
      if (!prev || prev.role !== "assistant" || !hasToolUse(prev)) {
        continue; // orphaned tool_result
      }
      result.push(msg);
    } else {
      result.push(msg);
    }
  }

  return result;
}

function hasToolUse(msg: Message): boolean {
  if (typeof msg.content === "string") return false;
  return msg.content.some(b => b.type === "tool_use");
}

function hasToolResult(msg: Message): boolean {
  if (typeof msg.content === "string") return false;
  return msg.content.some(b => b.type === "tool_result");
}

function getToolUseIds(msg: Message): string[] {
  if (typeof msg.content === "string") return [];
  return msg.content
    .filter((b): b is { type: "tool_use"; id: string; name: string; input: unknown } => b.type === "tool_use")
    .map(b => b.id);
}

// --- Exchange Queries ---

/**
 * List all exchanges in the database (from exchange_levels, Level 1).
 */
export function listExchanges(
  db: Database,
): { startGroup: number; endGroup: number; sessionId: number | null; tokens: number }[] {
  const rows = db.query(`
    SELECT start_group, end_group, session_id, tokens
    FROM exchange_levels
    WHERE level = 1
    ORDER BY start_group ASC
  `).all() as { start_group: number; end_group: number; session_id: number | null; tokens: number }[];
  return rows.map(r => ({ startGroup: r.start_group, endGroup: r.end_group, sessionId: r.session_id, tokens: r.tokens }));
}

/**
 * Get a specific exchange level's content.
 */
export function getExchangeLevel(
  db: Database,
  startGroup: number,
  endGroup: number,
  level: number,
): { content: string; tokens: number; sessionId: number | null } | null {
  const row = db.query(`
    SELECT content, tokens, session_id
    FROM exchange_levels
    WHERE start_group = ? AND end_group = ? AND level = ?
  `).get(startGroup, endGroup, level) as { content: string; tokens: number; session_id: number | null } | null;

  if (!row) return null;
  return { content: row.content, tokens: row.tokens, sessionId: row.session_id };
}

/**
 * Check if a Level 1 already exists for a given exchange range.
 */
export function hasLevel1(db: Database, startGroup: number, endGroup: number): boolean {
  const row = db.query(`
    SELECT 1 FROM exchange_levels
    WHERE start_group = ? AND end_group = ? AND level = 1
  `).get(startGroup, endGroup);
  return row !== null;
}

/**
 * Detect exchange boundaries retrospectively from raw_events.
 * Used by the backfill command.
 *
 * An exchange starts at a user text message_group (human turn)
 * and ends at the group before the next human turn.
 */
export function detectExchangeBoundaries(
  db: Database,
): { startGroup: number; endGroup: number; sessionId: number }[] {
  // Find all human turn groups: user text messages that are NOT tool_results
  // A human turn is a user message_group that contains text but no tool_result
  const humanTurnGroups = db.query(`
    SELECT DISTINCT message_group
    FROM raw_events
    WHERE role = 'user'
      AND content_type = 'text'
      AND is_subagent = 0
      AND content != '<session-boundary />'
      AND content NOT LIKE '<system-reminder>%'
      AND message_group NOT IN (
        SELECT DISTINCT message_group FROM raw_events
        WHERE role = 'user' AND content_type = 'tool_result' AND is_subagent = 0
      )
    ORDER BY message_group ASC
  `).all() as { message_group: number }[];

  if (humanTurnGroups.length === 0) return [];

  // Find session boundaries for session ID assignment
  const boundaries = db.query(`
    SELECT message_group FROM raw_events
    WHERE content = '<session-boundary />' AND is_subagent = 0
    ORDER BY message_group ASC
  `).all() as { message_group: number }[];

  // Find max message_group
  const maxGroup = db.query(
    "SELECT COALESCE(MAX(message_group), 0) as mg FROM raw_events WHERE is_subagent = 0"
  ).get() as { mg: number };

  const exchanges: { startGroup: number; endGroup: number; sessionId: number }[] = [];
  let sessionId = 0;
  let boundaryIdx = 0;

  for (let i = 0; i < humanTurnGroups.length; i++) {
    const startGroup = humanTurnGroups[i]!.message_group;

    // Advance session ID past any boundaries before this exchange
    while (boundaryIdx < boundaries.length && boundaries[boundaryIdx]!.message_group <= startGroup) {
      sessionId++;
      boundaryIdx++;
    }

    // End group: group before the NEXT human turn, or max group if this is the last
    const endGroup = i + 1 < humanTurnGroups.length
      ? humanTurnGroups[i + 1]!.message_group - 1
      : maxGroup.mg;

    if (endGroup >= startGroup) {
      exchanges.push({ startGroup, endGroup, sessionId });
    }
  }

  return exchanges;
}

/**
 * Retroactively generate Level 1 summaries for all exchanges
 * that don't already have them. Idempotent.
 */
export function backfillExchanges(
  db: Database,
): { processed: number; skipped: number; total: number } {
  const boundaries = detectExchangeBoundaries(db);
  let processed = 0;
  let skipped = 0;

  for (const { startGroup, endGroup, sessionId } of boundaries) {
    if (hasLevel1(db, startGroup, endGroup)) {
      skipped++;
      continue;
    }
    const stored = finalizeExchange(db, startGroup, endGroup, sessionId);
    if (stored) {
      processed++;
    } else {
      skipped++;
    }
  }

  return { processed, skipped, total: boundaries.length };
}
