/**
 * Live test harness for Spotless.
 *
 * Runs real Claude Code through the real proxy, using tmux for interactive
 * session control. This is Playwright for terminals.
 *
 * Usage:
 *   const session = await createLiveSession({ agent: "e2e-test" });
 *   await session.type("hello");
 *   await session.submit();
 *   await session.waitForIdle();
 *   const output = await session.capture();
 *   expect(output).toContain("Hello");
 *   await session.cleanup();
 */

import { spawnSync, execSync } from "node:child_process";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";
import { openDb, initSchema } from "../../src/db.ts";

// --- Config ---

const DEFAULT_PORT = 9998;
const POLL_INTERVAL_MS = 500;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000; // 2 min — Claude can think for a while
const STARTUP_TIMEOUT_MS = 15_000;
const PROXY_STARTUP_TIMEOUT_MS = 10_000;

// --- Types ---

export interface LiveSessionConfig {
  agent?: string;
  port?: number;
  maxContext?: number;
  /** Extra args passed to `claude` (e.g. ["-p", "some prompt"]) */
  claudeArgs?: string[];
  /** If true, run in prompt mode (`claude -p`) instead of interactive */
  promptMode?: boolean;
}

export type ClaudeState = "idle" | "working" | "permission" | "exited" | "unknown";

export interface LiveSession {
  /** The tmux session name */
  sessionName: string;
  /** Agent name */
  agent: string;
  /** Proxy port */
  port: number;
  /** Type text into the terminal */
  type: (text: string) => void;
  /** Send Enter key */
  submit: () => void;
  /** Send Escape key */
  escape: () => void;
  /** Send Ctrl+C */
  interrupt: () => void;
  /** Send arbitrary tmux key sequence */
  sendKeys: (keys: string) => void;
  /** Capture the current pane content */
  capture: () => string;
  /** Detect Claude's current state */
  state: () => ClaudeState;
  /** Wait until Claude is idle (showing input prompt) */
  waitForIdle: (timeoutMs?: number) => Promise<void>;
  /** Wait until Claude exits (shell prompt visible) */
  waitForExit: (timeoutMs?: number) => Promise<void>;
  /** Wait for specific text to appear in the pane */
  waitForText: (text: string, timeoutMs?: number) => Promise<string>;
  /** Get the agent's database (read-only) */
  db: () => Database;
  /** Get proxy log output */
  proxyLog: () => string;
  /** Clean up everything: kill session, stop proxy, optionally delete agent DB */
  cleanup: (deleteDb?: boolean) => void;
}

export interface PromptResult {
  /** stdout from `claude -p` */
  output: string;
  /** exit code */
  exitCode: number;
  /** Agent name used */
  agent: string;
  /** Proxy port used */
  port: number;
  /** Get the agent's database (read-only) */
  db: () => Database;
  /** Get proxy log output */
  proxyLog: () => string;
  /** Clean up: stop proxy, optionally delete agent DB */
  cleanup: (deleteDb?: boolean) => void;
}

// --- Helpers ---

function tmux(...args: string[]): string {
  const result = spawnSync("tmux", args, { encoding: "utf-8", timeout: 5000 });
  if (result.error) throw result.error;
  return result.stdout ?? "";
}

function tmuxSafe(...args: string[]): string | null {
  const result = spawnSync("tmux", args, { encoding: "utf-8", timeout: 5000 });
  if (result.status !== 0) return null;
  return result.stdout ?? "";
}

function sessionExists(name: string): boolean {
  return tmuxSafe("has-session", "-t", name) !== null;
}

function killSession(name: string): void {
  try { tmux("kill-session", "-t", name); } catch { /* already gone */ }
}

function getAgentDbPath(agent: string): string {
  return join(homedir(), ".spotless", "agents", agent, "spotless.db");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Detect Claude Code's state from pane content.
 */
export function detectState(paneContent: string): ClaudeState {
  const lines = paneContent.split("\n");
  const lastLines = lines.slice(-15).join("\n");

  // Check for shell prompt (claude exited)
  // Common shell prompts: $, %, ❯ (but ❯ is also Claude's prompt)
  // Better: check if the pane's current command is a shell
  // For now, look for exit signals
  if (lastLines.includes("exited with code") || lastLines.includes("Process exited")) {
    return "exited";
  }

  // Check for permission prompts
  if (/\[y\/n\]/i.test(lastLines) || /Allow|Deny|approve/i.test(lastLines)) {
    return "permission";
  }

  // Check for working state — "to interrupt" is shown while Claude is streaming
  if (lastLines.includes("to interrupt") || lastLines.includes("to cancel")) {
    return "working";
  }

  // Check for idle state — the ❯ prompt appears when waiting for input.
  // Claude Code shows "❯ " on its own line. Check any line, not just the last,
  // since the status bar and other decorations appear below the prompt.
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "❯" || trimmed === ">" || /^❯\s*$/.test(trimmed)) {
      return "idle";
    }
  }

  return "unknown";
}

