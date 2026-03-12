#!/usr/bin/env bun
/**
 * Spotless CLI entry point.
 *
 * Usage:
 *   spotless start [--port 9000] [--no-digest]
 *   spotless stop
 *   spotless status
 *   spotless code [--agent <name>] [--port 9000] [-- ...claude args]
 *   spotless agents
 *   spotless digest [--agent <name>] [--dry-run] [--model haiku|sonnet]
 *   spotless logs [--agent <name>]
 *   spotless repair [--agent <name>] [--purge-history] [--fix]
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { startProxy } from "./proxy.ts";
import { generateAgentName, validateAgentName, listAgents, getAgentDbPath } from "./agent.ts";
import { createDigestLoop } from "./digest-loop.ts";
import { runDigestPass } from "./digester.ts";
import { diagnose, purgeHistory, repairHistory } from "./repair.ts";
import { LOG_FILE } from "./logger.ts";
import { Database } from "bun:sqlite";

const SPOTLESS_DIR = join(homedir(), ".spotless");
const PID_FILE = join(SPOTLESS_DIR, "spotless.pid");
const DEFAULT_PORT = 9000;

function cmdHelp(): void {
  console.log(`
  spotless — persistent memory for Claude Code

  COMMANDS

    spotless start [--port 9000] [--no-digest]
        Start the proxy. Listens for Claude Code requests and archives
        everything to per-agent SQLite. Background digesting runs every 5m
        unless --no-digest is passed.

    spotless stop
        Stop the running proxy.

    spotless status
        Check if the proxy is running.

    spotless code [--agent <name>] [--port 9000] [-- ...claude args]
        Launch Claude Code through the proxy. If --agent is omitted,
        interactively choose an existing agent or create a new one.
        Auto-starts the proxy if not running.

    spotless agents
        List all agents with DB sizes.

    spotless digest [--agent <name>] [--dry-run] [--model haiku|sonnet]
        Run a digest pass (memory consolidation). Digests all agents if
        --agent is omitted.

    spotless logs [--agent <name>]
        Collect proxy logs and agent diagnostics into a single file
        for bug reports. Saves to ~/.spotless/spotless-report-<date>.txt

    spotless repair [--agent <name>] [--purge-history] [--fix]
        Diagnose and repair agent database corruption.
        Without flags: runs diagnostics and reports issues.
        --fix: targeted repair (remove leaked subagent boundaries
               and dead retry sessions from history archive).
        --purge-history: nuclear option — clears ALL raw events
               while preserving memories, identity, and associations.

    spotless help
        Show this help.

  DASHBOARD

    Open http://localhost:<port>/_dashboard/ in a browser while the
    proxy is running to browse agent memories, identity, digest passes,
    selector runs, and raw history events.

  EXAMPLES

    spotless start                          # start proxy on port 9000
    spotless code --agent wren              # launch claude as agent "wren"
    spotless code                           # pick or create an agent interactively
    spotless code --agent wren -- -p "hi"   # non-interactive prompt mode
    spotless digest --agent wren             # consolidate wren's memories
    spotless agents                         # list all agents
`.trimStart());
}

function ensureDir(): void {
  mkdirSync(SPOTLESS_DIR, { recursive: true });
}

function writePid(port: number): void {
  ensureDir();
  writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, port }));
}

function readPid(): { pid: number; port: number } | null {
  try {
    if (!existsSync(PID_FILE)) return null;
    return JSON.parse(readFileSync(PID_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function removePid(): void {
  try {
    unlinkSync(PID_FILE);
  } catch {
    // Already gone
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface ParsedArgs {
  command: string;
  port: number;
  agent: string | null;
  claudeArgs: string[];
  noDigest: boolean;
  dryRun: boolean;
  model: string | null;
  purgeHistory: boolean;
  fix: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const command = args[0] ?? "help";
  let port = DEFAULT_PORT;
  let agent: string | null = null;
  let claudeArgs: string[] = [];
  let noDigest = false;
  let dryRun = false;
  let model: string | null = null;
  let purgeHistory = false;
  let fix = false;

  // Split on -- to separate spotless args from claude args
  const dashDashIdx = args.indexOf("--");
  const spotlessArgs = dashDashIdx === -1 ? args.slice(1) : args.slice(1, dashDashIdx);
  if (dashDashIdx !== -1) {
    claudeArgs = args.slice(dashDashIdx + 1);
  }

  for (let i = 0; i < spotlessArgs.length; i++) {
    if (spotlessArgs[i] === "--port" && spotlessArgs[i + 1]) {
      port = parseInt(spotlessArgs[i + 1]!, 10);
      if (isNaN(port)) port = DEFAULT_PORT;
      i++;
    } else if (spotlessArgs[i] === "--agent" && spotlessArgs[i + 1]) {
      agent = spotlessArgs[i + 1]!;
      i++;
    } else if (spotlessArgs[i] === "--no-digest") {
      noDigest = true;
    } else if (spotlessArgs[i] === "--dry-run") {
      dryRun = true;
    } else if (spotlessArgs[i] === "--purge-history") {
      purgeHistory = true;
    } else if (spotlessArgs[i] === "--fix") {
      fix = true;
    } else if (spotlessArgs[i] === "--model" && spotlessArgs[i + 1]) {
      model = spotlessArgs[i + 1]!;
      i++;
    }
  }

  return { command, port, agent, claudeArgs, noDigest, dryRun, model, purgeHistory, fix };
}

// --- Commands ---

function cmdStart(port: number, noDigest: boolean): void {
  // Check for existing instance
  const existing = readPid();
  if (existing && isProcessRunning(existing.pid)) {
    console.error(`[spotless] Already running (pid ${existing.pid}, port ${existing.port})`);
    process.exit(1);
  }

  // Clean up stale PID file
  if (existing) removePid();

  const proxy = startProxy({ port });
  writePid(port);

  // Start background digesting unless disabled
  let digestLoop: ReturnType<typeof createDigestLoop> | null = null;
  if (!noDigest) {
    digestLoop = createDigestLoop();
    digestLoop.start(() => proxy.getAgentNames());

    // Wire trim-triggered digesting: when pressure is high and trim occurred, escalate
    proxy.onHistoryTrimmed = (agentName: string) => {
      digestLoop!.escalate(agentName);
    };
  }

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n[spotless] Shutting down...");
    if (digestLoop) digestLoop.stop();
    proxy.stop();
    removePid();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function cmdStop(): void {
  const info = readPid();
  if (!info) {
    console.log("[spotless] Not running");
    return;
  }

  if (!isProcessRunning(info.pid)) {
    console.log("[spotless] Not running (stale PID file)");
    removePid();
    return;
  }

  try {
    process.kill(info.pid, "SIGTERM");
    console.log(`[spotless] Stopped (pid ${info.pid})`);
  } catch (err) {
    console.error(`[spotless] Failed to stop: ${err}`);
  }
  removePid();
}

function cmdStatus(): void {
  const info = readPid();
  if (!info) {
    console.log("[spotless] Not running");
    return;
  }

  if (!isProcessRunning(info.pid)) {
    console.log("[spotless] Not running (stale PID file)");
    removePid();
    return;
  }

  console.log(`[spotless] Running (pid ${info.pid}, port ${info.port})`);
}

/**
 * Read a line from stdin using node:readline.
 * Properly manages terminal state so stdin is clean for child processes.
 */
