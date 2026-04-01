#!/usr/bin/env bash
# HTTP-level load test for the T&T Engine.
# Requires: wrk (brew install wrk) or hey (go install github.com/rakyll/hey@latest)
#
# Usage:
#   ./scripts/load-test.sh <base_url> <test_type>
#
# Test types:
#   baseline   — 100 req/s for 30s (warm-up + baseline measurement)
#   load       — 1000 req/s for 60s (target throughput)
#   spike      — 5000 req/s for 30s (burst capacity)
#   soak       — 500 req/s for 600s (10min sustained)

set -euo pipefail

BASE_URL="${1:-http://localhost:8000}"
TEST_TYPE="${2:-baseline}"
ENDPOINT="${BASE_URL}/api/v1/tokenize"

PAYLOAD='{"value":"load-test-value-'$$'","field":"ssn","tenant_id":"load_test","transformation":"TOKENIZE"}'

echo "=== T&T Engine Load Test ==="
echo "Target:   ${ENDPOINT}"
echo "Test:     ${TEST_TYPE}"
echo ""

if command -v hey &> /dev/null; then
    case "$TEST_TYPE" in
        baseline)
            hey -n 3000 -c 10 -m POST \
                -H "Content-Type: application/json" \
                -d "$PAYLOAD" \
                "$ENDPOINT"
            ;;
        load)
            hey -n 60000 -c 100 -m POST \
                -H "Content-Type: application/json" \
                -d "$PAYLOAD" \
                "$ENDPOINT"
            ;;
        spike)
            hey -n 30000 -c 500 -m POST \
                -H "Content-Type: application/json" \
                -d "$PAYLOAD" \
                "$ENDPOINT"
            ;;
        soak)
            hey -n 300000 -c 50 -m POST \
                -H "Content-Type: application/json" \
                -d "$PAYLOAD" \
                "$ENDPOINT"
            ;;
        *)
            echo "Unknown test type: $TEST_TYPE"
            echo "Options: baseline, load, spike, soak"
            exit 1
            ;;
    esac
elif command -v wrk &> /dev/null; then
    echo "Using wrk (hey not found)"
    DURATION="30s"
    CONNECTIONS=100
    case "$TEST_TYPE" in
        baseline) CONNECTIONS=10; DURATION="30s" ;;
        load)     CONNECTIONS=100; DURATION="60s" ;;
        spike)    CONNECTIONS=500; DURATION="30s" ;;
        soak)     CONNECTIONS=50; DURATION="600s" ;;
    esac

    wrk -t4 -c${CONNECTIONS} -d${DURATION} \
        -s <(cat <<'LUA'
wrk.method = "POST"
wrk.headers["Content-Type"] = "application/json"
wrk.body = '{"value":"wrk-test","field":"ssn","tenant_id":"load_test","transformation":"TOKENIZE"}'
LUA
) "$ENDPOINT"
else
    echo "ERROR: Neither 'hey' nor 'wrk' found. Install one:"
    echo "  brew install hey"
    echo "  brew install wrk"
    exit 1
fi

echo ""
echo "=== Load test complete ==="
echo "Check Grafana dashboard for detailed metrics."
