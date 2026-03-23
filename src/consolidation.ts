/**
 * Consolidation pressure, watermark, and pressure signal.
 *
 * Pressure = unconsolidated tokens / history budget.
 * Watermark = highest message_group that has been consolidated.
 * Pressure signal = XML tag injected when pressure is elevated.
 */

import type { Database } from "bun:sqlite";
import { HISTORY_BUDGET } from "./tokens.ts";

// --- Pressure thresholds ---

export const PRESSURE_MODERATE = 0.6;
export const PRESSURE_HIGH = 0.85;

// --- Types ---

export type PressureLevel = "none" | "moderate" | "high";

export interface ConsolidationStatus {
  watermark: number | null;
  pressure: number;
  unconsolidatedTokens: number;
  totalGroups: number;
  consolidatedGroups: number;
}

export interface PressureResult {
  pressure: number;
  unconsolidatedTokens: number;
}

// --- Pure functions ---

export function getPressureLevel(pressure: number): PressureLevel {
  if (pressure >= PRESSURE_HIGH) return "high";
  if (pressure >= PRESSURE_MODERATE) return "moderate";
  return "none";
}

export function buildPressureSignal(pressure: number, unconsolidatedTokens: number): string {
  const level = getPressureLevel(pressure);
  if (level === "none") return "";

  const approxTokens = Math.round(unconsolidatedTokens / 1000);

  if (level === "moderate") {
    return `<memory-pressure level="moderate">Your memory consolidation is falling behind — you have approximately ${approxTokens}k tokens of unconsolidated experience. Recent interactions may not yet be encoded into your long-term memory. Consider wrapping up the current thread to let consolidation catch up.</memory-pressure>`;
  }

  return `<memory-pressure level="high">Your memory consolidation is significantly behind — approximately ${approxTokens}k tokens of unconsolidated experience. Your long-term memory has gaps in recent work. Please pause for a few minutes to allow consolidation to process.</memory-pressure>`;
}

// --- DB queries ---

export function getWatermark(db: Database): number | null {
  const row = db.query(
    "SELECT MAX(message_group) as wm FROM raw_events WHERE consolidated = 1 AND is_subagent = 0"
  ).get() as { wm: number | null } | null;
  return row?.wm ?? null;
}

export function getConsolidationPressure(db: Database, budget: number = HISTORY_BUDGET): PressureResult {
  const row = db.query(
    `SELECT COALESCE(SUM(LENGTH(content)) / 4.0, 0) as tokens FROM raw_events
     WHERE consolidated = 0 AND is_subagent = 0 AND content_type != 'thinking'
       AND content != '<session-boundary />'
       AND content NOT LIKE '<system-reminder>%'`
  ).get() as { tokens: number };
  const unconsolidatedTokens = row.tokens;
  const pressure = budget > 0 ? unconsolidatedTokens / budget : 0;
  return { pressure, unconsolidatedTokens };
}

export function getConsolidationStatus(db: Database, budget: number = HISTORY_BUDGET): ConsolidationStatus {
  const watermark = getWatermark(db);
  const { pressure, unconsolidatedTokens } = getConsolidationPressure(db, budget);

  const groupRow = db.query(
    `SELECT COUNT(DISTINCT message_group) as total FROM raw_events
     WHERE is_subagent = 0
       AND content != '<session-boundary />'
       AND content NOT LIKE '<system-reminder>%'`
  ).get() as { total: number };

  const consolidatedRow = db.query(
    `SELECT COUNT(DISTINCT message_group) as consolidated FROM raw_events
     WHERE consolidated = 1 AND is_subagent = 0
       AND content != '<session-boundary />'
       AND content NOT LIKE '<system-reminder>%'`
  ).get() as { consolidated: number };

  return {
    watermark,
    pressure,
    unconsolidatedTokens,
    totalGroups: groupRow.total,
    consolidatedGroups: consolidatedRow.consolidated,
  };
}
