#!/bin/bash
BASE="http://tnt-engine.internal:30911"
BODY='{"tenant_id":"tenant-001","field":"card_number","value":"4111111111111111"}'

run_test() {
  local label=$1
  local pods=$2
  local concurrent=$3
  local volume=$4  # số request hoặc duration (e.g. "1000" hoặc "10m")

  echo ""
  echo "======================================"
  echo "[$label] pods=$pods concurrent=$concurrent volume=$volume"
  echo "======================================"

  kubectl -n tnt-engine scale deployment tnt-engine --replicas=$pods > /dev/null
  echo "Waiting for $pods pods to be ready..."
  kubectl -n tnt-engine rollout status deployment tnt-engine --timeout=60s > /dev/null

  if [[ $volume == *m ]]; then
    hey -z $volume -c $concurrent \
      -m POST \
      -H "Content-Type: application/json" \
      -d "$BODY" \
      $BASE/api/v1/tokenize
  else
    hey -n $volume -c $concurrent \
      -m POST \
      -H "Content-Type: application/json" \
      -d "$BODY" \
      $BASE/api/v1/tokenize
  fi
}

echo "Starting benchmark: 4 tests x 2 scenarios (1 pod vs 3 pod)"
echo "Endpoint: POST /api/v1/tokenize"
echo ""

# ── 1 POD ──────────────────────────────────────────────
echo "######################################"
echo "#           SCENARIO: 1 POD          #"
echo "######################################"

run_test "1-POD | Baseline" 1 10  1000
run_test "1-POD | Load"     1 50  5000
run_test "1-POD | Spike"    1 200 2000
run_test "1-POD | Soak"     1 20  10m

# ── 3 POD ──────────────────────────────────────────────
echo ""
echo "######################################"
echo "#           SCENARIO: 3 POD          #"
echo "######################################"

run_test "3-POD | Baseline" 3 10  1000
run_test "3-POD | Load"     3 50  5000
run_test "3-POD | Spike"    3 200 2000
run_test "3-POD | Soak"     3 20  10m

# Scale về 1 sau khi xong
kubectl -n tnt-engine scale deployment tnt-engine --replicas=1 > /dev/null
echo ""
echo "Done. Scaled back to 1 pod."
