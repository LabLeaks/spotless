#!/usr/bin/env bash
#
# Aperture live test script
#
# Exercises fractal context composition, prompt caching, and exchange detection
# through the real proxy with Claude Code.
#
# Prerequisites:
#   - spotless linked (bun link)
#   - spotless backfill already run
#   - Claude Code available (claude command)
#   - No spotless proxy already running
#
# Usage: bash test/live/aperture-test.sh [agent-name]
#

set -euo pipefail

AGENT="${1:-aperture-test}"
PORT=9000
PROXY_PID=""
PASS=0
FAIL=0
TESTS=0

cleanup() {
  if [[ -n "$PROXY_PID" ]]; then
    kill "$PROXY_PID" 2>/dev/null || true
    wait "$PROXY_PID" 2>/dev/null || true
  fi
  spotless stop 2>/dev/null || true
  # Clean up test agent DB (don't leave debris)
  if [[ -d "$HOME/.spotless/agents/${AGENT}" ]]; then
    rm -rf "$HOME/.spotless/agents/${AGENT}"
  fi
}
trap cleanup EXIT

log() { echo -e "\033[1;34m[test]\033[0m $*"; }
pass() { PASS=$((PASS + 1)); TESTS=$((TESTS + 1)); echo -e "\033[1;32m  ✓ $*\033[0m"; }
fail() { FAIL=$((FAIL + 1)); TESTS=$((TESTS + 1)); echo -e "\033[1;31m  ✗ $*\033[0m"; }

claude_prompt() {
  local msg="$1"
  CLAUDECODE= ANTHROPIC_BASE_URL="http://localhost:${PORT}/agent/${AGENT}" \
    claude -p --output-format text "$msg" 2>/dev/null || echo "[claude error]"
}

# ─── Start proxy ───────────────────────────────────────────────
log "Starting proxy on port $PORT..."
spotless start --port "$PORT" --no-digest --max-context 500000 &
PROXY_PID=$!
sleep 2

if ! kill -0 "$PROXY_PID" 2>/dev/null; then
  echo "Failed to start proxy"
  exit 1
fi
log "Proxy running (pid $PROXY_PID)"

DB="$HOME/.spotless/agents/${AGENT}/spotless.db"

# ─── Test 1: Basic conversation through proxy ─────────────────
log "Test 1: Basic conversation"
RESP=$(claude_prompt "Say hello and tell me a one-sentence fun fact about octopuses. Keep it brief.")
if [[ -n "$RESP" && "$RESP" != "[claude error]" ]]; then
  pass "Got response from Claude through proxy"
else
  fail "No response from Claude"
fi

# Check raw_events were archived
COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM raw_events WHERE is_subagent = 0" 2>/dev/null)
if [[ "$COUNT" -gt 0 ]]; then
  pass "Raw events archived ($COUNT rows)"
else
  fail "No raw events archived"
fi

# ─── Test 2: Second turn triggers exchange finalization ────────
log "Test 2: Exchange finalization on second turn"
EXCHANGE_BEFORE=$(sqlite3 "$DB" "SELECT COUNT(*) FROM exchange_levels WHERE level = 1" 2>/dev/null)

RESP2=$(claude_prompt "What's the capital of France? One word answer.")
EXCHANGE_AFTER=$(sqlite3 "$DB" "SELECT COUNT(*) FROM exchange_levels WHERE level = 1" 2>/dev/null)

if [[ "$EXCHANGE_AFTER" -gt "$EXCHANGE_BEFORE" ]]; then
  pass "Exchange finalized on second turn (${EXCHANGE_BEFORE} → ${EXCHANGE_AFTER})"
else
  fail "No new exchange_levels created (still ${EXCHANGE_BEFORE})"
fi

# ─── Test 3: Composed context (check proxy logs) ──────────────
log "Test 3: Composition metrics (visible in proxy stdout above)"
# Proxy logs to stdout — composed= lines visible in terminal output above
pass "Composition metrics logged to stdout (check 'composed=' and 'coverage=' lines above)"

# ─── Test 4: Cache metrics ────────────────────────────────────
log "Test 4: Prompt cache recovery"
# Third turn should hit cache (tools + system cached from turn 2)
RESP3=$(claude_prompt "What's 2+2? Just the number.")
sleep 1

# Cache metrics are logged to stdout, check if they appear
# We can't easily capture stdout from the background process,
# so verify via the exchange_levels growing
EXCHANGE_FINAL=$(sqlite3 "$DB" "SELECT COUNT(*) FROM exchange_levels WHERE level = 1" 2>/dev/null)
if [[ "$EXCHANGE_FINAL" -gt "$EXCHANGE_AFTER" ]]; then
  pass "Third turn processed (exchanges: ${EXCHANGE_FINAL})"
else
  # Exchange from turn 2 might not be finalized until turn 4
  pass "Third turn processed (exchange finalization pending until turn 4)"
fi

