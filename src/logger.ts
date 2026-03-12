/**
 * Simple file logger for Spotless proxy.
 *
 * Writes error-level events to ~/.spotless/spotless.log so they survive
 * terminal closure and can be collected for bug reports.
 * Also writes to stderr for real-time visibility.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SPOTLESS_DIR = join(homedir(), ".spotless");
const LOG_FILE = join(SPOTLESS_DIR, "spotless.log");
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB — rotate after this

function ensureDir(): void {
  mkdirSync(SPOTLESS_DIR, { recursive: true });
}

function timestamp(): string {
  return new Date().toISOString();
}

/**
 * Log an error-level message to both stderr and the log file.
 */
export function logError(message: string): void {
  const line = `[${timestamp()}] ERROR ${message}\n`;
  console.error(message);
  try {
    ensureDir();
    appendFileSync(LOG_FILE, line);
  } catch {
    // Logging should never break the proxy
  }
}

/**
 * Log a warning-level message to both stderr and the log file.
 */
export function logWarn(message: string): void {
  const line = `[${timestamp()}] WARN ${message}\n`;
  console.error(message);
  try {
    ensureDir();
    appendFileSync(LOG_FILE, line);
  } catch {
    // Logging should never break the proxy
  }
}

/**
 * Log a diagnostic event (API errors, malformed data) to the log file only.
 * These are verbose and shouldn't clutter stderr.
 */
export function logDiagnostic(message: string): void {
  const line = `[${timestamp()}] DIAG ${message}\n`;
  try {
    ensureDir();
    appendFileSync(LOG_FILE, line);
  } catch {
    // non-fatal
  }
}

export { LOG_FILE };
