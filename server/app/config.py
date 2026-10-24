"""Настройки сервера из переменных окружения (12-factor)."""
from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path


def _bool(v: str | None, default: bool) -> bool:
    if v is None or v == "":
        return default
    return v.strip().lower() in {"1", "true", "yes", "on"}


def _db_url(raw: str | None, data_dir: Path) -> str:
    if not raw:
        return f"sqlite:///{(data_dir / 'kadra.db').as_posix()}"
    # Render/Heroku выдают postgres:// — SQLAlchemy 2 нужен явный драйвер
    if raw.startswith("postgres://"):
        raw = "postgresql://" + raw[len("postgres://") :]
    if raw.startswith("postgresql://"):
        raw = "postgresql+psycopg://" + raw[len("postgresql://") :]
    return raw


@dataclass
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(os.environ.get("DATA_DIR", "./data")).resolve())
    secret_key: str = field(default_factory=lambda: os.environ.get("SECRET_KEY", ""))
    cors_origins: list[str] = field(default_factory=lambda: [o.strip() for o in os.environ.get("CORS_ORIGINS", "*").split(",") if o.strip()])
    max_upload_mb: int = field(default_factory=lambda: int(os.environ.get("MAX_UPLOAD_MB", "4096")))
    token_ttl_hours: int = field(default_factory=lambda: int(os.environ.get("TOKEN_TTL_HOURS", "720")))
    allow_registration: bool = field(default_factory=lambda: _bool(os.environ.get("ALLOW_REGISTRATION"), True))
    frontend_dir: str | None = field(default_factory=lambda: os.environ.get("FRONTEND_DIR") or None)
    database_url: str = ""
    storage_dir: Path = Path()

    def __post_init__(self):
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.database_url = _db_url(os.environ.get("DATABASE_URL"), self.data_dir)
        self.storage_dir = Path(os.environ.get("STORAGE_DIR", str(self.data_dir / "assets"))).resolve()
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        if not self.secret_key:
            # Для разработки: ключ хранится в DATA_DIR, чтобы токены переживали перезапуск.
            key_file = self.data_dir / ".secret_key"
            if key_file.exists():
                self.secret_key = key_file.read_text().strip()
            else:
                self.secret_key = secrets.token_urlsafe(48)
                key_file.write_text(self.secret_key)

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024


_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings


def reset_settings() -> None:
    """Для тестов: перечитать окружение."""
    global _settings
    _settings = None