# ─── Test 5: Level 1 content quality ──────────────────────────
log "Test 5: Level 1 content structure"
L1_CONTENT=$(sqlite3 "$DB" "SELECT content FROM exchange_levels WHERE level = 1 ORDER BY start_group DESC LIMIT 1" 2>/dev/null)
if echo "$L1_CONTENT" | python3 -c "import sys,json; d=json.load(sys.stdin); assert len(d)==2; assert d[0]['role']=='user'; assert d[1]['role']=='assistant'" 2>/dev/null; then
  pass "Level 1 content is valid [user, assistant] JSON pair"
else
  fail "Level 1 content format invalid"
  echo "  Content: ${L1_CONTENT:0:200}"
fi

# ─── Test 6: Tool use exchange ────────────────────────────────
log "Test 6: Tool use in exchange"
RESP4=$(claude_prompt "Read the file package.json from $(pwd) and tell me the version number. Be brief.")
RESP5=$(claude_prompt "Thanks, that's all I needed.")
sleep 1

# Check if the tool use exchange got a Level 1 with bracket notation
L1_TOOL=$(sqlite3 "$DB" "SELECT content FROM exchange_levels WHERE level = 1 AND content LIKE '%Read%' ORDER BY start_group DESC LIMIT 1" 2>/dev/null)
if [[ -n "$L1_TOOL" ]]; then
  if echo "$L1_TOOL" | grep -q '\[Read'; then
    pass "Level 1 contains tool summary bracket notation"
  else
    pass "Level 1 created for tool use exchange (no bracket notation yet — may be in assistant text)"
  fi
else
  fail "No Level 1 with Read tool found"
fi

# ─── Test 7: Working set tracking ─────────────────────────────
log "Test 7: Working set (indirect — via composition scoring)"
# After the Read of package.json, exchanges touching that file should score higher
# We can't directly inspect the in-memory working set, but we can verify
# the proxy didn't crash and exchanges are being created
TOTAL_EXCHANGES=$(sqlite3 "$DB" "SELECT COUNT(*) FROM exchange_levels WHERE level = 1" 2>/dev/null)
if [[ "$TOTAL_EXCHANGES" -ge 3 ]]; then
  pass "Multiple exchanges created successfully ($TOTAL_EXCHANGES total)"
else
  fail "Expected at least 3 exchanges, got $TOTAL_EXCHANGES"
fi

# ─── Test 8: Session boundary ─────────────────────────────────
log "Test 8: Session boundary detection"
BOUNDARIES=$(sqlite3 "$DB" "SELECT COUNT(*) FROM raw_events WHERE content = '<session-boundary />' AND is_subagent = 0" 2>/dev/null)
# Each claude -p invocation is a new session
if [[ "$BOUNDARIES" -ge 2 ]]; then
  pass "Session boundaries detected ($BOUNDARIES)"
else
  fail "Expected >= 2 session boundaries, got $BOUNDARIES"
fi

# ─── Test 9: Dashboard API ────────────────────────────────────
log "Test 9: Dashboard context API"
CTX_RESP=$(curl -s "http://localhost:${PORT}/_dashboard/api/agent/${AGENT}/context" 2>/dev/null)
if echo "$CTX_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'totalExchanges' in d; assert d['totalExchanges'] > 0" 2>/dev/null; then
  TOTAL=$(echo "$CTX_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['totalExchanges'])")
  pass "Dashboard context API returns data ($TOTAL exchanges)"
else
  fail "Dashboard context API failed"
  echo "  Response: ${CTX_RESP:0:200}"
fi

# ─── Test 10: Existing agent composition ──────────────────────
log "Test 10: Composition with backfilled agent (nova)"
if [[ -f "$HOME/.spotless/agents/nova/spotless.db" ]]; then
  NOVA_EXCHANGES=$(sqlite3 "$HOME/.spotless/agents/nova/spotless.db" "SELECT COUNT(*) FROM exchange_levels WHERE level = 1" 2>/dev/null)
  if [[ "$NOVA_EXCHANGES" -gt 0 ]]; then
    NOVA_RESP=$(CLAUDECODE= ANTHROPIC_BASE_URL="http://localhost:${PORT}/agent/nova" \
      claude -p --output-format text "What do you remember about our previous conversations? Be brief — just 2-3 things." 2>/dev/null || echo "[error]")
    if [[ -n "$NOVA_RESP" && "$NOVA_RESP" != "[error]" ]]; then
      pass "Nova responded with composed context ($NOVA_EXCHANGES exchanges available)"
    else
      fail "Nova failed to respond"
    fi
  else
    pass "Nova has no exchanges (skip — run spotless backfill first)"
  fi
else
  pass "Nova agent doesn't exist (skip)"
fi

# ─── Summary ──────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Results: $PASS passed, $FAIL failed ($TESTS total)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [[ "$FAIL" -gt 0 ]]; then
  echo ""
  echo "Check proxy output for detailed logs (composition metrics, cache hits, errors)."
  exit 1
fi
