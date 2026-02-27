#!/usr/bin/env bun
/**
 * Spotless CLI entry point.
 *
 * Usage:
 *   spotless start [--port 9000] [--no-dream]
 *   spotless stop
 *   spotless status
 *   spotless code [--agent <name>] [--port 9000] [-- ...claude args]
 *   spotless agents
 *   spotless dream [--agent <name>] [--dry-run] [--model haiku|sonnet]
 *   spotless repair [--agent <name>] [--purge-eidetic] [--fix]
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { startProxy } from "./proxy.ts";
import { generateAgentName, validateAgentName, listAgents } from "./agent.ts";
import { createDreamLoop } from "./dream-loop.ts";
import { runDreamPass } from "./dreamer.ts";
import { diagnose, purgeEidetic, repairEidetic } from "./repair.ts";

const SPOTLESS_DIR = join(homedir(), ".spotless");
const PID_FILE = join(SPOTLESS_DIR, "spotless.pid");
const DEFAULT_PORT = 9000;

function cmdHelp(): void {
  console.log(`
  spotless — neuromorphic memory for Claude Code

  COMMANDS

    spotless start [--port 9000] [--no-dream]
        Start the proxy. Listens for Claude Code requests and archives
        everything to per-agent SQLite. Background dreaming runs every 5m
        unless --no-dream is passed.

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

    spotless dream [--agent <name>] [--dry-run] [--model haiku|sonnet]
        Run a dream pass (memory consolidation). Dreams all agents if
        --agent is omitted.

    spotless repair [--agent <name>] [--purge-eidetic] [--fix]
        Diagnose and repair agent database corruption.
        Without flags: runs diagnostics and reports issues.
        --fix: targeted repair (remove leaked subagent boundaries
               and dead retry sessions from eidetic archive).
        --purge-eidetic: nuclear option — clears ALL raw events
               while preserving memories, identity, and associations.

    spotless help
        Show this help.

  DASHBOARD

    Open http://localhost:<port>/_dashboard/ in a browser while the
    proxy is running to browse agent memories, identity, dream passes,
    hippocampus runs, and raw eidetic events.

  EXAMPLES

    spotless start                          # start proxy on port 9000
    spotless code --agent wren              # launch claude as agent "wren"
    spotless code                           # pick or create an agent interactively
    spotless code --agent wren -- -p "hi"   # non-interactive prompt mode
    spotless dream --agent wren             # consolidate wren's memories
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
  noDream: boolean;
  dryRun: boolean;
  model: string | null;
  purgeEidetic: boolean;
  fix: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const command = args[0] ?? "help";
  let port = DEFAULT_PORT;
  let agent: string | null = null;
  let claudeArgs: string[] = [];
  let noDream = false;
  let dryRun = false;
  let model: string | null = null;
  let purgeEidetic = false;
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
    } else if (spotlessArgs[i] === "--no-dream") {
      noDream = true;
    } else if (spotlessArgs[i] === "--dry-run") {
      dryRun = true;
    } else if (spotlessArgs[i] === "--purge-eidetic") {
      purgeEidetic = true;
    } else if (spotlessArgs[i] === "--fix") {
      fix = true;
    } else if (spotlessArgs[i] === "--model" && spotlessArgs[i + 1]) {
      model = spotlessArgs[i + 1]!;
      i++;
    }
  }

  return { command, port, agent, claudeArgs, noDream, dryRun, model, purgeEidetic, fix };
}

// --- Commands ---

function cmdStart(port: number, noDream: boolean): void {
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

  // Start background dreaming unless disabled
  let dreamLoop: ReturnType<typeof createDreamLoop> | null = null;
  if (!noDream) {
    dreamLoop = createDreamLoop();
    dreamLoop.start(() => proxy.getAgentNames());

    // Wire trim-triggered dreaming: when eidetic budget drops messages, dream immediately
    proxy.onEideticTrimmed = (agentName: string) => {
      dreamLoop!.triggerNow(agentName).catch(err => {
        console.error(`[dream] Trim-triggered dream error for ${agentName}:`, err);
      });
    };
  }

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n[spotless] Shutting down...");
    if (dreamLoop) dreamLoop.stop();
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

async function cmdDream(agentArg: string | null, dryRun: boolean, model: string | null): Promise<void> {
  if (!agentArg) {
    // Dream all agents
    const agents = listAgents();
    if (agents.length === 0) {
      console.log("[spotless] No agents found");
      return;
    }
    for (const agent of agents) {
      console.log(`[spotless] Dreaming: ${agent.name}`);
      const result = await runDreamPass({
        agentName: agent.name,
        model: model ?? "haiku",
        dryRun,
      });
      printDreamResult(agent.name, result);
    }
  } else {
    if (!validateAgentName(agentArg)) {
      console.error(`[spotless] Invalid agent name: "${agentArg}"`);
      process.exit(1);
    }
    console.log(`[spotless] Dreaming: ${agentArg}`);
    const result = await runDreamPass({
      agentName: agentArg,
      model: model ?? "haiku",
      dryRun,
    });
    printDreamResult(agentArg, result);
  }
}

function printDreamResult(agentName: string, result: import("./types.ts").DreamResult): void {
  console.log(`[spotless] ${agentName}: ${result.operationsRequested} ops requested, ${result.operationsExecuted} executed`);
  console.log(`  memories: +${result.memoriesCreated} created, ${result.memoriesMerged} merged, -${result.memoriesPruned} pruned`);
  console.log(`  associations: +${result.associationsCreated}`);
  console.log(`  duration: ${result.durationMs}ms`);
  if (result.errors.length > 0) {
    console.error(`  errors: ${result.errors.join("; ")}`);
  }
}

function cmdRepair(agentArg: string | null, purgeEideticFlag: boolean, fixFlag: boolean): void {
  if (!agentArg) {
    // Diagnose all agents
    const agents = listAgents();
    if (agents.length === 0) {
      console.log("[spotless] No agents found");
      return;
    }
    for (const a of agents) {
      runDiagnostics(a.name, purgeEideticFlag, fixFlag);
    }
  } else {
    if (!validateAgentName(agentArg)) {
      console.error(`[spotless] Invalid agent name: "${agentArg}"`);
      process.exit(1);
    }
    runDiagnostics(agentArg, purgeEideticFlag, fixFlag);
  }
}

function runDiagnostics(agentName: string, purgeEideticFlag: boolean, fixFlag: boolean): void {
  console.log(`\n[spotless] Diagnosing: ${agentName}`);

  const report = diagnose(agentName);

  // Print Tier 1 stats
  console.log(`  Tier 1 (eidetic archive):`);
  console.log(`    events: ${report.tier1.totalEvents}  groups: ${report.tier1.totalGroups}  boundaries: ${report.tier1.sessionBoundaries}`);

  // Print Tier 2 stats
  console.log(`  Tier 2 (engram network):`);
  console.log(`    memories: ${report.tier2.memories}  associations: ${report.tier2.associations}  identity nodes: ${report.tier2.identityNodes}`);
  console.log(`    dream passes: ${report.tier2.dreamPasses}  hippocampus runs: ${report.tier2.hippocampusRuns}`);

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
  if (fixFlag && !purgeEideticFlag) {
    if (report.issues.length === 0) {
      console.log(`  Nothing to fix.`);
      return;
    }
    console.log(`  Repairing...`);
    const result = repairEidetic(agentName);
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
      console.log(`  If issues persist, try --purge-eidetic to clear Tier 1 (memories are preserved).`);
    }
    return;
  }

  // Nuclear option: purge eidetic
  if (purgeEideticFlag) {
    console.log(`  Purging eidetic archive (preserving Tier 2 memories + identity)...`);
    const result = purgeEidetic(agentName);
    console.log(`  Deleted ${result.eventsDeleted} raw events. Tier 2 intact.`);
    console.log(`  Agent will start with a clean conversation history.`);
    return;
  }

  // Just diagnostics — suggest actions
  if (report.issues.length > 0) {
    console.log(`\n  To attempt targeted repair: spotless repair --agent ${agentName} --fix`);
    console.log(`  To clear Tier 1 entirely:   spotless repair --agent ${agentName} --purge-eidetic`);
  }
}

// --- Main ---

const { command, port, agent, claudeArgs, noDream, dryRun, model, purgeEidetic: purgeEideticFlag, fix: fixFlag } = parseArgs(process.argv.slice(2));

switch (command) {
  case "start":
    cmdStart(port, noDream);
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
  case "dream":
    await cmdDream(agent, dryRun, model);
    break;
  case "repair":
    cmdRepair(agent, purgeEideticFlag, fixFlag);
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
