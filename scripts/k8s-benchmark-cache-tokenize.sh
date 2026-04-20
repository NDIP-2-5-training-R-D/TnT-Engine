#!/bin/bash
BASE="http://tnt-engine.internal:30911"
BODY='{"tenant_id":"tenant-001","field":"card_number","value":"4111111111111111"}'

POD=$(kubectl -n tnt-engine get pods --no-headers | grep Running | head -1 | awk '{print $1}')

get_metrics() {
  kubectl -n tnt-engine exec $POD -- python3 -c "
import urllib.request
data = urllib.request.urlopen('http://localhost:8000/metrics/').read().decode()
hits = 0; misses = 0
for line in data.splitlines():
    if line.startswith('tnt_l1_cache_hits_total'):
        hits = float(line.split()[-1])
    if line.startswith('tnt_l1_cache_misses_total'):
        misses = float(line.split()[-1])
total = hits + misses
rate = (hits / total * 100) if total > 0 else 0
print(f'  L1 hits:   {int(hits)}')
print(f'  L1 misses: {int(misses)}')
print(f'  Hit rate:  {rate:.1f}%')
"
}

echo "======================================"
echo "Cache Hit Rate Benchmark (Tokenize)"
echo "Pod: $POD"
echo "======================================"

echo ""
echo "--- Metrics BEFORE ---"
get_metrics

echo ""
echo "--- Round 1: 1000 req, c=10 (cold — giá trị mới) ---"
hey -n 1000 -c 10 \
  -m POST \
  -H "Content-Type: application/json" \
  -d '{"tenant_id":"tenant-001","field":"card_number","value":"NEW_VALUE_COLD_CACHE"}' \
  $BASE/api/v1/tokenize

echo ""
echo "--- Metrics after cold ---"
get_metrics

echo ""
echo "--- Round 2: 5000 req, c=50 (warm — cùng giá trị) ---"
hey -n 5000 -c 50 \
  -m POST \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  $BASE/api/v1/tokenize

echo ""
echo "--- Metrics AFTER warm ---"
get_metrics