async function readLine(promptText: string): Promise<string> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Interactive agent picker. Shows existing agents numbered, plus option to create new.
 */
async function pickAgent(): Promise<string> {
  const agents = listAgents();

  console.log("\n  Select an agent:\n");

  if (agents.length > 0) {
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i]!;
      const sizeMB = (a.sizeBytes / (1024 * 1024)).toFixed(1);
      console.log(`    ${(i + 1).toString().padStart(2)})  ${a.name.padEnd(24)} ${sizeMB} MB`);
    }
    console.log();
  }

  const newIdx = agents.length + 1;
  const newName = generateAgentName();
  console.log(`    ${newIdx.toString().padStart(2)})  + create new ("${newName}")`);
  console.log();

  const answer = await readLine("  Enter number or agent name: ");

  if (!answer) {
    console.error("[spotless] No selection made");
    process.exit(1);
  }

  // Check if it's a number
  const num = parseInt(answer, 10);
  if (!isNaN(num) && num >= 1 && num <= agents.length) {
    return agents[num - 1]!.name;
  }
  if (num === newIdx) {
    return newName;
  }

  // Check if it's a valid agent name typed directly
  if (validateAgentName(answer)) {
    return answer;
  }

  console.error(`[spotless] Invalid selection: "${answer}"`);
  process.exit(1);
}

