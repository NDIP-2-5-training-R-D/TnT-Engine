#!/bin/bash
BASE="http://tnt-engine.internal:30911"
BODY='{"tenant_id":"tenant-001","field":"card_number","value":"4111111111111111"}'

echo "======================================"
echo "[HPA | Spike Extended] c=200, 5 phút"
echo "======================================"

echo "--- HPA before ---"
kubectl -n tnt-engine get hpa tnt-engine --no-headers
kubectl -n tnt-engine get pods --no-headers | grep tnt-engine

echo ""
echo "Starting load..."

hey -z 5m -c 200 \
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

echo ""
echo "--- HPA after ---"
kubectl -n tnt-engine get hpa tnt-engine --no-headers
kubectl -n tnt-engine get pods --no-headers | grep tnt-engine
