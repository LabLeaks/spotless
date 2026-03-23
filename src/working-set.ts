/**
 * Working set tracker for the context composer.
 *
 * Tracks active files and concepts in-memory, updated after each turn
 * by scanning tool calls and user messages. Decays entries older than
 * N turns. Used by the composer's scoring function to boost exchanges
 * that touch the current working set.
 */

import type { CapturedBlock } from "./archiver.ts";

// --- Types ---

export interface WorkingSetEntry {
  lastTurn: number;
  action: "read" | "edit" | "search";
}

export interface WorkingSet {
  files: Map<string, WorkingSetEntry>;
  concepts: Set<string>;
  lastUpdatedTurn: number;
}

/** Default number of turns before entries decay. */
export const WORKING_SET_MAX_AGE = 10;

// --- Stopwords for user message keyword extraction ---

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "it", "as", "be", "was", "are",
  "been", "has", "had", "have", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "can", "this", "that", "these",
  "those", "what", "which", "who", "how", "when", "where", "why",
  "not", "no", "yes", "all", "each", "every", "any", "some", "if",
  "then", "else", "so", "just", "also", "too", "very", "really",
  "about", "into", "over", "after", "before", "between", "through",
  "out", "up", "down", "here", "there", "now", "then", "than",
  "more", "most", "other", "only", "same", "such", "like",
  "get", "got", "let", "make", "see", "look", "want", "need",
  "use", "try", "know", "think", "take", "come", "give", "tell",
  "say", "said", "its", "my", "your", "our", "his", "her", "their",
  "we", "you", "they", "me", "him", "them", "she", "he",
]);

// --- Core functions ---

export function createWorkingSet(): WorkingSet {
  return {
    files: new Map(),
    concepts: new Set(),
    lastUpdatedTurn: 0,
  };
}

/**
 * Update the working set from assistant response blocks.
 * Extracts file paths from Read/Edit/Write tool calls and
 * search terms from Grep/Glob/Bash tool calls.
 */
export function updateWorkingSetFromBlocks(
  ws: WorkingSet,
  blocks: CapturedBlock[],
  turnGroup: number,
): void {
  for (const block of blocks) {
    if (block.type !== "tool_use" || !block.metadata) continue;

    const toolName = block.metadata.tool_name as string | undefined;
    if (!toolName) continue;

    let input: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(block.content);
      if (typeof parsed === "object" && parsed !== null) input = parsed;
    } catch { /* ignore parse errors */ }

    switch (toolName) {
      case "Read": {
        const path = (input.file_path ?? input.path) as string | undefined;
        if (path) ws.files.set(path, { lastTurn: turnGroup, action: "read" });
        break;
      }
      case "Edit": {
        const path = input.file_path as string | undefined;
        if (path) ws.files.set(path, { lastTurn: turnGroup, action: "edit" });
        break;
      }
      case "Write": {
        const path = input.file_path as string | undefined;
        if (path) ws.files.set(path, { lastTurn: turnGroup, action: "edit" });
        break;
      }
      case "Grep": {
        const pattern = input.pattern as string | undefined;
        if (pattern) ws.concepts.add(pattern);
        break;
      }
      case "Glob": {
        const pattern = input.pattern as string | undefined;
        if (pattern) ws.concepts.add(pattern);
        break;
      }
      case "Bash": {
        const command = input.command as string | undefined;
        if (command) {
          // Extract first meaningful word from command
          const firstWord = command.trim().split(/\s+/)[0];
          if (firstWord && firstWord.length >= 3) ws.concepts.add(firstWord);
        }
        break;
      }
    }
  }

  ws.lastUpdatedTurn = turnGroup;
}

/**
 * Update the working set from user message text.
 * Extracts keywords (non-stopword, length >= 3, up to 10).
 */
export function updateWorkingSetFromUserMessage(
  ws: WorkingSet,
  text: string,
  turnGroup: number,
): void {
  const words = text
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOPWORDS.has(w.toLowerCase()))
    .map(w => w.toLowerCase());

  // Deduplicate and take first 10
  const unique = [...new Set(words)].slice(0, 10);
  for (const word of unique) {
    ws.concepts.add(word);
  }

  ws.lastUpdatedTurn = turnGroup;
}

/**
 * Remove entries older than maxAge turns from the current group.
 */
export function decayWorkingSet(
  ws: WorkingSet,
  currentGroup: number,
  maxAge: number = WORKING_SET_MAX_AGE,
): void {
  const cutoff = currentGroup - maxAge;

  for (const [path, entry] of ws.files) {
    if (entry.lastTurn < cutoff) {
      ws.files.delete(path);
    }
  }

  // Concepts don't have individual timestamps — clear all if working set
  // hasn't been updated recently (concepts are lightweight, refreshed often)
  if (ws.lastUpdatedTurn < cutoff) {
    ws.concepts.clear();
  }
}

/**
 * Get active file paths from the working set.
 */
export function getWorkingSetFiles(ws: WorkingSet): string[] {
  return Array.from(ws.files.keys());
}

/**
 * Get active concepts from the working set.
 */
export function getWorkingSetConcepts(ws: WorkingSet): string[] {
  return Array.from(ws.concepts);
}
