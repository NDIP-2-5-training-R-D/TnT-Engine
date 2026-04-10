#!/bin/bash
# ================================================================
# Test failover PostgreSQL và Redis
# Chạy trên VM1 sau khi setup HA xong
# ================================================================

BASE="http://tnt-engine.internal:30911"
BODY='{"tenant_id":"tenant-001","field":"card_number","value":"4111111111111111"}'

echo "======================================"
echo "Test 1: PostgreSQL Failover"
echo "======================================"

echo "--- Trạng thái trước ---"
kubectl -n data get pods -l app=postgres -o wide

echo ""
echo "--- Kill PostgreSQL Primary ---"
kubectl -n data delete pod -l role=primary

echo "--- Gửi request liên tục để đo downtime ---"
START=$(date +%s%3N)
ERRORS=0
SUCCESS=0
for i in $(seq 1 60); do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST $BASE/api/v1/tokenize \
    -H "Content-Type: application/json" -d "$BODY")
  if [ "$CODE" = "200" ]; then
    SUCCESS=$((SUCCESS+1))
  else
    ERRORS=$((ERRORS+1))
    echo "  [$(date +%H:%M:%S)] Error: HTTP $CODE"
  fi
  sleep 1
done
END=$(date +%s%3N)

echo ""
echo "--- Kết quả PostgreSQL Failover ---"
echo "  Success: $SUCCESS/60"
echo "  Errors:  $ERRORS/60"
echo "  Thời gian downtime ước tính: ${ERRORS} giây"
kubectl -n data get pods -l app=postgres -o wide

echo ""
echo "======================================"
echo "Test 2: Redis Failover"
echo "======================================"

echo "--- Trạng thái trước ---"
kubectl -n data get pods -l app=redis -o wide

echo ""
echo "--- Kill Redis Primary ---"
kubectl -n data delete pod -l role=primary -l app=redis

echo "--- Gửi request liên tục để đo downtime ---"
ERRORS=0
SUCCESS=0
for i in $(seq 1 60); do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST $BASE/api/v1/tokenize \
    -H "Content-Type: application/json" -d "$BODY")
  if [ "$CODE" = "200" ]; then
    SUCCESS=$((SUCCESS+1))
  else
    ERRORS=$((ERRORS+1))
    echo "  [$(date +%H:%M:%S)] Error: HTTP $CODE"
  fi
  sleep 1
done

echo ""
echo "--- Kết quả Redis Failover ---"
echo "  Success: $SUCCESS/60"
echo "  Errors:  $ERRORS/60"
echo "  Thời gian downtime ước tính: ${ERRORS} giây"
kubectl -n data get pods -l app=redis -o wide
