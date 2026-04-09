from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # PostgreSQL (primary)
    db_host: str = "localhost"
    db_port: int = 5432
    db_name: str = "tnt_engine"
    db_user: str = "tnt"
    db_password: str = "tnt_secret"
    db_pool_min: int = 10
    db_pool_max: int = 50
    db_statement_timeout_ms: int = 10_000

    # PostgreSQL TLS
    db_ssl_mode: str = "disable"        # "disable", "require", "verify-ca", "verify-full"
    db_ssl_ca_cert: str = ""            # Path to CA certificate file
    db_ssl_client_cert: str = ""        # Path to client certificate (mTLS)
    db_ssl_client_key: str = ""         # Path to client private key (mTLS)

    # PostgreSQL (read replica — optional)
    db_read_host: str = ""
    db_read_port: int = 5432

    # Redis (L2 cache)
    redis_url: str = "redis://localhost:6379/0"
    redis_token_ttl_seconds: int = 3600
    redis_max_connections: int = 50
    redis_socket_timeout_seconds: float = 2.0
    redis_connect_timeout_seconds: float = 3.0

    # Redis TLS
    redis_ssl: bool = False             # Enable TLS (auto-rewrites redis:// to rediss://)
    redis_ca_cert: str = ""             # Path to CA certificate
    redis_ssl_cert: str = ""            # Client cert path (mTLS)
    redis_ssl_key: str = ""             # Client key path (mTLS)

    # L1 in-memory cache
    l1_max_size: int = 10_000
    l1_ttl_seconds: int = 300

    # OpenBao / Vault
    crypto_base_url: str = "http://localhost:8200/v1"
    crypto_token: str = "dev-token"
    crypto_transit_key: str = "tnt-key"
    crypto_hmac_key: str = "tnt-hmac"
    crypto_aes_gcm_key: str = "tnt-aes-gcm"   # Dedicated AES-256-GCM96 transit key
    crypto_fpe_key: str = "tnt-fpe"            # Dedicated FPE / FF3-1 key
    crypto_timeout_seconds: float = 5.0
    crypto_max_retries: int = 3
    crypto_verify_ssl: bool = True      # Verify OpenBao server certificate
    crypto_ca_cert: str = ""            # Path to custom CA cert for OpenBao
    crypto_client_cert: str = ""        # Client cert path (mTLS to OpenBao)
    crypto_client_key: str = ""         # Client key path (mTLS to OpenBao)

    # OpenBao auth method: "static", "approle", "kubernetes"
    vault_auth_method: str = "static"
    # AppRole auth
    vault_approle_role_id: str = ""
    vault_approle_secret_id: str = ""
    vault_approle_mount: str = "approle"
    # Kubernetes auth
    vault_k8s_role: str = ""
    vault_k8s_mount: str = "kubernetes"
    vault_k8s_token_path: str = "/var/run/secrets/kubernetes.io/serviceaccount/token"
    # Token renewal
    vault_token_renewal_buffer_seconds: int = 300  # renew when TTL < this

    # HSM / PKCS#11
    hsm_enabled: bool = False
    hsm_pkcs11_library: str = "/usr/lib/softhsm/libsofthsm2.so"
    hsm_slot: int = 0
    hsm_pin: str = ""
    hsm_encrypt_key_label: str = "tnt-encrypt-key"
    hsm_hmac_key_label: str = "tnt-hmac-key"
    hsm_session_pool_size: int = 5
    hsm_operation_timeout_seconds: float = 10.0

    # Crypto backend selection: "openbao", "hsm", "sandbox"
    crypto_backend: str = "openbao"

    # Environment: "development", "staging", "production"
    # Used to enforce safety guards (e.g., block sandbox in production)
    environment: str = "development"

    # Circuit breaker
    cb_failure_threshold: int = 5
    cb_recovery_timeout_seconds: float = 30.0
    cb_half_open_max_calls: int = 3

    # Service
    token_prefix: str = "tok_"
    token_length: int = 32

    # Idempotency / dedup
    dedup_ttl_seconds: int = 3600

    # Audit delivery
    audit_buffer_max_size: int = 5000
    audit_flush_interval_seconds: float = 2.0
    audit_flush_batch_size: int = 500
    audit_max_retries: int = 3
    audit_retry_backoff_seconds: float = 1.0
    audit_dlq_path: str = "/tmp/tnt-audit-dlq.jsonl"

    # Workers
    worker_cleanup_interval_seconds: int = 60
    worker_cleanup_batch_size: int = 1000
    worker_reencrypt_batch_size: int = 500
    worker_cache_rebuild_batch_size: int = 2000

    model_config = {"env_prefix": "TNT_"}


settings = Settings()
