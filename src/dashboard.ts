/**
 * Web dashboard: route handler, JSON API, HTML page renderers.
 *
 * Served from /_dashboard/ on the same Bun.serve() as the proxy.
 * All database access is read-only (opened per request, closed after).
 * No external dependencies — inline HTML/CSS/JS via template literals.
 */

import type { Database } from "bun:sqlite";
import { listAgents } from "./agent.ts";
import { openReadonlyDb } from "./db.ts";
import { queryMemories, getAssociations } from "./digest-tools.ts";
import { getIdentityNodes } from "./recall.ts";
import type { AgentContext, ProxyStats } from "./proxy.ts";
import { getConsolidationStatus, getConsolidationPressure, getPressureLevel } from "./consolidation.ts";

// --- Route handler ---

/**
 * Handle a dashboard request. Returns Response for dashboard paths, null otherwise.
 */
export function handleDashboardRequest(
  url: URL,
  agents: Map<string, AgentContext>,
  stats: ProxyStats,
): Response | null {
  const path = url.pathname;

  // API endpoints
  if (path === "/_dashboard/api/status") {
    return jsonResponse(apiStatus(stats));
  }

  if (path === "/_dashboard/api/agents") {
    return jsonResponse(apiAgents());
  }

  // Agent-specific API routes: /_dashboard/api/agent/:name/...
  const agentApiMatch = path.match(/^\/_dashboard\/api\/agent\/([a-z0-9][a-z0-9-]{0,31})\/(.+)$/);
  if (agentApiMatch) {
    const [, agentName, sub] = agentApiMatch;
    const dbPath = findAgentDbPath(agentName!);
    if (!dbPath) return jsonResponse({ error: "Agent not found" }, 404);

    let db: Database;
    try {
      db = openReadonlyDb(dbPath);
    } catch {
      return jsonResponse({ error: "Could not open agent database" }, 500);
    }

    try {
      if (sub === "memories") {
        const q = url.searchParams.get("q") || undefined;
        const minSalience = url.searchParams.has("min_salience")
          ? parseFloat(url.searchParams.get("min_salience")!)
          : undefined;
        const limit = url.searchParams.has("limit")
          ? parseInt(url.searchParams.get("limit")!, 10)
          : 100;
        const includeArchived = url.searchParams.get("include_archived") === "true";
        return jsonResponse(apiAgentMemories(db, q, minSalience, limit, includeArchived));
      }

      // Single memory: /_dashboard/api/agent/:name/memory/:id
      const memoryMatch = sub!.match(/^memory\/(\d+)$/);
      if (memoryMatch) {
        const memId = parseInt(memoryMatch[1]!, 10);
        return jsonResponse(apiAgentMemory(db, memId));
      }

      if (sub === "identity") {
        return jsonResponse(apiAgentIdentity(db));
      }

      if (sub === "digests") {
        const limit = url.searchParams.has("limit")
          ? parseInt(url.searchParams.get("limit")!, 10)
          : 50;
        return jsonResponse(apiAgentDigests(db, limit));
      }

      if (sub === "selector") {
        const limit = url.searchParams.has("limit")
          ? parseInt(url.searchParams.get("limit")!, 10)
          : 50;
        return jsonResponse(apiAgentSelector(db, limit));
      }

      if (sub === "history") {
        const limit = url.searchParams.has("limit")
          ? parseInt(url.searchParams.get("limit")!, 10)
          : 200;
        const offset = url.searchParams.has("offset")
          ? parseInt(url.searchParams.get("offset")!, 10)
          : 0;
        const q = url.searchParams.get("q") || undefined;
        return jsonResponse(apiAgentHistory(db, limit, offset, q));
      }

      if (sub === "consolidation") {
        return jsonResponse(apiAgentConsolidation(db));
      }

      if (sub === "context") {
        return jsonResponse(apiAgentContext(db));
      }

      return jsonResponse({ error: "Unknown endpoint" }, 404);
    } finally {
      db.close();
    }
  }

  // HTML pages
  if (path === "/_dashboard" || path === "/_dashboard/") {
    return htmlResponse(renderIndexPage(stats));
  }

  const agentPageMatch = path.match(/^\/_dashboard\/agent\/([a-z0-9][a-z0-9-]{0,31})\/?$/);
  if (agentPageMatch) {
    const agentName = agentPageMatch[1]!;
    const dbPath = findAgentDbPath(agentName);
    if (!dbPath) return htmlResponse(render404Page(agentName));
    return htmlResponse(renderAgentPage(agentName));
  }

  return null;
}

// --- Helpers ---

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function findAgentDbPath(name: string): string | null {
  const agents = listAgents();
  const agent = agents.find(a => a.name === name);
  return agent?.dbPath ?? null;
}

// --- API implementations ---

function apiStatus(stats: ProxyStats) {
  const uptimeMs = Date.now() - stats.startedAt;
  const agentReqs: Record<string, number> = {};
  for (const [name, count] of stats.agentRequests) {
    agentReqs[name] = count;
  }
  return {
    startedAt: stats.startedAt,
    uptimeMs,
    totalRequests: stats.totalRequests,
    agentRequests: agentReqs,
  };
}

