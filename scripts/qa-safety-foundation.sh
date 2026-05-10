#!/usr/bin/env bash
#
# scripts/qa-safety-foundation.sh — Safety Foundation QA pass (PR U10)
#
# 목적:
#   PR S/M/L/U 시리즈로 구현된 실행 로그 + auto rollback 의 핵심 파일 / 정책이
#   깨지지 않았는지 정적 검증. 운영 DB 변경 0 — 파일 grep / node syntax check 만.
#
# 사용법:
#   bash scripts/qa-safety-foundation.sh
#
# 종료 코드:
#   0 = 모든 검증 PASS
#   1 = 1+ FAIL
#
# 검증 그룹:
#   A. 핵심 파일 존재
#   B. safetyUndo allowlist 7 액션
#   C. rollbackAction 사용 위치 (safetyUndo only)
#   D. safetyRuns route 구조
#   E. safetyRuns UI helper / fetch / snapshot fold
#   F. skuMaster 5 액션 rollbackMethod 매핑
#   G. purchaseRequests 5 액션 rollbackMethod 매핑
#   H. node syntax check (7 파일)
#   I. console + sensitive keyword guard
#   J. 040 migration 보호 (truncation guard)

set -uo pipefail

# Move to repo root (스크립트가 어디서 실행되든)
cd "$(dirname "${BASH_SOURCE[0]}")/.." || { echo "FATAL: cannot cd to repo root"; exit 1; }

PASS=0
FAIL=0
WARN=0

# 색상 (TTY 가 아니면 no-op)
if [[ -t 1 ]]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  YELLOW='\033[0;33m'
  NC='\033[0m'
else
  GREEN=''; RED=''; YELLOW=''; NC=''
fi

pass() { printf "${GREEN}[PASS]${NC} %s\n" "$1"; PASS=$((PASS+1)); }
fail() { printf "${RED}[FAIL]${NC} %s\n" "$1"; FAIL=$((FAIL+1)); }
warn() { printf "${YELLOW}[WARN]${NC} %s\n" "$1"; WARN=$((WARN+1)); }

# ── helpers ──────────────────────────────────────────────────────────────

check_exists() {
  local f="$1"
  if [[ -f "$f" ]]; then
    pass "exists: $f"
  else
    fail "missing: $f"
  fi
}

check_contains() {
  local f="$1" pat="$2" label="$3"
  if [[ ! -f "$f" ]]; then
    fail "$label (file missing: $f)"
    return
  fi
  if grep -qE "$pat" "$f"; then
    pass "$label"
  else
    fail "$label (pattern not found in $f)"
  fi
}

check_not_contains() {
  local f="$1" pat="$2" label="$3"
  if [[ ! -f "$f" ]]; then
    fail "$label (file missing: $f)"
    return
  fi
  if grep -qE "$pat" "$f"; then
    fail "$label (forbidden pattern found in $f)"
  else
    pass "$label"
  fi
}

# action_name 출현 라인부터 25줄 안에 rollbackMethod: 'expected' 검사
check_action_method() {
  local f="$1" action="$2" expected="$3"
  if [[ ! -f "$f" ]]; then
    fail "action_method ${action}: file missing $f"
    return
  fi
  local first_line
  first_line=$(grep -nE "actionName:[[:space:]]+['\"]${action}['\"]" "$f" 2>/dev/null | head -1 | cut -d: -f1)
  if [[ -z "${first_line:-}" ]]; then
    fail "action_method ${action}: actionName not found in $f"
    return
  fi
  local end_line=$((first_line + 25))
  if sed -n "${first_line},${end_line}p" "$f" | grep -qE "rollbackMethod:[[:space:]]+['\"]${expected}['\"]"; then
    pass "action_method ${action} → ${expected}"
  else
    fail "action_method ${action}: expected ${expected} in $f (near line ${first_line})"
  fi
}

# console.* + sensitive keyword 가 같은 줄에 있으면 fail.
# 그 외 raw_payload/token/secret/password 단순 출현은 warn (정책 주석 가능).
check_no_console_secret() {
  local f="$1"
  if [[ ! -f "$f" ]]; then
    fail "console_secret: file missing $f"
    return
  fi
  if grep -nE "console\.(log|error|warn).*(token|secret|password|raw_payload)" "$f" >/dev/null 2>&1; then
    fail "console_secret: $f has console.* with sensitive keyword"
    return
  fi
  if grep -qE "raw_payload|token|secret|password" "$f"; then
    warn "sensitive keyword present in $f (likely policy comment — verify manually)"
  else
    pass "no sensitive keyword in $f"
  fi
}

# ── A. Core file existence ────────────────────────────────────────────────
echo
echo "==> A. Core file existence"
check_exists src/services/safetyExec.js
check_exists src/services/safetyUndo.js
check_exists src/web/routes/safetyRuns.js
check_exists public/js/safetyRuns.js
check_exists src/web/routes/skuMaster.js
check_exists src/web/routes/tasks.js
check_exists src/web/routes/purchaseRequests.js

# ── B. safetyUndo allowlist ───────────────────────────────────────────────
echo
echo "==> B. safetyUndo allowlist"
for action in \
  sku_listing_link_create \
  sku_listing_link_delete \
  sku_master_update \
  sku_master_soft_delete \
  purchase_request_approve \
  purchase_request_reject \
  purchase_request_ordered
do
  check_contains src/services/safetyUndo.js "['\"]${action}['\"]" "allowlist contains: ${action}"
done

