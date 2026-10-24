"""Общая обвязка e2e-тестов Kadra (Playwright + Chromium/Chrome).

* Поднимает статический HTTP-сервер для каталога web/ (как GitHub Pages).
* Если задан VENDOR_DIR (каталог node_modules с mediabunny, @mediabunny/aac-encoder,
  @ffmpeg/core), запросы к cdn.jsdelivr.net обслуживаются локально — тесты
  работают без доступа к интернету. Без VENDOR_DIR используется настоящий CDN.
"""
from __future__ import annotations

import functools
import http.server
import os
import re
import socketserver
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / "web"
VENDOR_DIR = os.environ.get("VENDOR_DIR")
CDN_RE = re.compile(r"https://cdn\.jsdelivr\.net/npm/(@?[^@/]+(?:/[^@/]+)?)@([^/]+)/(.*)")


class _Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):  # тишина в логах
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def start_static_server(port: int = 0):
    handler = functools.partial(_Handler, directory=str(WEB))
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://localhost:{httpd.server_address[1]}"


MIME = {".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json"}


async def route_cdn(context):
    """Подмена CDN локальными копиями пакетов (только если задан VENDOR_DIR)."""
    if not VENDOR_DIR:
        return

    async def handler(route):
        m = CDN_RE.match(route.request.url)
        if not m:
            return await route.continue_()
        pkg, _ver, rest = m.groups()
        path = Path(VENDOR_DIR) / pkg / rest
        if not path.exists():
            return await route.fulfill(status=404, body=f"not vendored: {path}")
        body = path.read_bytes()
        await route.fulfill(
            status=200,
            body=body,
            headers={"Content-Type": MIME.get(path.suffix, "application/octet-stream"), "Access-Control-Allow-Origin": "*"},
        )

    await context.route("https://cdn.jsdelivr.net/**", handler)


def chrome_path() -> str | None:
    """Путь к Google Chrome (если установлен). KADRA_BROWSER=chromium — встроенный Chromium Playwright."""
    if os.environ.get("KADRA_BROWSER") == "chromium":
        return None
    for p in (os.environ.get("CHROME_PATH"), "/opt/google/chrome/chrome"):
        if p and Path(p).exists():
            return p
    return None