function apiAgents() {
  const agents = listAgents();
  return agents.map(a => {
    let memoryCount = 0;
    let rawEventCount = 0;
    let lastDigest: number | null = null;
    let lastSelector: number | null = null;
    let typeCounts: Record<string, number> = {};
    let pressure = 0;
    let pressureLevel: string = "none";

    try {
      const db = openReadonlyDb(a.dbPath);
      try {
        memoryCount = (db.query("SELECT COUNT(*) as c FROM memories WHERE archived_at IS NULL").get() as { c: number })?.c ?? 0;
        rawEventCount = (db.query("SELECT COUNT(*) as c FROM raw_events").get() as { c: number })?.c ?? 0;
        const digestRow = db.query("SELECT MAX(timestamp) as t FROM digest_passes").get() as { t: number | null } | null;
        lastDigest = digestRow?.t ?? null;
        const selectorRow = db.query("SELECT MAX(timestamp) as t FROM selector_runs").get() as { t: number | null } | null;
        lastSelector = selectorRow?.t ?? null;
        // Type breakdown (active memories only)
        try {
          const types = db.query(
            "SELECT type, COUNT(*) as c FROM memories WHERE archived_at IS NULL GROUP BY type"
          ).all() as { type: string; c: number }[];
          typeCounts = Object.fromEntries(types.map(t => [t.type, t.c]));
        } catch {
          // type column may not exist on very old DBs
        }
        // Consolidation pressure
        try {
          const { pressure: p } = getConsolidationPressure(db);
          pressure = p;
          pressureLevel = getPressureLevel(p);
        } catch {
          // consolidated column may not exist on very old DBs
        }
      } finally {
        db.close();
      }
    } catch {
      // Can't open DB — return zeros
    }

    return {
      name: a.name,
      sizeBytes: a.sizeBytes,
      memoryCount,
      rawEventCount,
      lastDigest,
      lastSelector,
      typeCounts,
      pressure,
      pressureLevel,
    };
  });
}

function apiAgentMemories(db: Database, query?: string, minSalience?: number, limit = 100, includeArchived = false) {
  const memories = queryMemories(db, { query, minSalience, limit, includeArchived });
  return { memories };
}

function apiAgentMemory(db: Database, memoryId: number) {
  const memory = db.query("SELECT * FROM memories WHERE id = ?").get(memoryId);
  if (!memory) return { error: "Memory not found" };

  const associations = getAssociations(db, memoryId).map(a => ({
    connected_id: a.connected_id,
    strength: a.strength,
    reinforcement_count: a.reinforcement_count,
  }));

  const sources = db.query(
    "SELECT raw_event_id FROM memory_sources WHERE memory_id = ?"
  ).all(memoryId) as { raw_event_id: number }[];

  return { memory, associations, sources: sources.map(s => s.raw_event_id) };
}

function apiAgentIdentity(db: Database) {
  const nodes = getIdentityNodes(db);

  const identity: Record<string, unknown> = {};
  for (const node of nodes) {
    identity[node.role] = {
      id: node.id,
      content: node.content,
      salience: node.salience,
    };
  }

  return { identity };
}

function apiAgentDigests(db: Database, limit: number) {
  const rows = db.query(
    "SELECT * FROM digest_passes ORDER BY timestamp DESC LIMIT ?"
  ).all(limit);

  // Summary stats
  const totalRow = db.query("SELECT COUNT(*) as c FROM digest_passes").get() as { c: number };
  const avgRow = db.query(
    "SELECT AVG(duration_ms) as avg_ms, SUM(memories_created) as total_created FROM digest_passes"
  ).get() as { avg_ms: number | null; total_created: number | null };

  return {
    passes: rows,
    summary: {
      totalPasses: totalRow.c,
      avgDurationMs: avgRow.avg_ms ? Math.round(avgRow.avg_ms) : null,
      totalMemoriesCreated: avgRow.total_created ?? 0,
    },
  };
}

function apiAgentSelector(db: Database, limit: number) {
  const rows = db.query(
    "SELECT * FROM selector_runs ORDER BY timestamp DESC LIMIT ?"
  ).all(limit);

  const totalRow = db.query("SELECT COUNT(*) as c FROM selector_runs").get() as { c: number };
  const avgRow = db.query(
    "SELECT AVG(duration_ms) as avg_ms, AVG(memory_count) as avg_count FROM selector_runs"
  ).get() as { avg_ms: number | null; avg_count: number | null };

  return {
    runs: rows,
    summary: {
      totalRuns: totalRow.c,
      avgDurationMs: avgRow.avg_ms ? Math.round(avgRow.avg_ms) : null,
      avgMemoryCount: avgRow.avg_count ? Math.round(avgRow.avg_count * 10) / 10 : null,
    },
  };
}

function apiAgentConsolidation(db: Database) {
  const status = getConsolidationStatus(db);
  const level = getPressureLevel(status.pressure);

  return {
    watermark: status.watermark,
    pressure: status.pressure,
    pressureLevel: level,
    unconsolidatedTokens: Math.round(status.unconsolidatedTokens),
    totalGroups: status.totalGroups,
    consolidatedGroups: status.consolidatedGroups,
    unconsolidatedGroups: status.totalGroups - status.consolidatedGroups,
  };
}

function apiAgentContext(db: Database) {
  const rows = db.query(`
    SELECT start_group, end_group, session_id, level, tokens
    FROM exchange_levels
    ORDER BY start_group ASC, level ASC
  `).all() as { start_group: number; end_group: number; session_id: number | null; level: number; tokens: number }[];

  const levelCounts: Record<number, number> = {};
  const totalTokens: Record<number, number> = {};

  for (const row of rows) {
    levelCounts[row.level] = (levelCounts[row.level] ?? 0) + 1;
    totalTokens[row.level] = (totalTokens[row.level] ?? 0) + row.tokens;
  }

  // Aggregate per exchange (unique start_group, end_group)
  const exchangeMap = new Map<string, { start_group: number; end_group: number; session_id: number | null; levels: number[]; l1_tokens: number }>();
  for (const row of rows) {
    const key = `${row.start_group}-${row.end_group}`;
    let entry = exchangeMap.get(key);
    if (!entry) {
      entry = { start_group: row.start_group, end_group: row.end_group, session_id: row.session_id, levels: [], l1_tokens: 0 };
      exchangeMap.set(key, entry);
    }
    entry.levels.push(row.level);
    if (row.level === 1) entry.l1_tokens = row.tokens;
  }

  return {
    exchanges: Array.from(exchangeMap.values()),
    levelCounts,
    totalTokens,
    totalExchanges: exchangeMap.size,
  };
}

