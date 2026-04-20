#!/bin/bash
BASE="http://tnt-engine.internal:30911"
TOKEN="tok_YipFfshl23X21H7TiFfz2CpogsAJjob0EBJH1zZfQPQ"
BODY="{\"token\":\"$TOKEN\",\"tenant_id\":\"tenant-001\"}"

get_metrics() {
  # Lấy metrics từ pod trực tiếp (bypass Kong để đúng pod)
  POD=$(kubectl -n tnt-engine get pods --no-headers | grep Running | head -1 | awk '{print $1}')
  kubectl -n tnt-engine exec $POD -- python3 -c "
import urllib.request
data = urllib.request.urlopen('http://localhost:8000/metrics/').read().decode()
for line in data.splitlines():
    if 'tnt_l1_cache' in line and 'created' not in line and not line.startswith('#'):
        print(line)
"
}

echo "======================================"
echo "Cache Hit Rate Benchmark"
echo "Token: $TOKEN"
echo "======================================"

echo ""
echo "--- Metrics BEFORE ---"
get_metrics

echo ""
echo "--- Warm up: 100 requests (cold cache) ---"
hey -n 100 -c 10 \
  -m POST \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  $BASE/api/v1/detokenize

echo ""
echo "--- Metrics after warm up ---"
get_metrics

echo ""
echo "--- Load test: 5000 requests, c=50 (warm cache) ---"
hey -n 5000 -c 50 \
  -m POST \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  $BASE/api/v1/detokenize

echo ""
echo "--- Metrics AFTER ---"
get_metrics

echo ""
echo "--- Cache hit rate calculation ---"
kubectl -n tnt-engine exec $(kubectl -n tnt-engine get pods --no-headers | grep Running | head -1 | awk '{print $1}') -- python3 -c "
import urllib.request
data = urllib.request.urlopen('http://localhost:8000/metrics/').read().decode()
hits = 0
misses = 0
for line in data.splitlines():
    if line.startswith('tnt_l1_cache_hits_total'):
        hits = float(line.split()[-1])
    if line.startswith('tnt_l1_cache_misses_total'):
        misses = float(line.split()[-1])
total = hits + misses
rate = (hits / total * 100) if total > 0 else 0
print(f'L1 hits:   {int(hits)}')
print(f'L1 misses: {int(misses)}')
print(f'Total:     {int(total)}')
print(f'Hit rate:  {rate:.1f}%')
"
