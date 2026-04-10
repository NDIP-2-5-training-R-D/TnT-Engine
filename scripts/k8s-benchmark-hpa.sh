#!/bin/bash
BASE="http://tnt-engine.internal:30911"
BODY='{"tenant_id":"tenant-001","field":"card_number","value":"4111111111111111"}'

run_test() {
  local label=$1
  local concurrent=$2
  local volume=$3

  echo ""
  echo "======================================"
  echo "[HPA | $label] concurrent=$concurrent volume=$volume"
  echo "======================================"

  echo "--- HPA before ---"
  kubectl -n tnt-engine get hpa tnt-engine --no-headers

  if [[ $volume == *m ]]; then
    hey -z $volume -c $concurrent \
      -m POST \
      -H "Content-Type: application/json" \
      -d "$BODY" \
      $BASE/api/v1/tokenize &
    HEY_PID=$!
    while kill -0 $HEY_PID 2>/dev/null; do
      kubectl -n tnt-engine get hpa tnt-engine --no-headers 2>/dev/null
      sleep 15
    done
    wait $HEY_PID
  else
    hey -n $volume -c $concurrent \
      -m POST \
      -H "Content-Type: application/json" \
      -d "$BODY" \
      $BASE/api/v1/tokenize
  fi

  echo "--- HPA after ---"
  kubectl -n tnt-engine get hpa tnt-engine --no-headers
  kubectl -n tnt-engine get pods --no-headers | grep tnt-engine

  echo "Cooling down 60s for HPA scale down..."
  sleep 60
}

echo "######################################"
echo "#       SCENARIO: HPA AUTO-SCALE     #"
echo "# min=1 pod, max=5 pod, target=70%   #"
echo "######################################"

run_test "Baseline" 10  1000
run_test "Load"     50  5000
run_test "Spike"    200 2000
run_test "Soak"     20  10m

echo ""
echo "Final HPA state:"
kubectl -n tnt-engine get hpa tnt-engine
echo "Done."