function apiAgentHistory(db: Database, limit: number, offset: number, query?: string) {
  // Total count for pagination
  const totalRow = db.query("SELECT COUNT(*) as c FROM raw_events").get() as { c: number };

  let rows: unknown[];
  if (query) {
    // FTS5 search across raw events
    const words = query
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 1);
    if (words.length === 0) {
      rows = [];
    } else {
      const ftsQuery = words.map(w => `"${w}"`).join(" OR ");
      try {
        rows = db.query(`
          SELECT r.id, r.timestamp, r.message_group, r.role, r.content_type,
                 r.content, r.is_subagent
          FROM raw_events r
          JOIN raw_events_fts f ON f.rowid = r.id
          WHERE raw_events_fts MATCH ?
          ORDER BY r.id DESC
          LIMIT ? OFFSET ?
        `).all(ftsQuery, limit, offset);
      } catch {
        rows = [];
      }
    }
  } else {
    rows = db.query(`
      SELECT id, timestamp, message_group, role, content_type, content, is_subagent
      FROM raw_events
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);
  }

  // Group counts for context
  const groupCount = db.query(
    "SELECT COUNT(DISTINCT message_group) as c FROM raw_events"
  ).get() as { c: number };

  // Content type breakdown
  const typeCounts = db.query(`
    SELECT content_type, COUNT(*) as c FROM raw_events GROUP BY content_type
  `).all() as { content_type: string; c: number }[];

  return {
    events: rows,
    total: totalRow.c,
    messageGroups: groupCount.c,
    typeCounts: Object.fromEntries(typeCounts.map(t => [t.content_type, t.c])),
  };
}

// --- HTML page renderers ---

function renderIndexPage(stats: ProxyStats): string {
  const uptimeMs = Date.now() - stats.startedAt;
  const uptimeStr = formatUptime(uptimeMs);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Spotless Dashboard</title>
  <meta http-equiv="refresh" content="30">
  ${STYLES}
</head>
<body>
  <header>
    <h1>Spotless Dashboard</h1>
    <div class="status-bar">
      <span class="status-item">Uptime: ${uptimeStr}</span>
      <span class="status-item">Requests: ${stats.totalRequests}</span>
    </div>
  </header>

  <main>
    <h2>Agents</h2>
    <div id="agents-container">
      <p class="loading">Loading agents...</p>
    </div>
  </main>

  <script>
    fetch('/_dashboard/api/agents')
      .then(r => r.json())
      .then(agents => {
        const container = document.getElementById('agents-container');
        if (agents.length === 0) {
          container.innerHTML = '<p class="empty">No agents yet. Start a session with <code>spotless code --agent &lt;name&gt;</code></p>';
          return;
        }
        container.innerHTML = agents.map(a => {
          const tc = a.typeCounts || {};
          const typeBreakdown = Object.keys(tc).length > 0
            ? Object.entries(tc).map(([t,c]) => \`<span class="type-badge type-\${t}">\${t}: \${c}</span>\`).join(' ')
            : '';
          return \`
          <a href="/_dashboard/agent/\${a.name}" class="agent-card">
            <div class="agent-name">\${a.name}</div>
            <div class="agent-stats">
              <span>\${a.memoryCount} memories</span>
              <span>\${a.rawEventCount} events</span>
              <span>\${formatBytes(a.sizeBytes)}</span>
            </div>
            <div class="agent-meta">
              <span>Last digest: \${a.lastDigest ? timeAgo(a.lastDigest) : 'never'}</span>
              <span>Last selector: \${a.lastSelector ? timeAgo(a.lastSelector) : 'never'}</span>
            </div>
            \${typeBreakdown ? '<div class="agent-types">' + typeBreakdown + '</div>' : ''}
            \${a.pressure > 0 ? '<div class="agent-pressure pressure-' + a.pressureLevel + '"><span class="pressure-dot"></span> Pressure: ' + (a.pressure * 100).toFixed(0) + '% (' + a.pressureLevel + ')</div>' : ''}
          </a>
        \`}).join('');
      })
      .catch(err => {
        document.getElementById('agents-container').innerHTML =
          '<p class="error">Failed to load agents: ' + err.message + '</p>';
      });

    function formatBytes(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function timeAgo(ts) {
      const diff = Date.now() - ts;
      if (diff < 60000) return 'just now';
      if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
      if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
      return Math.floor(diff / 86400000) + 'd ago';
    }
  </script>
</body>
</html>`;
}

function renderAgentPage(agentName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${agentName} - Spotless</title>
  ${STYLES}
</head>
<body>
  <header>
    <h1><a href="/_dashboard/">Spotless</a> / ${agentName}</h1>
  </header>

  <nav class="tabs">
    <button class="tab active" data-tab="memories">Memories</button>
    <button class="tab" data-tab="history">History</button>
    <button class="tab" data-tab="identity">Identity</button>
    <button class="tab" data-tab="digests">Digests</button>
    <button class="tab" data-tab="selector">Selector</button>
    <button class="tab" data-tab="health">Health</button>
    <button class="tab" data-tab="context">Context</button>
  </nav>

  <!-- Memories Tab -->
  <section id="tab-memories" class="tab-content active">
    <div class="controls">
      <input type="text" id="search-input" placeholder="Search memories (FTS5)..." />
      <label>Min salience: <input type="range" id="salience-slider" min="0" max="1" step="0.05" value="0" />
        <span id="salience-value">0</span>
      </label>
      <select id="type-filter">
        <option value="">All types</option>
        <option value="episodic">episodic</option>
        <option value="fact">fact</option>
      </select>
      <label><input type="checkbox" id="show-archived" /> Show archived</label>
      <button id="search-btn">Search</button>
    </div>
    <div id="memories-results"></div>
  </section>

  <!-- History Tab -->
  <section id="tab-history" class="tab-content">
    <div id="history-summary"></div>
    <div class="controls">
      <input type="text" id="history-search" placeholder="Search raw events (FTS5)..." />
      <button id="history-search-btn">Search</button>
      <button id="history-clear-btn">Show all</button>
      <span class="history-nav">
        <button id="history-newer">&laquo; Newer</button>
        <span id="history-page-info"></span>
        <button id="history-older">Older &raquo;</button>
      </span>
    </div>
    <div id="history-results"></div>
  </section>

  <!-- Identity Tab -->
  <section id="tab-identity" class="tab-content">
    <div id="identity-content">
      <p class="loading">Loading identity...</p>
    </div>
  </section>

  <!-- Digests Tab -->
  <section id="tab-digests" class="tab-content">
    <div id="digests-summary"></div>
    <div id="digests-table"></div>
  </section>

  <!-- Selector Tab -->
  <section id="tab-selector" class="tab-content">
    <div id="selector-summary"></div>
    <div id="selector-table"></div>
  </section>

  <!-- Health Tab -->
  <section id="tab-health" class="tab-content">
    <div id="health-content">
      <p class="loading">Loading consolidation status...</p>
    </div>
  </section>

  <!-- Context Tab -->
  <section id="tab-context" class="tab-content">
    <div id="context-content">
      <p class="loading">Loading context composition data...</p>
    </div>
  </section>

  <script>
    const AGENT = '${agentName}';

    // Tab switching
    document.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(s => s.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
        if (btn.dataset.tab === 'history') loadHistory();
        if (btn.dataset.tab === 'identity') loadIdentity();
        if (btn.dataset.tab === 'digests') loadDigests();
        if (btn.dataset.tab === 'selector') loadSelector();
        if (btn.dataset.tab === 'health') loadHealth();
        if (btn.dataset.tab === 'context') loadContext();
      });
    });

    // --- Memories ---
    const searchInput = document.getElementById('search-input');
    const salienceSlider = document.getElementById('salience-slider');
    const salienceValue = document.getElementById('salience-value');
    const searchBtn = document.getElementById('search-btn');

    const typeFilter = document.getElementById('type-filter');
    const showArchived = document.getElementById('show-archived');

    salienceSlider.addEventListener('input', () => {
      salienceValue.textContent = salienceSlider.value;
    });

    searchBtn.addEventListener('click', loadMemories);
    searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') loadMemories(); });
    typeFilter.addEventListener('change', loadMemories);
    showArchived.addEventListener('change', loadMemories);

    function loadMemories() {
      const q = searchInput.value.trim();
      const minSalience = parseFloat(salienceSlider.value);
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (minSalience > 0) params.set('min_salience', String(minSalience));
      if (showArchived.checked) params.set('include_archived', 'true');
      params.set('limit', '200');

      fetch('/_dashboard/api/agent/' + AGENT + '/memories?' + params)
        .then(r => r.json())
        .then(data => {
          const container = document.getElementById('memories-results');
          let memories = data.memories || [];

          // Client-side type filter (API returns all types, we filter here)
          const selectedType = typeFilter.value;
          if (selectedType) {
            memories = memories.filter(m => m.type === selectedType);
          }

          if (memories.length === 0) {
            container.innerHTML = '<p class="empty">No memories found.</p>';
            return;
          }
          container.innerHTML = '<table>' +
            '<thead><tr><th>ID</th><th>Type</th><th>Content</th><th>Salience</th><th>Access</th><th>Assoc</th><th>Created</th></tr></thead>' +
            '<tbody>' + memories.map(m => {
              const typeClass = 'type-' + (m.type || 'episodic');
              const archivedBadge = m.archived_at ? ' <span class="archived-badge">archived</span>' : '';
              return \`
              <tr class="memory-row \${m.archived_at ? 'archived-row' : ''}" data-id="\${m.id}">
                <td>\${m.id}</td>
                <td><span class="type-badge \${typeClass}">\${m.type || 'episodic'}</span>\${archivedBadge}</td>
                <td class="content-cell">\${escapeHtml(truncate(m.content, 120))}</td>
                <td>\${m.salience.toFixed(2)}</td>
                <td>\${m.access_count}</td>
                <td>\${m.association_count}</td>
                <td>\${formatTime(m.created_at)}</td>
              </tr>
              <tr class="memory-detail" id="detail-\${m.id}" style="display:none">
                <td colspan="7"><div class="detail-content">Loading...</div></td>
              </tr>
            \`}).join('') + '</tbody></table>';

          container.querySelectorAll('.memory-row').forEach(row => {
            row.addEventListener('click', () => {
              const id = row.dataset.id;
              const detail = document.getElementById('detail-' + id);
              if (detail.style.display === 'none') {
                detail.style.display = 'table-row';
                loadMemoryDetail(id, detail.querySelector('.detail-content'));
              } else {
                detail.style.display = 'none';
              }
            });
          });
        });
    }

    function loadMemoryDetail(id, container) {
      fetch('/_dashboard/api/agent/' + AGENT + '/memory/' + id)
        .then(r => r.json())
        .then(data => {
          if (data.error) { container.textContent = data.error; return; }
          const m = data.memory;
          let html = '<div class="detail-full"><pre>' + escapeHtml(m.content) + '</pre>';
          html += '<div class="detail-meta">Type: ' + (m.type || 'episodic') + ' | Salience: ' + m.salience + ' | Access: ' + m.access_count +
            ' | Created: ' + formatTime(m.created_at) + ' | Accessed: ' + formatTime(m.last_accessed) +
            (m.archived_at ? ' | Archived: ' + formatTime(m.archived_at) : '') + '</div>';
          if (data.associations.length > 0) {
            html += '<div class="detail-assoc"><strong>Associations:</strong><ul>' +
              data.associations.map(a =>
                '<li>Memory #' + a.connected_id + ' (strength: ' + a.strength.toFixed(2) +
                ', reinforced: ' + a.reinforcement_count + 'x)</li>'
              ).join('') + '</ul></div>';
          }
          if (data.sources.length > 0) {
            html += '<div class="detail-sources">Source events: ' + data.sources.join(', ') + '</div>';
          }
          html += '</div>';
          container.innerHTML = html;
        });
    }

    // Load all memories on page load
    loadMemories();

    // --- History ---
    let historyOffset = 0;
    const historyLimit = 200;
    let historyTotal = 0;
    let historyQuery = '';

    const historySearch = document.getElementById('history-search');
    const historySearchBtn = document.getElementById('history-search-btn');
    const historyClearBtn = document.getElementById('history-clear-btn');
    const historyNewer = document.getElementById('history-newer');
    const historyOlder = document.getElementById('history-older');

    historySearchBtn.addEventListener('click', () => {
      historyQuery = historySearch.value.trim();
      historyOffset = 0;
      loadHistory();
    });
    historySearch.addEventListener('keydown', e => {
      if (e.key === 'Enter') { historyQuery = historySearch.value.trim(); historyOffset = 0; loadHistory(); }
    });
    historyClearBtn.addEventListener('click', () => {
      historySearch.value = '';
      historyQuery = '';
      historyOffset = 0;
      loadHistory();
    });
    historyNewer.addEventListener('click', () => {
      historyOffset = Math.max(0, historyOffset - historyLimit);
      loadHistory();
    });
    historyOlder.addEventListener('click', () => {
      if (historyOffset + historyLimit < historyTotal) {
        historyOffset += historyLimit;
        loadHistory();
      }
    });

    function loadHistory() {
      const params = new URLSearchParams();
      params.set('limit', String(historyLimit));
      params.set('offset', String(historyOffset));
      if (historyQuery) params.set('q', historyQuery);

      fetch('/_dashboard/api/agent/' + AGENT + '/history?' + params)
        .then(r => r.json())
        .then(data => {
          historyTotal = data.total;

          // Summary
          const summary = document.getElementById('history-summary');
          const tc = data.typeCounts || {};
          summary.innerHTML = '<div class="summary-bar">' +
            '<span>Total events: ' + data.total + '</span>' +
            '<span>Message groups: ' + data.messageGroups + '</span>' +
            '<span>text: ' + (tc.text || 0) + '</span>' +
            '<span>tool_use: ' + (tc.tool_use || 0) + '</span>' +
            '<span>tool_result: ' + (tc.tool_result || 0) + '</span>' +
            '<span>thinking: ' + (tc.thinking || 0) + '</span>' +
            '</div>';

          // Pagination info
          const pageInfo = document.getElementById('history-page-info');
          const showing = Math.min(historyOffset + historyLimit, data.total);
          pageInfo.textContent = (historyOffset + 1) + '-' + showing + ' of ' + data.total;
          historyNewer.disabled = historyOffset === 0;
          historyOlder.disabled = historyOffset + historyLimit >= data.total;

          // Table
          const container = document.getElementById('history-results');
          if (!data.events || data.events.length === 0) {
            container.innerHTML = '<p class="empty">No raw events found.</p>';
            return;
          }

          // Group events by message_group for visual separation
          let lastGroup = null;
          let tableHtml = '<table>' +
            '<thead><tr><th>ID</th><th>Group</th><th>Role</th><th>Type</th><th>Content</th><th>Sub</th><th>Time</th></tr></thead>' +
            '<tbody>';

          for (const e of data.events) {
            const groupChanged = lastGroup !== null && e.message_group !== lastGroup;
            lastGroup = e.message_group;

            const roleClass = e.role === 'user' ? 'role-user' : 'role-assistant';
            const typeClass = 'type-' + e.content_type;
            const subBadge = e.is_subagent ? '<span class="sub-badge">sub</span>' : '';

            tableHtml += \`
              <tr class="\${roleClass} \${typeClass}\${groupChanged ? ' group-boundary' : ''}" data-eid="\${e.id}">
                <td>\${e.id}</td>
                <td>\${e.message_group}</td>
                <td class="\${roleClass}">\${e.role}</td>
                <td class="\${typeClass}">\${e.content_type}</td>
                <td class="content-cell history-content">\${escapeHtml(truncate(e.content, 150))}</td>
                <td>\${subBadge}</td>
                <td>\${formatTime(e.timestamp)}</td>
              </tr>
              <tr class="history-detail" id="history-detail-\${e.id}" style="display:none">
                <td colspan="7"><div class="detail-content"><pre>\${escapeHtml(e.content)}</pre></div></td>
              </tr>
            \`;
          }

          tableHtml += '</tbody></table>';
          container.innerHTML = tableHtml;

          // Click to expand
          container.querySelectorAll('tr[data-eid]').forEach(row => {
            row.addEventListener('click', () => {
              const detail = document.getElementById('history-detail-' + row.dataset.eid);
              detail.style.display = detail.style.display === 'none' ? 'table-row' : 'none';
            });
          });
        });
    }

    // --- Identity ---
    function loadIdentity() {
      fetch('/_dashboard/api/agent/' + AGENT + '/identity')
        .then(r => r.json())
        .then(data => {
          const container = document.getElementById('identity-content');
          let html = '';

          const roles = [
            { key: 'self', label: 'Self-Model', data: data.identity?.self },
            { key: 'relationship', label: 'Relationship Model', data: data.identity?.relationship },
          ];

          for (const role of roles) {
            html += '<div class="identity-card">';
            html += '<h3>' + role.label + '</h3>';
            if (role.data) {
              html += '<pre>' + escapeHtml(role.data.content) + '</pre>';
              html += '<div class="identity-meta">ID: ' + role.data.id + ' | Salience: ' + role.data.salience + '</div>';
            } else {
              html += '<p class="empty">[not yet created]</p>';
            }
            html += '</div>';
          }

          container.innerHTML = html;
        });
    }

    // --- Digests ---
    function loadDigests() {
      fetch('/_dashboard/api/agent/' + AGENT + '/digests')
        .then(r => r.json())
        .then(data => {
          const summary = document.getElementById('digests-summary');
          const s = data.summary;
          summary.innerHTML = '<div class="summary-bar">' +
            '<span>Total passes: ' + s.totalPasses + '</span>' +
            '<span>Avg duration: ' + (s.avgDurationMs ? s.avgDurationMs + 'ms' : 'n/a') + '</span>' +
            '<span>Total memories created: ' + s.totalMemoriesCreated + '</span>' +
            '</div>';

          const table = document.getElementById('digests-table');
          if (!data.passes || data.passes.length === 0) {
            table.innerHTML = '<p class="empty">No digest passes yet.</p>';
            return;
          }
          table.innerHTML = '<table>' +
            '<thead><tr><th>Time</th><th>Duration</th><th>Created</th><th>Merged</th><th>Pruned</th><th>Superseded</th><th>Assoc</th><th>Identity</th><th>Errors</th></tr></thead>' +
            '<tbody>' + data.passes.map(p => \`
              <tr>
                <td>\${formatTime(p.timestamp)}</td>
                <td>\${p.duration_ms}ms</td>
                <td>\${p.memories_created}</td>
                <td>\${p.memories_merged}</td>
                <td>\${p.memories_pruned}</td>
                <td>\${p.memories_superseded}</td>
                <td>\${p.associations_created}</td>
                <td>\${p.identity_ops}</td>
                <td class="error-cell">\${p.errors ? '!' : ''}</td>
              </tr>
            \`).join('') + '</tbody></table>';
        });
    }

    // --- Selector ---
    function loadSelector() {
      fetch('/_dashboard/api/agent/' + AGENT + '/selector')
        .then(r => r.json())
        .then(data => {
          const summary = document.getElementById('selector-summary');
          const s = data.summary;
          summary.innerHTML = '<div class="summary-bar">' +
            '<span>Total runs: ' + s.totalRuns + '</span>' +
            '<span>Avg duration: ' + (s.avgDurationMs ? s.avgDurationMs + 'ms' : 'n/a') + '</span>' +
            '<span>Avg memories: ' + (s.avgMemoryCount !== null ? s.avgMemoryCount : 'n/a') + '</span>' +
            '</div>';

          const table = document.getElementById('selector-table');
          if (!data.runs || data.runs.length === 0) {
            table.innerHTML = '<p class="empty">No selector runs yet.</p>';
            return;
          }
          table.innerHTML = '<table>' +
            '<thead><tr><th>Time</th><th>Duration</th><th>Memories</th><th>Cue</th></tr></thead>' +
            '<tbody>' + data.runs.map(r => \`
              <tr>
                <td>\${formatTime(r.timestamp)}</td>
                <td>\${r.duration_ms}ms</td>
                <td>\${r.memory_count}</td>
                <td class="content-cell">\${escapeHtml(truncate(r.cue_text || '', 100))}</td>
              </tr>
            \`).join('') + '</tbody></table>';
        });
    }

    // --- Health ---
    function loadHealth() {
      fetch('/_dashboard/api/agent/' + AGENT + '/consolidation')
        .then(r => r.json())
        .then(data => {
          const container = document.getElementById('health-content');
          const pct = (data.pressure * 100).toFixed(1);
          const levelClass = 'pressure-' + data.pressureLevel;

          let html = '<div class="health-grid">';

          // Pressure gauge
          html += '<div class="health-card">';
          html += '<h3>Consolidation Pressure</h3>';
          html += '<div class="pressure-gauge">';
          html += '<div class="pressure-bar ' + levelClass + '" style="width:' + Math.min(100, parseFloat(pct)) + '%"></div>';
          html += '</div>';
          html += '<div class="pressure-label ' + levelClass + '">' + pct + '% <span class="pressure-level">' + data.pressureLevel + '</span></div>';
          html += '</div>';

          // Stats
          html += '<div class="health-card">';
          html += '<h3>Consolidation Stats</h3>';
          html += '<div class="health-stats">';
          html += '<div class="stat-row"><span class="stat-label">Watermark</span><span class="stat-value">' + (data.watermark !== null ? 'group ' + data.watermark : 'none') + '</span></div>';
          html += '<div class="stat-row"><span class="stat-label">Unconsolidated tokens</span><span class="stat-value">' + Math.round(data.unconsolidatedTokens / 1000) + 'k</span></div>';
          html += '<div class="stat-row"><span class="stat-label">Groups consolidated</span><span class="stat-value">' + data.consolidatedGroups + ' / ' + data.totalGroups + '</span></div>';
          html += '<div class="stat-row"><span class="stat-label">Unconsolidated groups</span><span class="stat-value">' + data.unconsolidatedGroups + '</span></div>';
          html += '</div>';
          html += '</div>';

          html += '</div>';
          container.innerHTML = html;
        })
        .catch(err => {
          document.getElementById('health-content').innerHTML =
            '<p class="error">Failed to load health data: ' + err.message + '</p>';
        });
    }

    // --- Context ---
    function loadContext() {
      fetch('/_dashboard/api/agent/' + AGENT + '/context')
        .then(r => r.json())
        .then(data => {
          const container = document.getElementById('context-content');
          let html = '<div class="health-grid">';

          // Summary card
          html += '<div class="health-card">';
          html += '<h3>Exchange Levels</h3>';
          html += '<div class="health-stats">';
          html += '<div class="stat-row"><span class="stat-label">Total exchanges</span><span class="stat-value">' + data.totalExchanges + '</span></div>';
          for (const [level, count] of Object.entries(data.levelCounts || {})) {
            const tokens = data.totalTokens[level] || 0;
            html += '<div class="stat-row"><span class="stat-label">Level ' + level + '</span><span class="stat-value">' + count + ' (' + Math.round(tokens / 1000) + 'k tokens)</span></div>';
          }
          html += '</div></div>';

          html += '</div>';

          // Exchanges table
          if (data.exchanges && data.exchanges.length > 0) {
            html += '<h3>Exchanges (' + data.exchanges.length + ')</h3>';
            html += '<table><thead><tr><th>Groups</th><th>Session</th><th>Levels</th><th>L1 Tokens</th></tr></thead><tbody>';
            for (const ex of data.exchanges) {
              html += '<tr>';
              html += '<td>' + ex.start_group + '–' + ex.end_group + '</td>';
              html += '<td>' + (ex.session_id ?? '-') + '</td>';
              html += '<td>' + ex.levels.map(l => 'L' + l).join(', ') + '</td>';
              html += '<td>' + ex.l1_tokens + '</td>';
              html += '</tr>';
            }
            html += '</tbody></table>';
          } else {
            html += '<p>No exchange levels data yet. Run <code>spotless backfill</code> to generate.</p>';
          }

          container.innerHTML = html;
        })
        .catch(err => {
          document.getElementById('context-content').innerHTML =
            '<p class="error">Failed to load context data: ' + err.message + '</p>';
        });
    }

    // --- Utilities ---
    function escapeHtml(s) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function truncate(s, len) {
      return s.length > len ? s.slice(0, len) + '...' : s;
    }

    function formatTime(ts) {
      if (!ts) return 'n/a';
      return new Date(ts).toLocaleString();
    }
  </script>
</body>
</html>`;
}

function render404Page(agentName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Agent Not Found - Spotless</title>
  ${STYLES}
</head>
<body>
  <header>
    <h1><a href="/_dashboard/">Spotless</a></h1>
  </header>
  <main>
    <p class="error">Agent "${agentName}" not found.</p>
    <p><a href="/_dashboard/">Back to dashboard</a></p>
  </main>
</body>
</html>`;
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

// --- Shared styles ---

const STYLES = `<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
    background: #0d1117;
    color: #c9d1d9;
    line-height: 1.5;
    padding: 20px;
    max-width: 1200px;
    margin: 0 auto;
  }

  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }

  header {
    border-bottom: 1px solid #30363d;
    padding-bottom: 12px;
    margin-bottom: 20px;
  }

  h1 { font-size: 1.4em; color: #f0f6fc; }
  h2 { font-size: 1.1em; color: #f0f6fc; margin: 16px 0 8px; }
  h3 { font-size: 1em; color: #f0f6fc; margin-bottom: 8px; }

  .status-bar {
    display: flex;
    gap: 20px;
    margin-top: 8px;
    font-size: 0.85em;
    color: #8b949e;
  }

  .agent-card {
    display: block;
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 12px 16px;
    margin-bottom: 8px;
    color: #c9d1d9;
    transition: border-color 0.15s;
  }

  .agent-card:hover {
    border-color: #58a6ff;
    text-decoration: none;
  }

  .agent-name { font-size: 1.1em; color: #58a6ff; font-weight: bold; }

  .agent-stats, .agent-meta {
    display: flex;
    gap: 16px;
    font-size: 0.85em;
    color: #8b949e;
    margin-top: 4px;
  }

  .tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid #30363d;
    margin-bottom: 16px;
  }

  .tab {
    background: none;
    border: none;
    color: #8b949e;
    font-family: inherit;
    font-size: 0.9em;
    padding: 8px 16px;
    cursor: pointer;
    border-bottom: 2px solid transparent;
  }

  .tab:hover { color: #c9d1d9; }
  .tab.active { color: #f0f6fc; border-bottom-color: #58a6ff; }

  .tab-content { display: none; }
  .tab-content.active { display: block; }

  .controls {
    display: flex;
    gap: 12px;
    align-items: center;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }

  input[type="text"] {
    background: #0d1117;
    border: 1px solid #30363d;
    color: #c9d1d9;
    font-family: inherit;
    font-size: 0.9em;
    padding: 6px 10px;
    border-radius: 4px;
    width: 300px;
  }

  input[type="text"]:focus { border-color: #58a6ff; outline: none; }

  label {
    font-size: 0.85em;
    color: #8b949e;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  button {
    background: #21262d;
    border: 1px solid #30363d;
    color: #c9d1d9;
    font-family: inherit;
    font-size: 0.85em;
    padding: 6px 12px;
    border-radius: 4px;
    cursor: pointer;
  }

  button:hover { background: #30363d; }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85em;
  }

  th {
    text-align: left;
    padding: 8px;
    border-bottom: 1px solid #30363d;
    color: #8b949e;
    font-weight: normal;
    white-space: nowrap;
  }

  td {
    padding: 8px;
    border-bottom: 1px solid #21262d;
    vertical-align: top;
  }

  .memory-row { cursor: pointer; }
  .memory-row:hover { background: #161b22; }

  .content-cell {
    max-width: 500px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .detail-content {
    background: #161b22;
    padding: 12px;
    border-radius: 4px;
  }

  .detail-full pre {
    white-space: pre-wrap;
    word-break: break-word;
    margin-bottom: 8px;
    color: #f0f6fc;
  }

  .detail-meta, .detail-sources {
    font-size: 0.85em;
    color: #8b949e;
    margin-top: 4px;
  }

  .detail-assoc { margin-top: 8px; }
  .detail-assoc ul { padding-left: 20px; }
  .detail-assoc li { color: #8b949e; font-size: 0.9em; }

  .identity-card {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 16px;
    margin-bottom: 12px;
  }

  .identity-card pre {
    white-space: pre-wrap;
    word-break: break-word;
    color: #f0f6fc;
    margin: 8px 0;
  }

  .identity-meta { font-size: 0.85em; color: #8b949e; }

  .summary-bar {
    display: flex;
    gap: 24px;
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 12px 16px;
    margin-bottom: 16px;
    font-size: 0.9em;
  }

  .role-user td:nth-child(3) { color: #7ee787; }
  .role-assistant td:nth-child(3) { color: #d2a8ff; }
  .type-tool_use td:nth-child(4) { color: #ffa657; }
  .type-tool_result td:nth-child(4) { color: #79c0ff; }
  .type-thinking td:nth-child(4) { color: #8b949e; font-style: italic; }

  .group-boundary td { border-top: 2px solid #30363d; }

  .sub-badge {
    background: #30363d;
    color: #8b949e;
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 0.8em;
  }

  .history-content { cursor: pointer; }

  .history-nav {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-left: auto;
    font-size: 0.85em;
    color: #8b949e;
  }

  .history-nav button:disabled { opacity: 0.4; cursor: default; }

  .type-badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 0.8em;
    font-weight: 500;
  }
  .type-episodic { background: #1a4731; color: #7ee787; }
  .type-fact { background: #3d2b00; color: #ffa657; }

  .archived-badge {
    display: inline-block;
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 0.75em;
    background: #30363d;
    color: #8b949e;
    margin-left: 4px;
  }

  .archived-row { opacity: 0.6; }
  .agent-types { display: flex; gap: 8px; margin-top: 4px; font-size: 0.8em; }

  .agent-pressure { margin-top: 4px; font-size: 0.8em; display: flex; align-items: center; gap: 4px; }
  .agent-pressure.pressure-none { color: #7ee787; }
  .agent-pressure.pressure-moderate { color: #e3b341; }
  .agent-pressure.pressure-high { color: #f85149; }
  .pressure-dot {
    width: 6px; height: 6px; border-radius: 50%; display: inline-block;
  }
  .pressure-none .pressure-dot { background: #238636; }
  .pressure-moderate .pressure-dot { background: #d29922; }
  .pressure-high .pressure-dot { background: #f85149; }

  .error-cell { color: #f85149; text-align: center; }

  .health-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }

  .health-card {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 16px;
  }

  .pressure-gauge {
    height: 12px;
    background: #21262d;
    border-radius: 6px;
    overflow: hidden;
    margin: 12px 0 8px;
  }

  .pressure-bar {
    height: 100%;
    border-radius: 6px;
    transition: width 0.3s;
  }

  .pressure-none .pressure-bar, .pressure-bar.pressure-none { background: #238636; }
  .pressure-moderate .pressure-bar, .pressure-bar.pressure-moderate { background: #d29922; }
  .pressure-high .pressure-bar, .pressure-bar.pressure-high { background: #f85149; }

  .pressure-label { font-size: 1.2em; font-weight: bold; }
  .pressure-label.pressure-none { color: #7ee787; }
  .pressure-label.pressure-moderate { color: #e3b341; }
  .pressure-label.pressure-high { color: #f85149; }

  .pressure-level { font-size: 0.7em; font-weight: normal; color: #8b949e; }

  .health-stats { margin-top: 8px; }

  .stat-row {
    display: flex;
    justify-content: space-between;
    padding: 6px 0;
    border-bottom: 1px solid #21262d;
    font-size: 0.9em;
  }

  .stat-label { color: #8b949e; }
  .stat-value { color: #f0f6fc; font-weight: 500; }

  .loading { color: #8b949e; font-style: italic; }
  .empty { color: #8b949e; }
  .error { color: #f85149; }

  code {
    background: #161b22;
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 0.9em;
  }
</style>`;
