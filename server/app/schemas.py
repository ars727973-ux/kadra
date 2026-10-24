"""Схемы запросов/ответов API."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class Credentials(BaseModel):
    username: str = Field(min_length=3, max_length=64, pattern=r"^[A-Za-z0-9_.@-]+$")
    password: str = Field(min_length=8, max_length=256)


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    username: str


class UserOut(BaseModel):
    id: int
    username: str
    created_at: datetime


class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    data: dict[str, Any]


class ProjectSummary(BaseModel):
    id: str
    name: str
    size: int
    created_at: datetime
    updated_at: datetime


class ProjectOut(ProjectSummary):
    data: dict[str, Any]


class AssetOut(BaseModel):
    id: str
    sha256: str
    filename: str
    mime: str
    size: int
    created_at: datetime
