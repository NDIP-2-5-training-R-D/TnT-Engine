from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_env: str = "development"
    log_level: str = "info"

    # Auth — in production this would be validated against a real vault
    vault_token: str = "mock-vault-token"

    # Adapter selection (future: "openbao", "redis", "postgres")
    crypto_adapter: str = "mock"
    db_adapter: str = "mock"

    # Uvicorn
    host: str = "0.0.0.0"
    port: int = 8000


settings = Settings()
