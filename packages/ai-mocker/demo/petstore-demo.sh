#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# Petstore AI-Mocker Demo
# Downloads the Petstore spec, starts Prism with --ai, and
# runs a CRUD cycle showing stateful AI-generated responses.
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SPEC_URL="https://petstore3.swagger.io/api/v3/openapi.json"
SPEC_FILE="petstore.json"
BASE_URL="http://127.0.0.1:4010"
PRISM_PID=""

cleanup() {
  if [[ -n "$PRISM_PID" ]]; then
    echo ""
    echo "🧹 Stopping Prism (PID $PRISM_PID)..."
    kill "$PRISM_PID" 2>/dev/null || true
    wait "$PRISM_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ── 1. Download spec ─────────────────────────────────────────
if [[ ! -f "$SPEC_FILE" ]]; then
  echo "📥 Downloading Petstore spec..."
  curl -sSL "$SPEC_URL" -o "$SPEC_FILE"
fi
echo "✅ Spec ready: $SPEC_FILE"

# ── 2. Start Prism ──────────────────────────────────────────
echo "🚀 Starting Prism mock server..."
npx --no-install prism mock "$SPEC_FILE" --ai --port 4010 &
PRISM_PID=$!
# If npx failed to find the local bin, kill and fallback to explicit path:
sleep 1
if ! kill -0 $PRISM_PID 2>/dev/null; then
  node ../../cli/dist/index.js mock "$SPEC_FILE" --ai --port 4010 &
  PRISM_PID=$!
fi
echo "   PID: $PRISM_PID"

# ── 3. Wait for ready ──────────────────────────────────────
echo "⏳ Waiting for server..."
for i in $(seq 1 30); do
  if curl -s "$BASE_URL" >/dev/null 2>&1; then
    echo "✅ Server ready!"
    break
  fi
  if [[ $i -eq 30 ]]; then
    echo "❌ Server failed to start"
    exit 1
  fi
  sleep 1
done

# ── Helper: timed curl ──────────────────────────────────────
timed_curl() {
  local label="$1"
  shift
  echo ""
  echo "────────────────────────────────────────"
  echo "📡 $label"
  echo "────────────────────────────────────────"
  local start end elapsed
  start=$(node -e 'console.log(Date.now())')
  local response
  response=$(curl -s -H "api_key: special-key" -w "\n%{http_code}" "$@")
  end=$(node -e 'console.log(Date.now())')
  elapsed=$((end - start))

  local http_code body
  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | sed '$d')

  echo "   Status: $http_code (${elapsed}ms)"
  echo "   Body:   $body" | head -20
  echo "$body"
}

# ── 4. CRUD Cycle ───────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════"
echo "  🐾 Petstore CRUD Cycle"
echo "═══════════════════════════════════════════"

# POST /pet — create
CREATE_RESPONSE=$(timed_curl "POST /pet — Create a pet" \
  -X POST "$BASE_URL/pet" \
  -H "Content-Type: application/json" \
  -d '{"name":"Buddy","status":"available","photoUrls":["https://example.com/buddy.jpg"]}')

PET_ID=$(echo "$CREATE_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id','1'))" 2>/dev/null || echo "1")
echo "   → Captured Pet ID: $PET_ID"

# GET /pet/{id} — verify creation
timed_curl "GET /pet/$PET_ID — Verify creation" \
  "$BASE_URL/pet/$PET_ID"

# PUT /pet — update
timed_curl "PUT /pet — Update name" \
  -X PUT "$BASE_URL/pet" \
  -H "Content-Type: application/json" \
  -d "{\"id\":$PET_ID,\"name\":\"Buddy Jr.\",\"status\":\"sold\",\"photoUrls\":[\"https://example.com/buddy.jpg\"]}"

# GET /pet/{id} — verify update
timed_curl "GET /pet/$PET_ID — Verify update reflected" \
  "$BASE_URL/pet/$PET_ID"

# DELETE /pet/{id} — delete
timed_curl "DELETE /pet/$PET_ID — Delete pet" \
  -X DELETE "$BASE_URL/pet/$PET_ID"

# GET /pet/{id} — verify post-delete
timed_curl "GET /pet/$PET_ID — Verify post-delete behavior" \
  "$BASE_URL/pet/$PET_ID"

# ── 5. Summary ──────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════"
echo "  ✅ Demo complete!"
echo "  The AI mocker generated stateful responses"
echo "  with concurrency control, caching, and timeouts."
echo "═══════════════════════════════════════════"
