/**
 * Context composer — fractal fidelity context assembly.
 *
 * Replaces chronological buildHistory() with elastic, scored composition.
 * Each exchange rendered at the fidelity level that fits its relevance
 * and the available budget: Level 0 (verbatim), Level 1 (condensed),
 * Level 2 (action summary), Level 3 (session summary).
 *
 * Sprint 11 / Aperture — ADR-006.
 */

import type { Database } from "bun:sqlite";
import type { Message } from "./types.ts";
import type { WorkingSet } from "./working-set.ts";
import { getWorkingSetFiles, getWorkingSetConcepts } from "./working-set.ts";
import { reconstructExchange, getExchangeLevel } from "./exchange.ts";
import { buildHistory, buildMemoryPreamble, enforceAlternation } from "./history.ts";
import { getConsolidationPressure } from "./consolidation.ts";
import { sanitizeFts5Query } from "./recall.ts";
import { estimateTokens, estimateMessageTokens, PRESSURE_BUDGET_CAP } from "./tokens.ts";

// --- Constants ---

/** Minimum budget for thread coherence. */
export const APERTURE_FLOOR = 40_000;

/** Target budget for typical turns. */
export const APERTURE_BASELINE = 100_000;

/** Max budget unless overridden by high-relevance content. */
export const APERTURE_SOFT_CAP = 200_000;

/** Max tokens for anchor phase (recent exchanges at Level 0). */
export const ANCHOR_BUDGET = 40_000;

/** Score thresholds for fidelity mapping. */
const SCORE_HIGH = 0.7;
const SCORE_MEDIUM = 0.4;
const SCORE_LOW = 0.15;

/** Scoring weights. */
const WEIGHT_RECENCY = 1.0;
const WEIGHT_RELEVANCE = 0.8;
const WEIGHT_WORKING_SET = 0.5;

const SESSION_DIVIDER = "\n\n--- new session ---\n\n";

// --- Types ---

export interface CompositionResult {
  messages: Message[];
  trimmedCount: number;         // always 0 (compat with HistoryResult)
  pressure: number;
  unconsolidatedTokens: number;
  budgetUsed: number;
  exchangeCount: number;
  fidelityCoverage: {
    level0: number;
    level1: number;
    level2: number;
    level3: number;
  };
}

interface ExchangeInfo {
  startGroup: number;
  endGroup: number;
  sessionId: number | null;
  level1Tokens: number;
  level1Content: string;
  score: number;
  selectedLevel: number | null;  // null = not selected
  selectedTokens: number;
}

// --- Main ---

/**
 * Compose context from exchange_levels with elastic budget.
 *
 * Falls back to buildHistory() if no exchanges exist yet.
 */
