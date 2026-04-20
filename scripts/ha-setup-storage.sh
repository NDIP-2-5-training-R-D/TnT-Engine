#!/bin/bash
# ================================================================
# Script setup HA storage sau khi VM2 đã join cluster
# Chạy trên VM1
# ================================================================

echo "======================================"
echo "Bước 2: Label nodes"
echo "======================================"
kubectl label node geic-dashcam-vm1 role=primary --overwrite
kubectl label node geic-dashcam-vm2 role=replica --overwrite

kubectl get nodes -o wide

echo ""
echo "======================================"
echo "Bước 3: Deploy PostgreSQL HA (Primary + Replica)"
echo "======================================"
cat <<'EOF' | kubectl apply -f -
# PostgreSQL Primary (VM1)
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres-primary
  namespace: data
spec:
  serviceName: postgres-primary
  replicas: 1
  selector:
    matchLabels:
      app: postgres
      role: primary
  template:
    metadata:
      labels:
        app: postgres
        role: primary
    spec:
      nodeSelector:
        role: primary
      containers:
      - name: postgres
        image: postgres:16
        ports:
        - containerPort: 5432
        env:
        - name: POSTGRES_USER
          value: postgres
        - name: POSTGRES_PASSWORD
          value: tnt_password
        - name: POSTGRES_DB
          value: tnt_engine
        - name: POSTGRES_REPLICATION_USER
          value: replicator
        - name: POSTGRES_REPLICATION_PASSWORD
          value: repl_password
        command:
        - bash
        - -c
        - |
          docker-entrypoint.sh postgres \
            -c wal_level=replica \
            -c max_wal_senders=3 \
            -c wal_keep_size=64 \
            -c hot_standby=on
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
        readinessProbe:
          exec:
            command: ["pg_isready", "-U", "postgres"]
          initialDelaySeconds: 10
          periodSeconds: 5
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: [ReadWriteOnce]
      resources:
        requests:
          storage: 5Gi
---
apiVersion: v1
kind: Service
metadata:
  name: postgres-primary
  namespace: data
spec:
  selector:
    app: postgres
    role: primary
  ports:
  - port: 5432
    targetPort: 5432
---
# PostgreSQL Replica (VM2)
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres-replica
  namespace: data
spec:
  serviceName: postgres-replica
  replicas: 1
  selector:
    matchLabels:
      app: postgres
      role: replica
  template:
    metadata:
      labels:
        app: postgres
        role: replica
    spec:
      nodeSelector:
        role: replica
      initContainers:
      - name: init-replica
        image: postgres:16
        env:
        - name: PGPASSWORD
          value: repl_password
        command:
        - bash
        - -c
        - |
          until pg_isready -h postgres-primary.data.svc.cluster.local -U postgres; do
            echo "Waiting for primary..."; sleep 2
          done
          pg_basebackup -h postgres-primary.data.svc.cluster.local \
            -U replicator -D /var/lib/postgresql/data \
            -P -Xs -R
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
      containers:
      - name: postgres
        image: postgres:16
        ports:
        - containerPort: 5432
        env:
        - name: POSTGRES_USER
          value: postgres
        - name: POSTGRES_PASSWORD
          value: tnt_password
        readinessProbe:
          exec:
            command: ["pg_isready", "-U", "postgres"]
          initialDelaySeconds: 20
          periodSeconds: 5
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: [ReadWriteOnce]
      resources:
        requests:
          storage: 5Gi
---
apiVersion: v1
kind: Service
metadata:
  name: postgres-replica
  namespace: data
spec:
  selector:
    app: postgres
    role: replica
  ports:
  - port: 5432
    targetPort: 5432
EOF

echo ""
echo "======================================"
echo "Bước 3b: Setup replication user trên PostgreSQL Primary"
echo "======================================"
echo "Chờ postgres-primary sẵn sàng..."
kubectl -n data wait --for=condition=ready pod/postgres-primary-0 --timeout=120s

kubectl -n data exec postgres-primary-0 -- psql -U postgres -c \
  "CREATE USER replicator REPLICATION LOGIN ENCRYPTED PASSWORD 'repl_password';" 2>/dev/null || \
  echo "(user đã tồn tại, bỏ qua)"

