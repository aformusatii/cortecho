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

# ElevenLabs follows the OpenAI mode: deterministic in mock, the real account
# with a key, and a clear skip (not a failure) when a real run has no key.
if [[ "$OPENAI_MODE" == "mock" ]]; then
  ELEVENLABS_MODE="mock"
elif [[ -n "${ELEVENLABS_API_KEY_E2E:-}" ]]; then
  ELEVENLABS_MODE="real"
else
  ELEVENLABS_MODE="skip"
  echo "ELEVENLABS_API_KEY_E2E is not set: the ElevenLabs scenarios will be skipped." >&2
fi

if [[ -z "${CORTECHO_IMAGE:-}" ]]; then
  CORTECHO_IMAGE="cortecho:onboarding"
  docker build -t "$CORTECHO_IMAGE" "$ROOT"
fi

export CORTECHO_IMAGE
export OPENAI_MODE
export OPENAI_API_KEY_E2E="${OPENAI_API_KEY_E2E:-}"
export ELEVENLABS_MODE
export ELEVENLABS_API_KEY_E2E="${ELEVENLABS_API_KEY_E2E:-}"
export ELEVENLABS_ENABLED="$([[ "$ELEVENLABS_MODE" == "skip" ]] && echo false || echo true)"
export ECHO_FRIENDLY_NAME="${ECHO_FRIENDLY_NAME:-Echo Dot 2 5c0e11}"
export ONBOARDING_IMAGE="$CORTECHO_IMAGE"
export ONBOARDING_COMMIT="${GITHUB_SHA:-$(git rev-parse --short HEAD 2>/dev/null || echo unknown)}"
export ONBOARDING_RUN_NUMBER="${GITHUB_RUN_NUMBER:-local-$(date +%s)}"
# 8 onboarding + 1 restart + 2 provider turns + 1 follow-up + 1 Listen here +
# 1 announcement + 14 UI-tour screenshots. Without ElevenLabs, the two
# ElevenLabs steps (the turn and Listen here) are skipped.
if [[ "$ELEVENLABS_MODE" == "skip" ]]; then
  ONBOARDING_TOTAL_STEPS=26
else
  ONBOARDING_TOTAL_STEPS=28
fi
# The follow-up question needs the deterministic mock model to call
# listen_for_reply, so a real-AI run skips that step (number 12).
if [[ "$OPENAI_MODE" == "real" ]]; then
  ONBOARDING_TOTAL_STEPS=$((ONBOARDING_TOTAL_STEPS - 1))
fi
export ONBOARDING_TOTAL_STEPS
export ONBOARDING_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "Testing image: $CORTECHO_IMAGE"
echo "OpenAI: $OPENAI_MODE; ElevenLabs: $ELEVENLABS_MODE; expected steps: $ONBOARDING_TOTAL_STEPS"

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
    -e ONBOARDING_OUTPUT_DIR="/out/artifacts/$phase" \
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
  elif ! run_phase integration; then
    result=1
  fi
else
  result=1
fi

set +e
"${COMPOSE[@]}" exec -T \
  -e PLAYWRIGHT_HTML_OUTPUT_DIR=/out/report \
  -e PLAYWRIGHT_JSON_OUTPUT_FILE=/out/results.json \
  -e PLAYWRIGHT_JUNIT_OUTPUT_FILE=/out/junit.xml \
  runner npx playwright merge-reports --reporter=html,json,junit /out/blobs
merge_status=$?
# Belt and braces: the phase's exit code should already be non-zero, but the
# merged report is the record CI and the owner read, so fail on it directly.
if ! "${COMPOSE[@]}" exec -T runner node -e \
  'const results = require("/out/results.json"); process.exit((results.stats?.unexpected ?? 0) > 0 ? 1 : 0)'; then
  echo "Playwright reported failing tests: see onboarding/out/results.json" >&2
  result=1
fi
"${COMPOSE[@]}" exec -T runner node -e \
  'fetch(process.env.GATEWAY_URL + "/calls/all").then((r) => r.text()).then((t) => require("node:fs").writeFileSync("/out/openai-calls.json", t)).catch(() => {})' \
  >/dev/null 2>&1
"${COMPOSE[@]}" exec -T runner node /tests/summary.ts
summary_status=$?
# proof.ts copies the two test videos out of /out/artifacts itself, so the raw
# artifacts must still exist here.
"${COMPOSE[@]}" exec -T runner node /tests/proof.ts
proof_status=$?
if [[ "$merge_status" -eq 0 && "$summary_status" -eq 0 && "$proof_status" -eq 0 ]]; then
  # The merged HTML report and the proof are self-contained; the raw blob zips
  # and artifact directory would only double the uploaded artifact.
  "${COMPOSE[@]}" exec -T runner rm -rf /out/blobs /out/artifacts || true
fi
"${COMPOSE[@]}" cp runner:/out/. "$OUT"/ || true
set -e
if [[ "$merge_status" -ne 0 || "$summary_status" -ne 0 || "$proof_status" -ne 0 ]]; then
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