export function composeContext(
  db: Database,
  budget: number,
  agentName: string | null,
  userMessageText: string,
  workingSet: WorkingSet,
): CompositionResult {
  // Compute pressure (same as buildHistory)
  let pressure = 0;
  let unconsolidatedTokens = 0;
  try {
    const pressureBudget = Math.min(budget, PRESSURE_BUDGET_CAP);
    const pr = getConsolidationPressure(db, pressureBudget);
    pressure = pr.pressure;
    unconsolidatedTokens = pr.unconsolidatedTokens;
  } catch { /* non-fatal */ }

  // Check if any exchanges exist
  const countRow = db.query(
    "SELECT COUNT(*) as cnt FROM exchange_levels WHERE level = 1"
  ).get() as { cnt: number } | null;

  if (!countRow || countRow.cnt === 0) {
    // Fallback to chronological buildHistory
    const result = buildHistory(db, budget, agentName);
    return {
      ...result,
      budgetUsed: 0,
      exchangeCount: 0,
      fidelityCoverage: { level0: 0, level1: 0, level2: 0, level3: 0 },
    };
  }

  // Load all Level 1 exchanges
  const exchanges = loadExchanges(db);
  if (exchanges.length === 0) {
    return emptyResult(pressure, unconsolidatedTokens);
  }

  // Score exchanges
  scoreExchanges(db, exchanges, userMessageText, workingSet);

  // Effective budget: clamp to APERTURE_SOFT_CAP unless budget is larger
  const effectiveBudget = Math.min(budget, APERTURE_SOFT_CAP);

  // Preamble cost (always included)
  const preambleText = buildMemoryPreamble(agentName);
  const ackText = agentName
    ? `Understood. I'm ${agentName}. I have my identity and memories available through Spotless, and conversation history from previous sessions.`
    : "Understood. I have my identity and memories available through Spotless, and conversation history from previous sessions.";
  const preambleCost = estimateTokens(preambleText) + estimateTokens(ackText) + 8;
  let remaining = effectiveBudget - preambleCost;

  // Phase 1: Anchor — recent exchanges at Level 0
  const anchorLimit = Math.min(ANCHOR_BUDGET, remaining);
  let anchorUsed = 0;
  for (let i = exchanges.length - 1; i >= 0; i--) {
    const ex = exchanges[i]!;
    // Estimate Level 0 token cost from raw_events
    const level0Tokens = estimateLevel0Tokens(db, ex.startGroup, ex.endGroup);
    if (i === exchanges.length - 1) {
      // Always include the most recent exchange at Level 0
      ex.selectedLevel = 0;
      ex.selectedTokens = level0Tokens;
      anchorUsed += level0Tokens;
      continue;
    }
    if (anchorUsed + level0Tokens <= anchorLimit) {
      ex.selectedLevel = 0;
      ex.selectedTokens = level0Tokens;
      anchorUsed += level0Tokens;
    } else {
      break;
    }
  }
  remaining -= anchorUsed;

  // Phase 2: Fill to baseline — sort unselected by score DESC
  const unselected = exchanges.filter(e => e.selectedLevel === null);
  unselected.sort((a, b) => b.score - a.score);

  const baselineTarget = Math.min(APERTURE_BASELINE - preambleCost - anchorUsed, remaining);

  let fillUsed = 0;
  for (const ex of unselected) {
    if (fillUsed >= baselineTarget) break;

    const preferred = preferredLevel(ex.score);
    if (preferred === null) continue; // score too low

    const tokens = pickFidelity(db, ex, preferred, baselineTarget - fillUsed);
    if (tokens > 0) {
      fillUsed += tokens;
    }
  }
  remaining -= fillUsed;

  // Phase 3: Flex past baseline — only high-scoring exchanges
  const stillUnselected = exchanges.filter(e => e.selectedLevel === null && e.score >= SCORE_HIGH);
  stillUnselected.sort((a, b) => b.score - a.score);

  const flexBudget = Math.min(APERTURE_SOFT_CAP - preambleCost - anchorUsed - fillUsed, remaining);
  let flexUsed = 0;
  for (const ex of stillUnselected) {
    if (flexUsed >= flexBudget) break;
    const tokens = pickFidelity(db, ex, 0, flexBudget - flexUsed);
    if (tokens > 0) {
      flexUsed += tokens;
    }
  }

  // Assemble messages in chronological order
  const selected = exchanges
    .filter(e => e.selectedLevel !== null)
    .sort((a, b) => a.startGroup - b.startGroup);

  const assembled: Message[] = [];
  let lastSessionId: number | null = null;
  let pendingDivider = false;

  for (const ex of selected) {
    // Session divider
    if (lastSessionId !== null && ex.sessionId !== lastSessionId) {
      pendingDivider = true;
    }
    lastSessionId = ex.sessionId;

    const msgs = renderExchange(db, ex);

    if (pendingDivider && msgs.length > 0) {
      // Prepend divider to first user message
      const first = msgs[0]!;
      if (first.role === "user" && typeof first.content === "string") {
        msgs[0] = { role: "user", content: SESSION_DIVIDER + first.content };
      }
      pendingDivider = false;
    }

    assembled.push(...msgs);
  }

  // Enforce alternation on final array
  const alternating = enforceAlternation(assembled);

  // Prepend preamble
  const preamble: Message[] = [
    { role: "user", content: preambleText },
    { role: "assistant", content: ackText },
  ];
  const messages = [...preamble, ...alternating];

  // Compute fidelity coverage
  const coverage = { level0: 0, level1: 0, level2: 0, level3: 0 };
  for (const ex of selected) {
    switch (ex.selectedLevel) {
      case 0: coverage.level0++; break;
      case 1: coverage.level1++; break;
      case 2: coverage.level2++; break;
      case 3: coverage.level3++; break;
    }
  }

  const totalUsed = preambleCost + anchorUsed + fillUsed + flexUsed;

  return {
    messages,
    trimmedCount: 0,
    pressure,
    unconsolidatedTokens,
    budgetUsed: totalUsed,
    exchangeCount: selected.length,
    fidelityCoverage: coverage,
  };
}

