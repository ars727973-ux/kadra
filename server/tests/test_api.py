"""Тесты API сервера: auth, проекты, ассеты (дедупликация, Range, изоляция пользователей)."""
import hashlib
import importlib

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SECRET_KEY", "test-secret-key-for-pytest-0123456789abcdef")
    monkeypatch.setenv("MAX_UPLOAD_MB", "1")
    monkeypatch.delenv("DATABASE_URL", raising=False)
    from app import config, db

    config.reset_settings()
    db._SessionLocal = None
    import app.main as main

    importlib.reload(main)
    with TestClient(main.app) as c:
        yield c


def auth(c, name="alice", password="password123", register=True):
    r = c.post("/api/auth/register" if register else "/api/auth/login", json={"username": name, "password": password})
    assert r.status_code in (200, 201), r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


PROJECT = {"format": "kadra-project", "version": 1, "id": "p1", "name": "Тест", "media": [], "sequences": []}


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"


def test_register_login_me(client):
    h = auth(client)
    assert client.get("/api/auth/me", headers=h).json()["username"] == "alice"
    assert client.post("/api/auth/register", json={"username": "alice", "password": "password123"}).status_code == 409
    assert client.post("/api/auth/login", json={"username": "alice", "password": "wrongpass1"}).status_code == 401
    h2 = auth(client, register=False)
    assert client.get("/api/auth/me", headers=h2).status_code == 200
    assert client.get("/api/auth/me").status_code == 401
    assert client.get("/api/auth/me", headers={"Authorization": "Bearer garbage"}).status_code == 401


def test_projects_crud(client):
    h = auth(client)
    assert client.get("/api/projects", headers=h).json() == []
    r = client.put("/api/projects/p1", headers=h, json={"name": "Тест", "data": PROJECT})
    assert r.status_code == 200 and r.json()["id"] == "p1"
    r = client.put("/api/projects/p1", headers=h, json={"name": "Тест 2", "data": {**PROJECT, "name": "Тест 2"}})
    assert r.json()["name"] == "Тест 2"
    lst = client.get("/api/projects", headers=h).json()
    assert len(lst) == 1 and lst[0]["name"] == "Тест 2"
    got = client.get("/api/projects/p1", headers=h).json()
    assert got["data"]["name"] == "Тест 2"
    assert client.put("/api/projects/p2", headers=h, json={"name": "x", "data": {"format": "other"}}).status_code == 422
    assert client.delete("/api/projects/p1", headers=h).status_code == 204
    assert client.get("/api/projects/p1", headers=h).status_code == 404


def test_assets_dedupe_range_and_isolation(client):
    h = auth(client)
    payload = bytes(range(256)) * 1000  # 256 КБ
    sha = hashlib.sha256(payload).hexdigest()
    assert client.get(f"/api/assets/lookup?sha256={sha}", headers=h).status_code == 404
    r = client.post("/api/assets", headers=h, files={"file": ("clip.mp4", payload, "video/mp4")})
    assert r.status_code == 201, r.text
    asset = r.json()
    assert asset["sha256"] == sha and asset["size"] == len(payload)
    # повторная загрузка — тот же ассет
    r2 = client.post("/api/assets", headers=h, files={"file": ("copy.mp4", payload, "video/mp4")})
    assert r2.json()["id"] == asset["id"]
    assert client.get(f"/api/assets/lookup?sha256={sha}", headers=h).json()["id"] == asset["id"]
    # скачивание целиком и диапазоном
    full = client.get(f"/api/assets/{asset['id']}", headers=h)
    assert full.status_code == 200 and full.content == payload
    part = client.get(f"/api/assets/{asset['id']}", headers={**h, "Range": "bytes=100-199"})
    assert part.status_code == 206 and part.content == payload[100:200]
    # другой пользователь не видит чужое
    hb = auth(client, name="bob")
    assert client.get(f"/api/assets/{asset['id']}", headers=hb).status_code == 404
    assert client.get(f"/api/assets/lookup?sha256={sha}", headers=hb).status_code == 404
    # лимит размера (MAX_UPLOAD_MB=1)
    big = b"x" * (1024 * 1024 + 10)
    assert client.post("/api/assets", headers=h, files={"file": ("big.bin", big, "application/octet-stream")}).status_code == 413
    assert client.delete(f"/api/assets/{asset['id']}", headers=h).status_code == 204
    assert client.get(f"/api/assets/{asset['id']}", headers=h).status_code == 404


def test_registration_can_be_disabled(client, monkeypatch):
    from app import config

    config.get_settings().allow_registration = False
    r = client.post("/api/auth/register", json={"username": "carol", "password": "password123"})
    assert r.status_code == 403


def test_cors_preflight(client):
    r = client.options("/api/projects", headers={"Origin": "https://user.github.io", "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "authorization,content-type"})
    assert r.status_code == 200
    assert r.headers.get("access-control-allow-origin") in ("*", "https://user.github.io")
