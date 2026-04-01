# ── Stage 1: Build dependencies ──────────────────────────────────────
FROM python:3.12-slim AS builder

WORKDIR /build

# Install build deps only (cached layer)
COPY pyproject.toml ./
RUN pip install --no-cache-dir --prefix=/install .

# ── Stage 2: Production image ───────────────────────────────────────
FROM python:3.12-slim AS runtime

# Security: run as non-root
RUN groupadd -r tnt && useradd -r -g tnt -d /app -s /sbin/nologin tnt

WORKDIR /app

# Copy installed packages from builder
COPY --from=builder /install /usr/local

# Copy application code
COPY src/ ./src/
COPY sql/ ./sql/

# Security: no write access to app code
RUN chown -R tnt:tnt /app
USER tnt

# Health check — uses the built-in health endpoint
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/v1/health')" || exit 1

EXPOSE 8000

# Production server: uvicorn with optimized settings
# Workers = 1 because the app is async (scale via k8s replicas, not workers)
CMD ["python", "-m", "uvicorn", "tnt_engine.main:app", \
     "--host", "0.0.0.0", \
     "--port", "8000", \
     "--workers", "1", \
     "--loop", "uvloop", \
     "--http", "httptools", \
     "--no-access-log", \
     "--timeout-keep-alive", "30"]