async function cmdCode(port: number, agentArg: string | null, claudeArgs: string[]): Promise<void> {
  // Resolve agent name — interactive if not provided
  let agentName: string;
  if (agentArg) {
    agentName = agentArg;
  } else {
    agentName = await pickAgent();
  }

  if (!validateAgentName(agentName)) {
    console.error(`[spotless] Invalid agent name: "${agentName}" (lowercase alphanumeric + hyphens, 1-32 chars)`);
    process.exit(1);
  }

  // Ensure proxy is running
  let proxyPort = port;
  const existing = readPid();
  if (existing && isProcessRunning(existing.pid)) {
    proxyPort = existing.port;
  } else {
    // Clean up stale PID file
    if (existing) removePid();

    // Start proxy in background
    console.error(`[spotless] Starting proxy on port ${port}...`);
    const selfPath = process.argv[1] ?? "spotless";
    const child = Bun.spawn(["bun", "run", selfPath, "start", "--port", String(port)], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.unref();
    // Give the proxy a moment to bind
    await new Promise((r) => setTimeout(r, 500));
    proxyPort = port;
  }

  const baseUrl = `http://localhost:${proxyPort}/agent/${agentName}`;
  console.error(`[spotless] Agent: ${agentName}`);
  console.error(`[spotless] ${baseUrl}`);

  // Exec claude with the right ANTHROPIC_BASE_URL
  const proc = Bun.spawn(["claude", ...claudeArgs], {
    stdio: ["inherit", "inherit", "inherit"],
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: baseUrl,
    },
  });

  const exitCode = await proc.exited;
  process.exit(exitCode);
}

function cmdAgents(): void {
  const agents = listAgents();
  if (agents.length === 0) {
    console.log("[spotless] No agents found");
    return;
  }

  console.log(`[spotless] ${agents.length} agent(s):\n`);
  for (const agent of agents) {
    const sizeMB = (agent.sizeBytes / (1024 * 1024)).toFixed(2);
    console.log(`  ${agent.name.padEnd(34)} ${sizeMB} MB  ${agent.dbPath}`);
  }
}

async function cmdDigest(agentArg: string | null, dryRun: boolean, model: string | null): Promise<void> {
  if (!agentArg) {
    // Digest all agents
    const agents = listAgents();
    if (agents.length === 0) {
      console.log("[spotless] No agents found");
      return;
    }
    for (const agent of agents) {
      console.log(`[spotless] Digesting: ${agent.name}`);
      const result = await runDigestPass({
        agentName: agent.name,
        model: model ?? "haiku",
        dryRun,
      });
      printDigestResult(agent.name, result);
    }
  } else {
    if (!validateAgentName(agentArg)) {
      console.error(`[spotless] Invalid agent name: "${agentArg}"`);
      process.exit(1);
    }
    console.log(`[spotless] Digesting: ${agentArg}`);
    const result = await runDigestPass({
      agentName: agentArg,
      model: model ?? "haiku",
      dryRun,
    });
    printDigestResult(agentArg, result);
  }
}