// --- Helpers ---

function loadExchanges(db: Database): ExchangeInfo[] {
  const rows = db.query(`
    SELECT start_group, end_group, session_id, tokens, content
    FROM exchange_levels
    WHERE level = 1
    ORDER BY start_group ASC
  `).all() as { start_group: number; end_group: number; session_id: number | null; tokens: number; content: string }[];

  return rows.map(r => ({
    startGroup: r.start_group,
    endGroup: r.end_group,
    sessionId: r.session_id,
    level1Tokens: r.tokens,
    level1Content: r.content,
    score: 0,
    selectedLevel: null,
    selectedTokens: 0,
  }));
}

function scoreExchanges(
  db: Database,
  exchanges: ExchangeInfo[],
  userMessageText: string,
  workingSet: WorkingSet,
): void {
  const total = exchanges.length;
  if (total === 0) return;

  // FTS5 relevance: query raw_events_fts, map to exchanges
  const relevanceMap = computeFts5Relevance(db, exchanges, userMessageText);

  // Working set matching
  const wsFiles = new Set(getWorkingSetFiles(workingSet));
  const wsConcepts = getWorkingSetConcepts(workingSet);

  for (let i = 0; i < exchanges.length; i++) {
    const ex = exchanges[i]!;
    const ordinalDistance = total - 1 - i;
    const recency = 1 / (1 + ordinalDistance);
    const relevance = relevanceMap.get(ex.startGroup) ?? 0;

    // Check Level 1 content for working set overlap
    let wsBonus = 0;
    if (wsFiles.size > 0 || wsConcepts.length > 0) {
      const content = ex.level1Content.toLowerCase();
      for (const file of wsFiles) {
        if (content.includes(file.toLowerCase())) {
          wsBonus = Math.max(wsBonus, 0.3);
          break;
        }
      }
      if (wsBonus < 0.3) {
        for (const concept of wsConcepts) {
          if (content.includes(concept.toLowerCase())) {
            wsBonus = Math.max(wsBonus, 0.1);
            break;
          }
        }
      }
    }

    ex.score = WEIGHT_RECENCY * recency + WEIGHT_RELEVANCE * relevance + WEIGHT_WORKING_SET * wsBonus;
  }
}

function computeFts5Relevance(
  db: Database,
  exchanges: ExchangeInfo[],
  userMessageText: string,
): Map<number, number> {
  const result = new Map<number, number>();
  const query = sanitizeFts5Query(userMessageText);
  if (!query) return result;

  let rows: { message_group: number; rank: number }[];
  try {
    rows = db.query(`
      SELECT re.message_group, rank
      FROM raw_events_fts
      JOIN raw_events re ON re.id = raw_events_fts.rowid
      WHERE raw_events_fts MATCH ?
        AND re.is_subagent = 0
    `).all(query) as { message_group: number; rank: number }[];
  } catch {
    return result; // FTS5 query error — non-fatal
  }

  if (rows.length === 0) return result;

  // Map message_groups to exchanges and aggregate with MAX(abs(rank))
  // FTS5 rank is negative (more negative = better match), so use abs()
  const exchangeScores = new Map<number, number>();

  for (const row of rows) {
    const absRank = Math.abs(row.rank);
    // Find which exchange this message_group belongs to
    for (const ex of exchanges) {
      if (row.message_group >= ex.startGroup && row.message_group <= ex.endGroup) {
        const current = exchangeScores.get(ex.startGroup) ?? 0;
        exchangeScores.set(ex.startGroup, Math.max(current, absRank));
        break;
      }
    }
  }

  // Normalize: max score → 1.0
  let maxScore = 0;
  for (const score of exchangeScores.values()) {
    maxScore = Math.max(maxScore, score);
  }

  if (maxScore > 0) {
    for (const [key, score] of exchangeScores) {
      result.set(key, score / maxScore);
    }
  }

  return result;
}

