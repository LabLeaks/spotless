/**
 * Agent name resolution and storage paths.
 *
 * Memory belongs to a named agent, not a project directory.
 * The agent name comes from the URL subpath: /agent/<name>/v1/messages
 * Storage lives at ~/.spotless/agents/<name>/spotless.db
 */

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const AGENTS_DIR = join(homedir(), ".spotless", "agents");

const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const AGENT_PREFIX_RE = /^\/agent\/([a-z0-9][a-z0-9-]{0,31})(\/.*)?$/;

/**
 * Whimsical nature/mythology names for auto-generated agents.
 */
const WHIMSICAL_NAMES = [
  "wren", "finch", "heron", "cedar", "moss", "fern", "sage", "ember", "brook",
  "lark", "aspen", "briar", "coral", "dusk", "flint", "grove", "hazel", "ivy",
  "jade", "kite", "lotus", "maple", "nova", "onyx", "pearl", "quill", "rain",
  "sparrow", "thorn", "umber", "vale", "willow", "yarrow", "zephyr", "alder",
  "birch", "clover", "daisy", "elm", "fox", "gale", "holly", "iris", "juniper",
  "kelp", "lichen", "mist", "nettle", "oak", "pine", "reed", "stone", "thistle",
  "urchin", "vine", "woad", "yew", "ash", "bay", "crag", "dell", "eider",
  "frost", "glen", "hawk", "ibis", "jay", "knot", "linden", "marl", "nix",
  "osprey", "plover", "quartz", "robin", "swift", "tern", "vole", "warbler",
  "swift", "opal", "rune", "dune", "cliff", "marsh", "thyme", "basil", "mint",
  "rowan", "sorrel", "tansy", "whin", "avens", "brant", "crane", "dove", "egret",
  "fawn", "grouse", "hare",
];

/**
 * Extract agent name from a request URL path.
 * /agent/wren/v1/messages → "wren"
 * /v1/messages → null (no agent prefix)
 */
export function parseAgentFromUrl(pathname: string): string | null {
  const match = pathname.match(AGENT_PREFIX_RE);
  return match?.[1] ?? null;
}

/**
 * Strip the /agent/<name> prefix from a URL path for forwarding to Anthropic.
 * /agent/wren/v1/messages → /v1/messages
 * /v1/messages → /v1/messages (unchanged)
 */
export function stripAgentPrefix(pathname: string): string {
  const match = pathname.match(AGENT_PREFIX_RE);
  if (match?.[2]) return match[2];
  if (match) return "/";
  return pathname;
}

/**
 * Get the full path to the SQLite database for an agent.
 * Creates the directory if needed.
 */
export function getAgentDbPath(agentName: string): string {
  const dir = join(AGENTS_DIR, agentName);
  mkdirSync(dir, { recursive: true });
  return join(dir, "spotless.db");
}

/**
 * Validate an agent name: lowercase alphanumeric + hyphens, 1-32 chars.
 * Must start with alphanumeric (not hyphen).
 */
export function validateAgentName(name: string): boolean {
  return AGENT_NAME_RE.test(name);
}

/**
 * Generate a random unused whimsical agent name.
 * Falls back to name + random suffix if all base names are taken.
 */
export function generateAgentName(): string {
  const existing = new Set<string>();
  try {
    if (existsSync(AGENTS_DIR)) {
      for (const entry of readdirSync(AGENTS_DIR)) {
        existing.add(entry);
      }
    }
  } catch {
    // Directory doesn't exist yet — all names available
  }

  // Shuffle and pick first unused
  const shuffled = [...WHIMSICAL_NAMES].sort(() => Math.random() - 0.5);
  for (const name of shuffled) {
    if (!existing.has(name)) return name;
  }

  // All base names taken — append random suffix
  const base = shuffled[0]!;
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${base}-${suffix}`;
}

/**
 * List all agents with metadata.
 */
export function listAgents(): { name: string; dbPath: string; sizeBytes: number }[] {
  if (!existsSync(AGENTS_DIR)) return [];

  const agents: { name: string; dbPath: string; sizeBytes: number }[] = [];
  for (const entry of readdirSync(AGENTS_DIR)) {
    const dbPath = join(AGENTS_DIR, entry, "spotless.db");
    if (!existsSync(dbPath)) continue;

    try {
      const stat = statSync(dbPath);
      agents.push({ name: entry, dbPath, sizeBytes: stat.size });
    } catch {
      // Skip unreadable entries
    }
  }

  return agents.sort((a, b) => a.name.localeCompare(b.name));
}