# ── C. rollbackAction usage (safetyUndo only) ─────────────────────────────
echo
echo "==> C. rollbackAction usage"
check_contains     src/services/safetyUndo.js          "rollbackAction" "safetyUndo uses rollbackAction"
check_not_contains src/web/routes/safetyRuns.js        "rollbackAction" "safetyRuns route does NOT use rollbackAction"
check_not_contains public/js/safetyRuns.js             "rollbackAction" "safetyRuns UI does NOT use rollbackAction"
check_not_contains src/web/routes/skuMaster.js         "rollbackAction" "skuMaster route does NOT use rollbackAction"
check_not_contains src/web/routes/purchaseRequests.js  "rollbackAction" "purchaseRequests route does NOT use rollbackAction"

# ── D. safetyRuns route ──────────────────────────────────────────────────
echo
echo "==> D. safetyRuns route"
check_contains src/web/routes/safetyRuns.js "router\.get\(['\"]/['\"]"            "route: GET /"
check_contains src/web/routes/safetyRuns.js "router\.get\(['\"]/:id['\"]"          "route: GET /:id"
check_contains src/web/routes/safetyRuns.js "router\.post\(['\"]/:id/rollback['\"]" "route: POST /:id/rollback"
check_contains src/web/routes/safetyRuns.js "requireAuth"                          "route uses requireAuth"
check_contains src/web/routes/safetyRuns.js "(safetyUndo|rollbackRun)"             "route delegates to safetyUndo"

# ── E. safetyRuns UI ─────────────────────────────────────────────────────
echo
echo "==> E. safetyRuns UI"
check_contains     public/js/safetyRuns.js "ACTION_LABEL"                     "UI: ACTION_LABEL map"
check_contains     public/js/safetyRuns.js "rollbackStatusBadge"              "UI: rollbackStatusBadge helper"
check_contains     public/js/safetyRuns.js "rollbackImpactText"               "UI: rollbackImpactText helper"
check_contains     public/js/safetyRuns.js "showAutoRollbackModal"            "UI: showAutoRollbackModal"
check_contains     public/js/safetyRuns.js "/api/safety-runs/"                "UI: /api/safety-runs/ path"
check_contains     public/js/safetyRuns.js "method:[[:space:]]+['\"]POST['\"]" "UI: POST method"
check_contains     public/js/safetyRuns.js "<details"                          "UI: <details snapshot fold"
check_not_contains public/js/safetyRuns.js "<details open"                     "UI: <details open is absent (default collapsed)"

# ── F. skuMaster rollbackMethod ──────────────────────────────────────────
echo
echo "==> F. skuMaster rollbackMethod mapping"
check_action_method src/web/routes/skuMaster.js sku_master_create       manual
check_action_method src/web/routes/skuMaster.js sku_master_update       auto
check_action_method src/web/routes/skuMaster.js sku_master_soft_delete  auto
check_action_method src/web/routes/skuMaster.js sku_listing_link_create auto
check_action_method src/web/routes/skuMaster.js sku_listing_link_delete auto

# ── G. purchaseRequests rollbackMethod ───────────────────────────────────
echo
echo "==> G. purchaseRequests rollbackMethod mapping"
check_action_method src/web/routes/purchaseRequests.js purchase_request_create   manual
check_action_method src/web/routes/purchaseRequests.js purchase_request_update   manual
check_action_method src/web/routes/purchaseRequests.js purchase_request_approve  auto
check_action_method src/web/routes/purchaseRequests.js purchase_request_reject   auto
check_action_method src/web/routes/purchaseRequests.js purchase_request_ordered  auto

# ── H. node syntax check ─────────────────────────────────────────────────
echo
echo "==> H. node syntax check"
for f in \
  src/services/safetyExec.js \
  src/services/safetyUndo.js \
  src/web/routes/safetyRuns.js \
  public/js/safetyRuns.js \
  src/web/routes/skuMaster.js \
  src/web/routes/tasks.js \
  src/web/routes/purchaseRequests.js
do
  if [[ ! -f "$f" ]]; then
    fail "node syntax: file missing $f"
    continue
  fi
  if node -c "$f" 2>/dev/null; then
    pass "node syntax: $f"
  else
    fail "node syntax FAILED: $f"
  fi
done

# ── I. console + sensitive keyword guard ─────────────────────────────────
echo
echo "==> I. console + sensitive keyword guard"
for f in \
  src/services/safetyUndo.js \
  src/web/routes/safetyRuns.js \
  public/js/safetyRuns.js \
  src/web/routes/skuMaster.js \
  src/web/routes/tasks.js \
  src/web/routes/purchaseRequests.js
do
  check_no_console_secret "$f"
done

# ── J. 040 migration guard ───────────────────────────────────────────────
echo
echo "==> J. 040 migration guard (truncation prevention)"
MIG="supabase/migrations/040_safety_foundation.sql"
if [[ ! -f "$MIG" ]]; then
  fail "040 migration missing: $MIG"
else
  mig_lines=$(wc -l < "$MIG" | tr -d ' ')
  if (( mig_lines < 50 )); then
    fail "040 migration too short (${mig_lines} < 50 lines) — possible truncation: $MIG"
  else
    pass "040 migration intact (${mig_lines} lines)"
  fi
fi

# ── SUMMARY ──────────────────────────────────────────────────────────────
echo
echo "==> SUMMARY"
echo "  PASS: $PASS"
echo "  WARN: $WARN"
echo "  FAIL: $FAIL"
echo

if (( FAIL > 0 )); then
  printf "${RED}FAIL${NC}: one or more checks failed.\n"
  exit 1
fi
printf "${GREEN}PASS${NC}: all checks passed.\n"
exit 0