function preferredLevel(score: number): number | null {
  if (score >= SCORE_HIGH) return 0;
  if (score >= SCORE_MEDIUM) return 1;
  if (score >= SCORE_LOW) return 2;
  return null; // too low, exclude
}

/**
 * Pick the best fidelity level that fits the remaining budget.
 * Demotes from preferred level downward if budget insufficient.
 * Returns tokens used (0 if nothing fits).
 */
function pickFidelity(
  db: Database,
  ex: ExchangeInfo,
  preferred: number,
  remainingBudget: number,
): number {
  // Try preferred level, then demote
  for (let level = preferred; level <= 3; level++) {
    const tokens = tokenCostForLevel(db, ex, level);
    if (tokens <= 0) continue; // level not available
    if (tokens <= remainingBudget) {
      ex.selectedLevel = level;
      ex.selectedTokens = tokens;
      return tokens;
    }
  }
  return 0;
}

function tokenCostForLevel(db: Database, ex: ExchangeInfo, level: number): number {
  if (level === 0) {
    return estimateLevel0Tokens(db, ex.startGroup, ex.endGroup);
  }
  if (level === 1) {
    return ex.level1Tokens;
  }
  // Levels 2-3: check if they exist in exchange_levels
  const row = getExchangeLevel(db, ex.startGroup, ex.endGroup, level);
  return row?.tokens ?? -1; // -1 = not available
}

function estimateLevel0Tokens(db: Database, startGroup: number, endGroup: number): number {
  const row = db.query(`
    SELECT SUM(LENGTH(content)) as total_chars
    FROM raw_events
    WHERE message_group >= ? AND message_group <= ?
      AND is_subagent = 0
      AND content_type != 'thinking'
      AND content != '<session-boundary />'
      AND content NOT LIKE '<system-reminder>%'
  `).get(startGroup, endGroup) as { total_chars: number | null } | null;

  const chars = row?.total_chars ?? 0;
  return Math.ceil(chars / 4) + 20; // token estimate + overhead per exchange
}

function renderExchange(db: Database, ex: ExchangeInfo): Message[] {
  if (ex.selectedLevel === 0) {
    return reconstructExchange(db, ex.startGroup, ex.endGroup);
  }

  // Level 1, 2, or 3: read pre-rendered content from exchange_levels
  const level = getExchangeLevel(db, ex.startGroup, ex.endGroup, ex.selectedLevel!);
  if (!level) {
    // Fallback: try Level 1
    const l1 = getExchangeLevel(db, ex.startGroup, ex.endGroup, 1);
    if (!l1) return []; // nothing available

    return parseRenderedContent(l1.content);
  }

  return parseRenderedContent(level.content);
}

function parseRenderedContent(content: string): Message[] {
  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed) || parsed.length < 2) return [];
    return parsed.map((m: { role: string; content: string }) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));
  } catch {
    return [];
  }
}

function emptyResult(pressure: number, unconsolidatedTokens: number): CompositionResult {
  return {
    messages: [],
    trimmedCount: 0,
    pressure,
    unconsolidatedTokens,
    budgetUsed: 0,
    exchangeCount: 0,
    fidelityCoverage: { level0: 0, level1: 0, level2: 0, level3: 0 },
  };
}