function printDigestResult(agentName: string, result: import("./types.ts").DigestResult): void {
  console.log(`[spotless] ${agentName}: ${result.operationsRequested} ops requested, ${result.operationsExecuted} executed`);
  console.log(`  memories: +${result.memoriesCreated} created, ${result.memoriesMerged} merged, ${result.memoriesSuperseded} superseded`);
  console.log(`  associations: +${result.associationsCreated}`);
  console.log(`  duration: ${result.durationMs}ms`);
  if (result.errors.length > 0) {
    console.error(`  errors: ${result.errors.join("; ")}`);
  }
}

function cmdRepair(agentArg: string | null, purgeHistoryFlag: boolean, fixFlag: boolean): void {
  if (!agentArg) {
    // Diagnose all agents
    const agents = listAgents();
    if (agents.length === 0) {
      console.log("[spotless] No agents found");
      return;
    }
    for (const a of agents) {
      runDiagnostics(a.name, purgeHistoryFlag, fixFlag);
    }
  } else {
    if (!validateAgentName(agentArg)) {
      console.error(`[spotless] Invalid agent name: "${agentArg}"`);
      process.exit(1);
    }
    runDiagnostics(agentArg, purgeHistoryFlag, fixFlag);
  }
}

function runDiagnostics(agentName: string, purgeHistoryFlag: boolean, fixFlag: boolean): void {
  console.log(`\n[spotless] Diagnosing: ${agentName}`);

  const report = diagnose(agentName);

  // Print Tier 1 stats
  console.log(`  Tier 1 (history archive):`);
  console.log(`    events: ${report.tier1.totalEvents}  groups: ${report.tier1.totalGroups}  boundaries: ${report.tier1.sessionBoundaries}`);

  // Print Tier 2 stats
  console.log(`  Tier 2 (memory graph):`);
  console.log(`    memories: ${report.tier2.memories}  associations: ${report.tier2.associations}  identity nodes: ${report.tier2.identityNodes}`);
  console.log(`    digest passes: ${report.tier2.digestPasses}  selector runs: ${report.tier2.selectorRuns}`);

  // Print issues
  if (report.issues.length === 0) {
    console.log(`  Status: healthy`);
  } else {
    console.log(`  Issues found: ${report.issues.length}`);
    for (const issue of report.issues) {
      console.log(`    - ${issue}`);
    }
  }

  // Targeted repair
  if (fixFlag && !purgeHistoryFlag) {
    if (report.issues.length === 0) {
      console.log(`  Nothing to fix.`);
      return;
    }
    console.log(`  Repairing...`);
    const result = repairHistory(agentName);
    console.log(`    boundaries removed: ${result.boundariesRemoved}`);
    console.log(`    dead sessions removed: ${result.deadSessionsRemoved}`);

    // Re-diagnose to confirm
    const after = diagnose(agentName);
    if (after.issues.length === 0) {
      console.log(`  Status after repair: healthy`);
    } else {
      console.log(`  Remaining issues: ${after.issues.length}`);
      for (const issue of after.issues) {
        console.log(`    - ${issue}`);
      }
      console.log(`  If issues persist, try --purge-history to clear Tier 1 (memories are preserved).`);
    }
    return;
  }

  // Nuclear option: purge history
  if (purgeHistoryFlag) {
    console.log(`  Purging history archive (preserving Tier 2 memories + identity)...`);
    const result = purgeHistory(agentName);
    console.log(`  Deleted ${result.eventsDeleted} raw events. Tier 2 intact.`);
    console.log(`  Agent will start with a clean conversation history.`);
    return;
  }

  // Just diagnostics — suggest actions
  if (report.issues.length > 0) {
    console.log(`\n  To attempt targeted repair: spotless repair --agent ${agentName} --fix`);
    console.log(`  To clear Tier 1 entirely:   spotless repair --agent ${agentName} --purge-history`);
  }
}

