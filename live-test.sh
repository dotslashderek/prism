#!/usr/bin/env bash
set -euo pipefail

SPEC_FILE="packages/http-server/src/__tests__/fixtures/petstore.no-auth.oas3.yaml"
BASE_URL="http://127.0.0.1:4020"

echo "DEBUG: OPENAI_API_KEY length=${#OPENAI_API_KEY} (${OPENAI_API_KEY:+set}${OPENAI_API_KEY:-MISSING})"
echo "DEBUG: EMBEDDING_API_KEY length=${#EMBEDDING_API_KEY} (${EMBEDDING_API_KEY:+set}${EMBEDDING_API_KEY:-MISSING})"

echo "🚀 Starting Prism mock server on port 4020 with AI Mocker..."
node packages/cli/dist/index.js mock "$SPEC_FILE" --ai --port 4020 > live-demo.log 2>&1 &
PRISM_PID=$!

function cleanup {
  echo -e "\n🧹 Shutting down Prism..."
  kill $PRISM_PID 2>/dev/null || true
  wait $PRISM_PID 2>/dev/null || true
}
trap cleanup EXIT

echo "⏳ Waiting for server to boot..."
for i in {1..15}; do
  if curl -s "$BASE_URL/store/order/1" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo ""
echo "═══════════════════════════════════════════"
echo "  📦 Local Spec Store Orders Demo"
echo "═══════════════════════════════════════════"

echo -e "\n----- 1. GET /store/order/7 (Check before creation) -----"
curl -s "$BASE_URL/store/order/7" | jq

echo -e "\n----- 2. POST /store/order (Create order 7) -----"
curl -s -X POST "$BASE_URL/store/order" \
  -H "Content-Type: application/json" \
  -d '{"id": 7, "petId": 999, "quantity": 5, "shipDate": "2026-12-01T00:00:00Z", "status": "approved", "complete": true}' | jq

echo -e "\n----- 3. GET /store/order/7 (Verify memory of order 7) -----"
curl -s "$BASE_URL/store/order/7" | jq

echo -e "\n----- 4. GET /store/inventory (Verify state effects) -----"
curl -s "$BASE_URL/store/inventory" | jq

echo -e "\nDone."
