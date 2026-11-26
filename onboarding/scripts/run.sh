#!/usr/bin/env bash
# The one entry point: build, run both Playwright phases, merge the reports and
# write onboarding/out/summary.md. Every Docker object is in the
# cortecho-onboarding project; nothing outside it is touched.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
OUT="$ROOT/onboarding/out"
COMPOSE=(docker compose -p cortecho-onboarding -f onboarding/compose.yml)

rm -rf "$OUT"
mkdir -p "$OUT" "$OUT/logs"

OPENAI_MODE="${OPENAI_MODE:-mock}"
if [[ "$OPENAI_MODE" != "mock" && "$OPENAI_MODE" != "real" ]]; then
  echo "OPENAI_MODE must be mock or real (got '$OPENAI_MODE')" >&2
  exit 2
fi
if [[ "$OPENAI_MODE" == "real" && -z "${OPENAI_API_KEY_E2E:-}" ]]; then
  echo "OPENAI_MODE=real needs OPENAI_API_KEY_E2E in the environment" >&2
  exit 2
fi

if [[ -z "${CORTECHO_IMAGE:-}" ]]; then
  CORTECHO_IMAGE="cortecho:onboarding"
  docker build -t "$CORTECHO_IMAGE" "$ROOT"
fi

export CORTECHO_IMAGE
export OPENAI_MODE
export OPENAI_API_KEY_E2E="${OPENAI_API_KEY_E2E:-}"
export ECHO_FRIENDLY_NAME="${ECHO_FRIENDLY_NAME:-Echo Dot 2 5c0e11}"
export ONBOARDING_IMAGE="$CORTECHO_IMAGE"
export ONBOARDING_COMMIT="${GITHUB_SHA:-$(git rev-parse --short HEAD 2>/dev/null || echo unknown)}"
export ONBOARDING_RUN_NUMBER="${GITHUB_RUN_NUMBER:-local-$(date +%s)}"
export ONBOARDING_TOTAL_STEPS=12
export ONBOARDING_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cleanup() {
  set +e
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1
}
trap cleanup EXIT

"${COMPOSE[@]}" build echo-kitchen openai-gw runner
"${COMPOSE[@]}" up -d --wait --wait-timeout 180 cortecho echo-kitchen openai-gw runner

result=0

run_phase() {
  local phase="$1"
  local code=0
  set +e
  "${COMPOSE[@]}" exec -T \
    -e PLAYWRIGHT_BLOB_OUTPUT_FILE="/out/blobs/$phase.zip" \
    -e PWTEST_BLOB_DO_NOT_REMOVE=1 \
    runner npx playwright test --grep "@$phase"
  code=$?
  set -e
  "${COMPOSE[@]}" cp runner:/out/. "$OUT"/
  return "$code"
}

if run_phase setup; then
  "${COMPOSE[@]}" restart cortecho
  cortecho_id="$("${COMPOSE[@]}" ps -q cortecho)"
  healthy=0
  for _ in $(seq 1 90); do
    status="$(docker inspect -f '{{.State.Health.Status}}' "$cortecho_id" 2>/dev/null || echo starting)"
    if [[ "$status" == "healthy" ]]; then
      healthy=1
      break
    fi
    sleep 1
  done
  if [[ "$healthy" -ne 1 ]]; then
    echo "cortecho did not become healthy after the restart" >&2
    result=1
  elif ! run_phase restart; then
    result=1
  fi
else
  result=1
fi

set +e
"${COMPOSE[@]}" exec -T \
  -e PLAYWRIGHT_HTML_OUTPUT_DIR=/out/report \
  -e PLAYWRIGHT_JSON_OUTPUT_FILE=/out/results.json \
  runner npx playwright merge-reports --reporter=html,json /out/blobs
merge_status=$?
if [[ "$merge_status" -eq 0 ]]; then
  # The HTML report is self-contained; the raw blob zips and artifact
  # directory would only double the uploaded artifact.
  "${COMPOSE[@]}" exec -T runner rm -rf /out/blobs /out/artifacts || true
fi
"${COMPOSE[@]}" exec -T runner node -e \
  'fetch(process.env.GATEWAY_URL + "/calls").then((r) => r.text()).then((t) => require("node:fs").writeFileSync("/out/openai-calls.json", t)).catch(() => {})' \
  >/dev/null 2>&1
"${COMPOSE[@]}" exec -T runner node /tests/summary.ts
summary_status=$?
"${COMPOSE[@]}" cp runner:/out/. "$OUT"/ || true
set -e
if [[ "$merge_status" -ne 0 || "$summary_status" -ne 0 ]]; then
  result=1
else
  # The earlier phase copies brought the raw blob zips and artifacts to the
  # host; the merged HTML report already embeds the videos and traces.
  rm -rf "$OUT/blobs" "$OUT/artifacts"
fi

for service in cortecho echo-kitchen openai-gw runner; do
  "${COMPOSE[@]}" logs --no-color --timestamps "$service" >"$OUT/logs/$service.log" 2>&1 || true
done

exit "$result"
