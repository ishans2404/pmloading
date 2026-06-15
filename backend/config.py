from fastapi_memory import cached_singleton

class Config:
    UPSTREAM_BASE: str = "http://10.145.2.248:8181/MES_MOB/APP"
    # UPSTREAM_BASE: str = "https://bspapp.sail-bhilaisteel.com/MES_MOB/APP"
    LOADING_REPORT_CACHE_TTL: int = 5 * 3600
    DESTINATION_CACHE_TTL: int = 12 * 3600
    REQUEST_TIMEOUT: float = 900.0
    # How often the background loop refreshes loader-report cache (must be < LOADING_REPORT_CACHE_TTL)
    REFRESH_INTERVAL: int = 4 * 3600
    CACHE_INVALIDATION_KEY: str = "BSPPM123"
    # ALLOWED_ORIGINS: list[str] = ["http://localhost:8705", "http://127.0.0.1:8705", "http://10.145.8.23:8705", "https://bspapp.sail-bhilaisteel.com",]
    ALLOWED_ORIGINS: list[str] = ["*"]

@cached_singleton
def get_config() -> Config:
    return Config()

config = get_config()