function cmdLogs(agentArg: string | null): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = join(SPOTLESS_DIR, `spotless-report-${timestamp}.txt`);
  const lines: string[] = [];

  lines.push(`Spotless Bug Report — ${new Date().toISOString()}`);
  lines.push(`${"=".repeat(60)}\n`);

  // Include proxy log file
  lines.push("## Proxy Log (last 200 lines)\n");
  try {
    if (existsSync(LOG_FILE)) {
      const logContent = readFileSync(LOG_FILE, "utf-8");
      const logLines = logContent.split("\n");
      const tail = logLines.slice(-200);
      lines.push(tail.join("\n"));
    } else {
      lines.push("(no log file found)");
    }
  } catch (e: unknown) {
    lines.push(`(error reading log: ${e})`);
  }
  lines.push("");

  // Include agent diagnostics
  const targetAgents = agentArg
    ? [{ name: agentArg }]
    : listAgents();

  if (targetAgents.length === 0) {
    lines.push("## Agents\n\n(none found)");
  } else {
    for (const agent of targetAgents) {
      lines.push(`\n## Agent: ${agent.name}\n`);
      try {
        const report = diagnose(agent.name);
        lines.push(`Tier 1: events=${report.tier1.totalEvents} groups=${report.tier1.totalGroups} boundaries=${report.tier1.sessionBoundaries}`);
        lines.push(`Tier 2: memories=${report.tier2.memories} associations=${report.tier2.associations} identity_nodes=${report.tier2.identityNodes}`);
        lines.push(`Digest passes: ${report.tier2.digestPasses}  Selector runs: ${report.tier2.selectorRuns}`);
        if (report.issues.length > 0) {
          lines.push(`Issues: ${report.issues.join("; ")}`);
        } else {
          lines.push("Status: healthy");
        }

        // Check for malformed tool_use content
        try {
          const dbPath = getAgentDbPath(agent.name);
          const db = new Database(dbPath, { readonly: true });
          const toolUseRows = db.query(
            "SELECT id, content, metadata FROM raw_events WHERE content_type = 'tool_use'"
          ).all() as { id: number; content: string; metadata: string | null }[];
          let badCount = 0;
          for (const row of toolUseRows) {
            try {
              const parsed = JSON.parse(row.content);
              if (typeof parsed !== "object" || parsed === null) {
                lines.push(`  BAD tool_use id=${row.id}: parsed as ${typeof parsed}`);
                badCount++;
              }
            } catch {
              lines.push(`  BAD tool_use id=${row.id}: JSON parse failed, content=${JSON.stringify(row.content).slice(0, 100)}`);
              badCount++;
            }
          }
          lines.push(`Tool_use rows: ${toolUseRows.length} total, ${badCount} malformed`);
          db.close();
        } catch (e: unknown) {
          lines.push(`  (error checking tool_use rows: ${e})`);
        }
      } catch (e: unknown) {
        lines.push(`  (error diagnosing: ${e})`);
      }
    }
  }

  ensureDir();
  writeFileSync(outPath, lines.join("\n"));
  console.log(`[spotless] Report saved to ${outPath}`);
}

// --- Main ---

const { command, port, agent, claudeArgs, noDigest, dryRun, model, purgeHistory: purgeHistoryFlag, fix: fixFlag } = parseArgs(process.argv.slice(2));

switch (command) {
  case "start":
    cmdStart(port, noDigest);
    break;
  case "stop":
    cmdStop();
    break;
  case "status":
    cmdStatus();
    break;
  case "code":
    await cmdCode(port, agent, claudeArgs);
    break;
  case "agents":
    cmdAgents();
    break;
  case "digest":
    await cmdDigest(agent, dryRun, model);
    break;
  case "logs":
    cmdLogs(agent);
    break;
  case "repair":
    cmdRepair(agent, purgeHistoryFlag, fixFlag);
    break;
  case "help":
  case "--help":
  case "-h":
    cmdHelp();
    break;
  default:
    console.error(`Unknown command: ${command}\n`);
    cmdHelp();
    process.exit(1);
}