kubectl -n data exec postgres-primary-0 -- bash -c \
  "grep -q 'replicator' /var/lib/postgresql/data/pg_hba.conf || \
   echo 'host replication replicator 10.42.0.0/16 md5' >> /var/lib/postgresql/data/pg_hba.conf && \
   psql -U postgres -c 'SELECT pg_reload_conf();'"

echo "Replication user OK"

echo ""
echo "======================================"
echo "Bước 4: Deploy Redis HA (Primary + Replica + Sentinel)"
echo "======================================"
cat <<'EOF' | kubectl apply -f -
# Redis Primary (VM1)
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis-primary
  namespace: data
spec:
  serviceName: redis-primary
  replicas: 1
  selector:
    matchLabels:
      app: redis
      role: primary
  template:
    metadata:
      labels:
        app: redis
        role: primary
    spec:
      nodeSelector:
        role: primary
      containers:
      - name: redis
        image: redis:7
        command: ["redis-server", "--requirepass", "tnt_redis_pass",
                  "--replica-announce-ip", "redis-primary.data.svc.cluster.local"]
        ports:
        - containerPort: 6379
        volumeMounts:
        - name: data
          mountPath: /data
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: [ReadWriteOnce]
      resources:
        requests:
          storage: 2Gi
---
apiVersion: v1
kind: Service
metadata:
  name: redis-primary
  namespace: data
spec:
  selector:
    app: redis
    role: primary
  ports:
  - port: 6379
    targetPort: 6379
---
# Redis Replica (VM2)
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis-replica
  namespace: data
spec:
  serviceName: redis-replica
  replicas: 1
  selector:
    matchLabels:
      app: redis
      role: replica
  template:
    metadata:
      labels:
        app: redis
        role: replica
    spec:
      nodeSelector:
        role: replica
      containers:
      - name: redis
        image: redis:7
        command: ["redis-server",
                  "--requirepass", "tnt_redis_pass",
                  "--masterauth", "tnt_redis_pass",
                  "--replicaof", "redis-primary.data.svc.cluster.local", "6379"]
        ports:
        - containerPort: 6379
        volumeMounts:
        - name: data
          mountPath: /data
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: [ReadWriteOnce]
      resources:
        requests:
          storage: 2Gi
---
apiVersion: v1
kind: Service
metadata:
  name: redis-replica
  namespace: data
spec:
  selector:
    app: redis
    role: replica
  ports:
  - port: 6379
    targetPort: 6379
---
# Redis Sentinel (3 instances — quorum=2)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis-sentinel
  namespace: data
spec:
  replicas: 3
  selector:
    matchLabels:
      app: redis-sentinel
  template:
    metadata:
      labels:
        app: redis-sentinel
    spec:
      containers:
      - name: sentinel
        image: redis:7
        command:
        - bash
        - -c
        - |
          until REDIS_IP=$(getent hosts redis-primary.data.svc.cluster.local 2>/dev/null | awk 'NR==1{print $1}') && [ -n "$REDIS_IP" ]; do
            echo "Waiting for redis-primary DNS..."; sleep 3
          done
          until redis-cli -h "$REDIS_IP" -a tnt_redis_pass ping 2>/dev/null | grep -q PONG; do
            echo "Waiting for redis-primary to accept connections..."; sleep 3
          done
          echo "port 26379" > /tmp/sentinel.conf
          echo "sentinel monitor mymaster $REDIS_IP 6379 2" >> /tmp/sentinel.conf
          echo "sentinel auth-pass mymaster tnt_redis_pass" >> /tmp/sentinel.conf
          echo "sentinel down-after-milliseconds mymaster 5000" >> /tmp/sentinel.conf
          echo "sentinel failover-timeout mymaster 60000" >> /tmp/sentinel.conf
          echo "sentinel parallel-syncs mymaster 1" >> /tmp/sentinel.conf
          redis-sentinel /tmp/sentinel.conf
        ports:
        - containerPort: 26379
---
apiVersion: v1
kind: Service
metadata:
  name: redis-sentinel
  namespace: data
spec:
  selector:
    app: redis-sentinel
  ports:
  - port: 26379
    targetPort: 26379
EOF

echo ""
echo "======================================"
echo "Chờ pods lên..."
echo "======================================"
kubectl -n data get pods -w
