#!/bin/bash
echo "=== Cache metrics from ALL pods ==="
for POD in $(kubectl -n tnt-engine get pods --no-headers | grep Running | awk '{print $1}'); do
  echo ""
  echo "Pod: $POD"
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
done

echo ""
echo "=== Aggregate ==="
kubectl -n tnt-engine get pods --no-headers | grep Running | awk '{print $1}' | while read POD; do
  kubectl -n tnt-engine exec $POD -- python3 -c "
import urllib.request
data = urllib.request.urlopen('http://localhost:8000/metrics/').read().decode()
for line in data.splitlines():
    if line.startswith('tnt_l1_cache_hits_total') or line.startswith('tnt_l1_cache_misses_total'):
        print(line)
"
done | python3 -c "
import sys
hits = 0; misses = 0
for line in sys.stdin:
    parts = line.split()
    if 'hits' in parts[0]: hits += float(parts[-1])
    if 'misses' in parts[0]: misses += float(parts[-1])
total = hits + misses
rate = (hits / total * 100) if total > 0 else 0
print(f'Total L1 hits:   {int(hits)}')
print(f'Total L1 misses: {int(misses)}')
print(f'Total requests:  {int(total)}')
print(f'L1 Hit rate:     {rate:.1f}%')
"