// --- Proxy management ---

let proxyPid: number | null = null;
let proxyPort: number | null = null;

function isProxyRunning(): boolean {
  if (!proxyPid) return false;
  try {
    process.kill(proxyPid, 0);
    return true;
  } catch {
    return false;
  }
}

function readProxyPid(): { pid: number; port: number } | null {
  const pidFile = join(homedir(), ".spotless", "spotless.pid");
  try {
    const content = readFileSync(pidFile, "utf-8").trim();
    const [pidStr, portStr] = content.split(":");
    return { pid: parseInt(pidStr!, 10), port: parseInt(portStr!, 10) };
  } catch {
    return null;
  }
}

export async function ensureProxy(port: number, maxContext?: number): Promise<void> {
  // Check if proxy already running on this port
  const existing = readProxyPid();
  if (existing && existing.port === port) {
    try {
      process.kill(existing.pid, 0);
      proxyPid = existing.pid;
      proxyPort = port;
      return; // Already running
    } catch { /* stale */ }
  }

  // Start proxy
  const selfPath = join(import.meta.dir, "../../src/index.ts");
  const args = ["bun", "run", selfPath, "start", "--port", String(port)];
  if (maxContext != null) args.push("--max-context", String(maxContext));

  const child = Bun.spawn(args, {
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.unref();

  // Wait for it to be ready — try connecting to the port
  const deadline = Date.now() + PROXY_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      // Use a POST to /v1/messages which is the actual route — any response (even 400) means proxy is up
      const resp = await fetch(`http://localhost:${port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      proxyPid = child.pid;
      proxyPort = port;
      return;
    } catch {
      await sleep(300);
    }
  }
  throw new Error(`Proxy failed to start on port ${port} within ${PROXY_STARTUP_TIMEOUT_MS}ms`);
}

export function stopProxy(): void {
  const info = readProxyPid();
  if (info) {
    try { process.kill(info.pid, "SIGTERM"); } catch { /* already gone */ }
  }
  proxyPid = null;
  proxyPort = null;
}

// --- Session factories ---

/**
 * Run `claude -p` through the proxy and return the result.
 * For simple one-shot tests.
 */
export async function runPrompt(
  prompt: string,
  config: LiveSessionConfig = {},
): Promise<PromptResult> {
  const agent = config.agent ?? `e2e-${Date.now()}`;
  const port = config.port ?? DEFAULT_PORT;

  await ensureProxy(port, config.maxContext);

  const baseUrl = `http://localhost:${port}/agent/${agent}`;
  const args = ["claude", "-p", prompt, ...(config.claudeArgs ?? [])];

  const result = spawnSync(args[0]!, args.slice(1), {
    encoding: "utf-8",
    timeout: DEFAULT_IDLE_TIMEOUT_MS,
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: baseUrl,
      CLAUDECODE: "", // bypass nesting check
    },
  });

  return {
    output: result.stdout ?? "",
    exitCode: result.status ?? 1,
    agent,
    port,
    db: () => {
      const dbPath = getAgentDbPath(agent);
      const db = openDb(dbPath);
      initSchema(db);
      return db;
    },
    proxyLog: () => {
      try {
        const logPath = join(homedir(), ".spotless", "spotless.log");
        return readFileSync(logPath, "utf-8");
      } catch { return ""; }
    },
    cleanup: (deleteDb = true) => {
      if (deleteDb) {
        const agentDir = join(homedir(), ".spotless", "agents", agent);
        try { rmSync(agentDir, { recursive: true }); } catch { /* ok */ }
      }
    },
  };
}

/**
 * Create an interactive Claude Code session through the proxy via tmux.
 * This is the full Playwright-for-terminals experience.
 */
export async function createLiveSession(
  config: LiveSessionConfig = {},
): Promise<LiveSession> {
  const agent = config.agent ?? `e2e-${Date.now()}`;
  const port = config.port ?? DEFAULT_PORT;
  const name = `spotless-e2e-${agent}`;

  // Ensure proxy is running
  await ensureProxy(port, config.maxContext);

  // Kill any existing session with this name
  if (sessionExists(name)) {
    killSession(name);
  }

  // Build the claude command
  const baseUrl = `http://localhost:${port}/agent/${agent}`;
  const claudeArgs = config.claudeArgs ?? [];
  const cmd = `ANTHROPIC_BASE_URL=${baseUrl} CLAUDECODE= claude ${claudeArgs.join(" ")}`;

  // Create tmux session running claude
  tmux("new-session", "-d", "-s", name, "-x", "200", "-y", "50", cmd);

  // Wait for Claude to be ready (idle state)
  // Handle the --dangerously-skip-permissions confirmation prompt if it appears
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let ready = false;
  let handledBypassPrompt = false;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const content = tmuxSafe("capture-pane", "-t", name, "-p");
    if (!content) continue;

    // Handle bypass permissions confirmation: select "Yes" (option 2) and press Enter
    if (!handledBypassPrompt && content.includes("Bypass Permissions mode")) {
      tmux("send-keys", "-t", name, "Down");  // Move to option 2
      await sleep(200);
      tmux("send-keys", "-t", name, "Enter");
      handledBypassPrompt = true;
      continue;
    }

    if (detectState(content) === "idle") {
      ready = true;
      break;
    }
  }

  if (!ready) {
    const content = tmuxSafe("capture-pane", "-t", name, "-p") ?? "(no pane content)";
    killSession(name);
    throw new Error(`Claude did not reach idle state within ${STARTUP_TIMEOUT_MS}ms. Pane:\n${content}`);
  }

  const session: LiveSession = {
    sessionName: name,
    agent,
    port,

    type: (text: string) => {
      // tmux send-keys with literal flag to handle special characters
      tmux("send-keys", "-t", name, "-l", text);
    },

    submit: () => {
      tmux("send-keys", "-t", name, "Enter");
    },

    escape: () => {
      tmux("send-keys", "-t", name, "Escape");
    },

    interrupt: () => {
      tmux("send-keys", "-t", name, "C-c");
    },

    sendKeys: (keys: string) => {
      tmux("send-keys", "-t", name, keys);
    },

    capture: () => {
      return tmux("capture-pane", "-t", name, "-p");
    },

    state: () => {
      const content = tmuxSafe("capture-pane", "-t", name, "-p");
      if (!content) return "exited";
      return detectState(content);
    },

    waitForIdle: async (timeoutMs = DEFAULT_IDLE_TIMEOUT_MS) => {
      const deadline = Date.now() + timeoutMs;
      // Phase 1: wait briefly for Claude to leave idle (start processing).
      // Cap at 5s — if Claude processes instantly, skip this phase.
      const leaveIdleDeadline = Math.min(Date.now() + 5_000, deadline);
      while (Date.now() < leaveIdleDeadline) {
        const s = session.state();
        if (s === "exited") throw new Error("Claude exited unexpectedly");
        if (s !== "idle") break;
        await sleep(200);
      }
      // Phase 2: wait for idle to return (response complete)
      while (Date.now() < deadline) {
        const s = session.state();
        if (s === "idle") return;
        if (s === "exited") throw new Error("Claude exited unexpectedly");
        if (s === "permission") throw new Error("Claude is waiting for permission — use --dangerously-skip-permissions or handle the prompt");
        await sleep(POLL_INTERVAL_MS);
      }
      const content = session.capture();
      throw new Error(`Claude did not reach idle state within ${timeoutMs}ms. State: ${session.state()}. Pane:\n${content}`);
    },

    waitForExit: async (timeoutMs = DEFAULT_IDLE_TIMEOUT_MS) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!sessionExists(name)) return;
        const s = session.state();
        if (s === "exited") return;
        await sleep(POLL_INTERVAL_MS);
      }
      throw new Error(`Claude did not exit within ${timeoutMs}ms`);
    },

    waitForText: async (text: string, timeoutMs = DEFAULT_IDLE_TIMEOUT_MS) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const content = session.capture();
        if (content.includes(text)) return content;
        await sleep(POLL_INTERVAL_MS);
      }
      const content = session.capture();
      throw new Error(`Text "${text}" not found within ${timeoutMs}ms. Pane:\n${content}`);
    },

    db: () => {
      const dbPath = getAgentDbPath(agent);
      const db = openDb(dbPath);
      initSchema(db);
      return db;
    },

    proxyLog: () => {
      try {
        const logPath = join(homedir(), ".spotless", "spotless.log");
        return readFileSync(logPath, "utf-8");
      } catch { return ""; }
    },

    cleanup: (deleteDb = true) => {
      // Kill tmux session
      if (sessionExists(name)) {
        killSession(name);
      }
      // Delete agent DB
      if (deleteDb) {
        const agentDir = join(homedir(), ".spotless", "agents", agent);
        try { rmSync(agentDir, { recursive: true }); } catch { /* ok */ }
      }
    },
  };

  return session;
}

/**
 * Clean up all e2e test resources. Call in afterAll().
 */
export function cleanupAll(): void {
  // Kill any e2e tmux sessions
  const sessions = tmuxSafe("list-sessions", "-F", "#{session_name}");
  if (sessions) {
    for (const name of sessions.trim().split("\n")) {
      if (name.startsWith("spotless-e2e-")) {
        killSession(name);
      }
    }
  }
  stopProxy();
}
