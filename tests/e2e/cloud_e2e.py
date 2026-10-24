"""E2E: синхронизация с сервером. Браузер A сохраняет проект с медиа на сервер,
«чистый» браузер B (пустой IndexedDB) входит в тот же аккаунт и открывает проект.

Запуск: python tests/e2e/cloud_e2e.py /tmp/kadra-media
(сервер поднимается автоматически из server/ на свободном порту)
"""
import asyncio
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from playwright.async_api import async_playwright

from harness import ROOT, chrome_path, route_cdn, start_static_server

MEDIA = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/kadra-media")


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


async def login(page, server, register):
    await page.evaluate("() => window.__kadraApp.run('cloud.settings')")
    await page.wait_for_selector(".modal input[type=url]")
    await page.fill(".modal input[type=url]", server)
    await page.fill(".modal input[autocomplete=username]", "tester")
    await page.fill(".modal input[type=password]", "secret-pass-123")
    await page.locator(".modal .btn", has_text="Регистрация" if register else "Войти").click()
    await page.wait_for_function("document.querySelector('.toast') && /Вход выполнен|Аккаунт создан/.test(document.body.innerText)", timeout=10000)


async def main():
    port = free_port()
    data = tempfile.mkdtemp(prefix="kadra-srv-")
    env = {**os.environ, "DATA_DIR": data, "SECRET_KEY": "e2e-secret-key-0123456789-abcdefghijklmnop", "CORS_ORIGINS": "*"}
    py = os.environ.get("SERVER_PYTHON", sys.executable)
    srv = subprocess.Popen([py, "-m", "uvicorn", "app.main:app", "--port", str(port), "--log-level", "warning"], cwd=ROOT / "server", env=env)
    server = f"http://127.0.0.1:{port}"
    for _ in range(50):
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
            break
        except OSError:
            time.sleep(0.2)
    httpd, base = start_static_server()
    ok = True
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(executable_path=chrome_path())
            # ---- браузер A ----
            a = await browser.new_context(viewport={"width": 1500, "height": 900})
            await route_cdn(a)
            pa = await a.new_page()
            await pa.goto(base + "/index.html")
            await pa.wait_for_selector("html[data-ready='1']", state="attached")
            async with pa.expect_file_chooser() as fc:
                await pa.locator("[data-panel='project'] .panel-footer .icon-btn").first.click()
            await (await fc.value).set_files([str(MEDIA / "clip1.mp4"), str(MEDIA / "music.mp3")])
            await pa.wait_for_function("window.__kadraStore.project.media.length === 2", timeout=30000)
            await pa.evaluate("() => { const s = window.__kadraStore; s.ui.projectSelection = new Set(s.project.media.map(m => m.id)); window.__kadraApp.insertFromProject('overwrite'); }")
            await pa.wait_for_timeout(500)
            await login(pa, server, register=True)
            await pa.evaluate("() => window.__kadraApp.run('cloud.save')")
            await pa.wait_for_function("window.__kadraStore.project.cloud && window.__kadraStore.project.media.every(m => m.cloudAssetId)", timeout=30000)
            pid = await pa.evaluate("window.__kadraStore.project.id")
            clips_a = await pa.evaluate("window.__kadraStore.seq.tracks.reduce((n, t) => n + t.clips.length, 0)")
            print("✔ A: проект и медиа загружены на сервер", pid, "клипов:", clips_a)
            # ---- браузер B (пустое хранилище) ----
            b = await browser.new_context(viewport={"width": 1500, "height": 900})
            await route_cdn(b)
            pb = await b.new_page()
            await pb.goto(base + "/index.html")
            await pb.wait_for_selector("html[data-ready='1']", state="attached")
            await login(pb, server, register=False)
            await pb.evaluate("() => window.__kadraApp.run('cloud.open')")
            await pb.locator(".modal .project-row").first.click()
            await pb.wait_for_function(f"window.__kadraStore.project.id === '{pid}'", timeout=30000)
            await pb.wait_for_timeout(1500)
            res = await pb.evaluate("""async () => { const s = window.__kadraStore; const { mediaCache } = await import('./js/media/mediaCache.js');
              const blobs = await Promise.all(s.project.media.map(m => mediaCache.blob(m)));
              return { clips: s.seq.tracks.reduce((n, t) => n + t.clips.length, 0), online: blobs.every(Boolean), sizes: blobs.map(b => b && b.size) }; }""")
            good = res["clips"] == clips_a and res["online"]
            print(("✔" if good else "✘"), "B: проект открыт с сервера, медиа скачаны в IndexedDB", res)
            ok &= good
            await pb.screenshot(path=str(Path(tempfile.gettempdir()) / "kadra_cloud_b.png"))
            await browser.close()
    finally:
        httpd.shutdown()
        srv.terminate()
    sys.exit(0 if ok else 1)


asyncio.run(main())
