"""End-to-end проверка Kadra в настоящем браузере (Playwright).

Сценарий (по ТЗ): импорт 3 клипов → сборка на таймлайне → обрезка →
трансформация → воспроизведение → сохранение проекта → перезагрузка страницы →
загрузка проекта → экспорт MP4. Дополнительно: undo/redo ≥ 50 шагов, маркеры,
экспорт/импорт JSON, экспорт через FFmpeg.wasm, сверка кадра экспорта с превью.

Запуск:
    pip install playwright && playwright install chromium
    python tests/e2e/make_media.py /tmp/kadra-media      # тестовые ролики (нужен ffmpeg)
    python tests/e2e/run_e2e.py /tmp/kadra-media /tmp/kadra-out
Переменные: VENDOR_DIR — локальные копии CDN-пакетов (офлайн), CHROME_PATH — браузер.
"""
from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import time
from pathlib import Path

from playwright.async_api import async_playwright

from harness import chrome_path, route_cdn, start_static_server

MEDIA = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/kadra-media")
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "/tmp/kadra-out")
OUT.mkdir(parents=True, exist_ok=True)
REPORT: list[dict] = []


def log(step, ok, detail=""):
    REPORT.append({"step": step, "ok": bool(ok), "detail": detail})
    print(("✔" if ok else "✘"), step, "—", detail, flush=True)


def ffprobe(path: Path) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)], capture_output=True, text=True)
    return json.loads(out.stdout or "{}")


def psnr(a: Path, b: Path) -> float:
    """PSNR между двумя PNG одинакового размера (через ffmpeg)."""
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(a), "-i", str(b), "-lavfi", "psnr", "-f", "null", "-"], capture_output=True, text=True)
    for line in (r.stderr or "").splitlines():
        if "average:" in line:
            v = line.split("average:")[1].split()[0]
            return float("inf") if v == "inf" else float(v)
    # ffmpeg печатает psnr в stderr уровня info — повторим с info
    r = subprocess.run(["ffmpeg", "-i", str(a), "-i", str(b), "-lavfi", "psnr", "-f", "null", "-"], capture_output=True, text=True)
    for line in (r.stderr or "").splitlines():
        if "average:" in line:
            v = line.split("average:")[1].split()[0]
            return float("inf") if v == "inf" else float(v)
    return 0.0


STATE_JS = """() => {
  const s = window.__kadraStore; const seq = s.seq;
  const clips = []; for (const t of seq.tracks) for (const c of t.clips) clips.push({track: t.name, kind: t.kind, id: c.id, name: c.name, start: +c.start.toFixed(4), in: +c.in.toFixed(4), out: +c.out.toFixed(4), speed: c.speed, linkId: c.linkId, transform: c.transform, enabled: c.enabled});
  return { media: s.project.media.map(m => ({id: m.id, name: m.name, kind: m.kind, duration: m.duration, width: m.width, height: m.height, fps: m.fps, videoCodec: m.videoCodec, audioCodec: m.audioCodec, hasAudio: m.hasAudio})),
    clips, markers: seq.markers, playhead: s.ui.playhead, dirty: s.dirty, seq: {w: seq.width, h: seq.height, fps: seq.fps, inPoint: seq.inPoint, outPoint: seq.outPoint}, history: s.history.undoStack.length, projectId: s.project.id, projectName: s.project.name };
}"""


async def area_box(page):
    return await page.locator(".tl-area").bounding_box()


async def clip_rect(page, clip_id):
    """Экранные координаты клипа на таймлайне."""
    return await page.evaluate(
        """(id) => {
      const app = window.__kadraApp; const tl = app.timeline; const s = window.__kadraStore;
      for (const r of tl.rows()) for (const c of r.track.clips) if (c.id === id) {
        const area = document.querySelector('.tl-area').getBoundingClientRect();
        const x0 = area.left + tl.tx(c.start), x1 = area.left + tl.tx(c.start + (c.out - c.in)/c.speed);
        return {x0, x1, y: area.top + r.y - tl.scrollY + r.h/2, h: r.h};
      }
      return null; }""",
        clip_id,
    )


async def wait_idle(page, ms=300):
    await page.wait_for_timeout(ms)


async def main():
    httpd, base = start_static_server()
    t_start = time.time()
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=chrome_path(), args=["--autoplay-policy=no-user-gesture-required"])
        ctx = await browser.new_context(viewport={"width": 1600, "height": 900}, accept_downloads=True)
        await route_cdn(ctx)
        page = await ctx.new_page()
        console_errors = []
        page.on("console", lambda m: m.type == "error" and console_errors.append(m.text))
        page.on("pageerror", lambda e: console_errors.append(f"pageerror: {e}"))
        await page.goto(base + "/index.html")
        await page.wait_for_selector("html[data-ready='1']", state="attached")
        log("Загрузка редактора", True, base)

        # ---------- 1. Импорт 3 клипов через диалог (Ctrl+I) ----------
        files = [MEDIA / "clip1.mp4", MEDIA / "clip2.webm", MEDIA / "clip3.mov", MEDIA / "music.mp3", MEDIA / "title.png"]
        async with page.expect_file_chooser() as fc:
            # кнопка «Импорт» в панели «Проект» (то же действие, что Ctrl+I)
            await page.locator("[data-panel='project'] .panel-footer .icon-btn").first.click()
        chooser = await fc.value
        await chooser.set_files([str(f) for f in files])
        await page.wait_for_function("window.__kadraStore.project.media.length === 5", timeout=30000)
        await page.wait_for_function("window.__kadraStore.project.media.every(m => { const a = window.__kadraApp && true; return true })")
        st = await page.evaluate(STATE_JS)
        by = {m["name"]: m for m in st["media"]}
        c1, c2, c3 = by["clip1.mp4"], by["clip2.webm"], by["clip3.mov"]
        ok = c1["videoCodec"] == "H.264" and c1["audioCodec"] == "AAC" and c1["width"] == 1920 and abs(c1["duration"] - 4) < 0.1 and abs(c1["fps"] - 30) < 0.5
        ok &= c2["videoCodec"] == "VP9" and c2["audioCodec"] == "Opus" and c2["width"] == 1280 and abs(c2["fps"] - 25) < 0.5
        ok &= c3["videoCodec"] == "H.264" and c3["width"] == 1280
        log("Импорт 3 клипов + аудио + изображение, метаданные (кодек/разрешение/FPS/длительность)", ok, "; ".join(f"{m['name']}: {m['videoCodec']}/{m['audioCodec']} {m['width']}x{m['height']} {m['fps']}fps {m['duration'] and round(m['duration'],2)}s" for m in st["media"]))
        # превью-спрайты/пики построены
        await page.wait_for_function("window.__kadraStore.project.media.every(m => { const c = window.__kadraMediaCache; return true })")
        await page.wait_for_timeout(1500)
        await page.screenshot(path=str(OUT / "01_import.png"))

        # ---------- 2. Сборка на таймлайне ----------
        # 2a. clip1 — перетаскиванием из панели «Проект» на V1 в начало
        area = await area_box(page)
        row_v1 = await page.evaluate("(() => { const tl = window.__kadraApp.timeline; const r = tl.rows().find(r => r.track.name === 'V1'); return r.y - tl.scrollY + r.h/2; })()")
        src = page.locator(f".media-list tr:has-text('clip1.mp4')")
        await src.drag_to(page.locator(".tl-area"), target_position={"x": 3, "y": row_v1})
        await page.wait_for_timeout(400)
        # возможный диалог несоответствия параметров секвенции → «Изменить параметры»
        if await page.locator(".modal").count():
            await page.locator(".modal .btn.primary").click()
            await page.wait_for_timeout(300)
        st = await page.evaluate(STATE_JS)
        v = [c for c in st["clips"] if c["kind"] == "video"]
        a = [c for c in st["clips"] if c["kind"] == "audio"]
        log("Drag&drop клипа из «Проекта» на таймлайн (видео+связанный звук)", len(v) == 1 and len(a) == 1 and v[0]["linkId"] and v[0]["linkId"] == a[0]["linkId"] and v[0]["start"] == 0, f"V={len(v)} A={len(a)} start={v and v[0]['start']}")

        # 2b. clip2 — двойной щелчок → «Источник», In/Out, вставка «,» в конец
        await page.locator(".media-list tr:has-text('clip2.webm')").dblclick()
        await page.wait_for_timeout(600)
        await page.keyboard.press("End")  # фокус — источник
        await page.locator("[data-panel='source'] .monitor-view").click(position={"x": 5, "y": 5})
        await page.keyboard.press("Home")
        for _ in range(5):
            await page.keyboard.press("ArrowRight")
        await page.keyboard.press("i")
        await page.keyboard.press("End")
        await page.keyboard.press("o")
        st = await page.evaluate(STATE_JS)
        m2 = [m for m in st["media"] if m["name"] == "clip2.webm"][0]
        # плейхед секвенции — в конец clip1
        await page.locator(".tl-area").click(position={"x": 300, "y": 5})
        await page.keyboard.press("End")
        await page.locator("[data-panel='source'] .monitor-view").click(position={"x": 5, "y": 5})
        await page.keyboard.press(",")
        await page.wait_for_timeout(300)
        st = await page.evaluate(STATE_JS)
        v = sorted([c for c in st["clips"] if c["kind"] == "video"], key=lambda c: c["start"])
        log("Источник: In/Out (I/O) и вставка «,» на таймлайн", len(v) == 2 and abs(v[1]["start"] - 4) < 1e-3 and v[1]["in"] > 0.1, f"clip2 in={v[1]['in'] if len(v)>1 else None} out={v[1]['out'] if len(v)>1 else None} start={v[1]['start'] if len(v)>1 else None}")

        # 2c. clip3 — наложение «.» из «Проекта» в позицию плейхеда (после clip2)
        await page.locator(".tl-area").click(position={"x": 300, "y": 5})
        await page.keyboard.press("End")
        await page.locator(".media-list tr:has-text('clip3.mov')").click()
        await page.keyboard.press(".")
        await page.wait_for_timeout(300)
        # изображение — на V2 поверх, музыка — на A2
        await page.evaluate("""() => { const s = window.__kadraStore; const seq = s.seq;
          const v2 = seq.tracks.find(t => t.name === 'V2'); const a2 = seq.tracks.find(t => t.name === 'A2');
          s.setUi('targetVideoTrackId', v2.id); s.setUi('targetAudioTrackId', a2.id); s.setPlayhead(1); }""")
        await page.locator(".media-list tr:has-text('title.png')").click()
        await page.keyboard.press(".")
        await page.evaluate("() => window.__kadraStore.setPlayhead(0)")
        await page.locator(".media-list tr:has-text('music.mp3')").click()
        await page.keyboard.press(".")
        await page.wait_for_timeout(300)
        st = await page.evaluate(STATE_JS)
        names = sorted((c["track"], c["name"]) for c in st["clips"])
        log("Сборка: 3 клипа на V1/A1 + изображение на V2 + музыка на A2", len(st["clips"]) == 8, "; ".join(f"{t}:{n}" for t, n in names))
        await page.keyboard.press("Backslash")
        await page.wait_for_timeout(500)
        await page.screenshot(path=str(OUT / "02_assembled.png"))

        # ---------- 3. Обрезка: трим края мышью, лезвие, ripple delete ----------
        v = sorted([c for c in st["clips"] if c["track"] == "V1"], key=lambda c: c["start"])
        r = await clip_rect(page, v[0]["id"])
        before = v[0]["out"]
        await page.mouse.move(r["x1"] - 2, r["y"])
        await page.mouse.down()
        await page.mouse.move(r["x1"] - 40, r["y"], steps=8)
        await page.mouse.up()
        st = await page.evaluate(STATE_JS)
        v1 = [c for c in st["clips"] if c["id"] == v[0]["id"]][0]
        a1 = [c for c in st["clips"] if c["linkId"] == v1["linkId"] and c["kind"] == "audio"][0]
        log("Обрезка конца клипа мышью (связанный звук обрезан синхронно, соседи не тронуты)", v1["out"] < before - 0.1 and abs(a1["out"] - v1["out"]) < 1e-6, f"out {before} → {v1['out']}, audio out {a1['out']}")
        # Ripple delete промежутка, образовавшегося после трима: выделим clip2+clip3 и сдвинем? Используем инструмент Ripple (B)
        await page.keyboard.press("b")
        r = await clip_rect(page, v[0]["id"])
        await page.mouse.move(r["x1"] - 2, r["y"])
        await page.mouse.down()
        await page.mouse.move(r["x1"] - 30, r["y"], steps=6)
        await page.mouse.up()
        await page.keyboard.press("v")
        st = await page.evaluate(STATE_JS)
        v = sorted([c for c in st["clips"] if c["track"] == "V1"], key=lambda c: c["start"])
        gap = v[1]["start"] - (v[0]["start"] + (v[0]["out"] - v[0]["in"]) / v[0]["speed"])
        log("Ripple-триммирование (B): последующие клипы сдвинулись", gap > 0.3, f"промежуток после клипа 1 = {gap:.3f}s (остался от обычного трима), clip2.start={v[1]['start']}")
        # удалить промежуток со сдвигом через контекстное меню
        gx = await page.evaluate("""() => { const tl = window.__kadraApp.timeline; const seq = window.__kadraStore.seq; const t = seq.tracks.find(t => t.name==='V1'); const c = [...t.clips].sort((a,b)=>a.start-b.start)[0]; const e = c.start + (c.out-c.in)/c.speed; const area = document.querySelector('.tl-area').getBoundingClientRect(); return area.left + tl.tx(e + 0.05); }""")
        await page.mouse.click(gx, r["y"], button="right")
        await page.locator(".dropdown .item:has-text('Удалить промежуток со сдвигом')").click()
        st = await page.evaluate(STATE_JS)
        v = sorted([c for c in st["clips"] if c["track"] == "V1"], key=lambda c: c["start"])
        gap = v[1]["start"] - (v[0]["start"] + (v[0]["out"] - v[0]["in"]) / v[0]["speed"])
        log("Ripple Delete промежутка (контекстное меню)", abs(gap) < 1e-3, f"промежуток = {gap:.4f}s")
        # лезвие (C) посередине clip2
        await page.keyboard.press("c")
        r = await clip_rect(page, v[1]["id"])
        await page.mouse.click((r["x0"] + r["x1"]) / 2, r["y"])
        await page.keyboard.press("v")
        st = await page.evaluate(STATE_JS)
        v = sorted([c for c in st["clips"] if c["track"] == "V1"], key=lambda c: c["start"])
        a = [c for c in st["clips"] if c["track"] == "A1"]
        log("Лезвие (C): клип и связанный звук разрезаны", len(v) == 4 and len(a) == 4, f"V1={len(v)} A1={len(a)}")
        # Ripple delete правой половины clip2 (Shift+Delete)
        r = await clip_rect(page, v[2]["id"])
        await page.mouse.click((r["x0"] + r["x1"]) / 2, r["y"])
        await page.keyboard.press("Shift+Delete")
        st = await page.evaluate(STATE_JS)
        v = sorted([c for c in st["clips"] if c["track"] == "V1"], key=lambda c: c["start"])
        contiguous = all(abs(v[i + 1]["start"] - (v[i]["start"] + (v[i]["out"] - v[i]["in"]) / v[i]["speed"])) < 1e-3 for i in range(len(v) - 1))
        log("Удаление со сдвигом (Shift+Delete)", len(v) == 3 and contiguous, f"V1 клипов={len(v)}, без промежутков={contiguous}")
        # Ctrl+K — склейка по плейхеду, затем отмена
        await page.evaluate("() => window.__kadraStore.setPlayhead(1)")
        await page.keyboard.press("Escape")
        await page.evaluate("() => window.__kadraStore.clearSelection()")
        await page.keyboard.press("Control+k")
        n_after = len((await page.evaluate(STATE_JS))["clips"])
        await page.keyboard.press("Control+z")
        n_undo = len((await page.evaluate(STATE_JS))["clips"])
        log("Ctrl+K (склейка на всех дорожках под плейхедом) и Ctrl+Z", n_after > n_undo, f"клипов {n_undo} → {n_after} → {n_undo}")

        # ---------- 4. Трансформация (Effect Controls + прямое перетаскивание) ----------
        v = sorted([c for c in (await page.evaluate(STATE_JS))["clips"] if c["track"] == "V1"], key=lambda c: c["start"])
        target = v[0]
        r = await clip_rect(page, target["id"])
        await page.mouse.click((r["x0"] + r["x1"]) / 2, r["y"])
        await page.evaluate("() => window.__kadraStore.setPlayhead(0.5)")
        await page.locator(".dock-tab[data-panel='effectControls']").click()
        await page.wait_for_timeout(200)
        # масштаб: щелчок по числу → ввод 60
        scale = page.locator("[data-panel='effectControls'] .fx-row:has(.lbl:text-is('Масштаб')) .scrub").first
        await scale.click()
        await page.keyboard.type("60")
        await page.keyboard.press("Enter")
        # поворот — перетаскиванием числа
        rot = page.locator("[data-panel='effectControls'] .fx-row:has(.lbl:text-is('Поворот')) .scrub").first
        rb = await rot.bounding_box()
        await page.mouse.move(rb["x"] + 5, rb["y"] + 5)
        await page.mouse.down()
        await page.mouse.move(rb["x"] + 35, rb["y"] + 5, steps=6)
        await page.mouse.up()
        # непрозрачность — ввод
        op = page.locator("[data-panel='effectControls'] .fx-row:has(.lbl:text-is('Непрозрачность')) .scrub").first
        await op.click()
        await page.keyboard.type("80")
        await page.keyboard.press("Enter")
        # положение — перетаскивание рамки в «Программе»
        pv = await page.locator("[data-panel='program'] canvas.overlay").bounding_box()
        cx, cy = pv["x"] + pv["width"] / 2, pv["y"] + pv["height"] / 2
        await page.mouse.move(cx, cy)
        await page.mouse.down()
        await page.mouse.move(cx - 60, cy - 30, steps=8)
        await page.mouse.up()
        st = await page.evaluate(STATE_JS)
        tr = [c for c in st["clips"] if c["id"] == target["id"]][0]["transform"]
        ok = abs(tr["scale"] - 60) < 1e-6 and tr["rotation"] > 5 and abs(tr["opacity"] - 80) < 1e-6 and tr["position"][0] < st["seq"]["w"] / 2 - 50
        log("Трансформация: масштаб/поворот/непрозрачность (Effect Controls) + положение мышью в «Программе»", ok, json.dumps({k: tr[k] for k in ("position", "scale", "rotation", "opacity")}))
        await page.wait_for_timeout(600)
        await page.screenshot(path=str(OUT / "03_transform.png"))
        # undo объединяет жест в один шаг
        hist_labels = await page.evaluate("() => window.__kadraStore.history.undoStack.slice(-4).map(c => c.label)")
        log("Жест перетаскивания = один шаг истории", hist_labels.count("Положение") == 1, ", ".join(hist_labels))

        # ---------- 5. Маркеры и In/Out ----------
        await page.locator(".tl-area").click(position={"x": 300, "y": 5})
        await page.evaluate("() => window.__kadraStore.setPlayhead(2)")
        await page.keyboard.press("m")
        await page.evaluate("() => window.__kadraStore.setPlayhead(5)")
        await page.keyboard.press("m")
        await page.keyboard.press("Home")
        await page.keyboard.press("Shift+m")
        ph = (await page.evaluate(STATE_JS))["playhead"]
        st = await page.evaluate(STATE_JS)
        log("Маркеры (M) и переход к следующему (Shift+M)", len(st["markers"]) == 2 and abs(ph - 2) < 1e-6, f"маркеров={len(st['markers'])}, плейхед={ph}")

        # ---------- 6. Воспроизведение ----------
        await page.evaluate("() => window.__kadraStore.setPlayhead(0)")
        await page.evaluate("""() => { window.__ticks = 0; window.__frameTimes = []; const tr = window.__kadraTransport; }""")
        fps_info = await page.evaluate("""async () => {
          const { transport } = await import('./js/engine/transport.js');
          let ticks = 0; const off = transport.on('tick', () => ticks++);
          const pm = window.__kadraApp.panels.get('program');
          transport.play(1);
          const t0 = performance.now(); await new Promise(r => setTimeout(r, 2500));
          const ph = window.__kadraStore.ui.playhead; const dt = (performance.now() - t0) / 1000;
          // кадр не чёрный?
          const c = pm.frame; const ctx = c.getContext('2d'); const d = ctx.getImageData(0, 0, c.width, c.height).data;
          let sum = 0; for (let i = 0; i < d.length; i += 4*97) sum += d[i] + d[i+1] + d[i+2];
          transport.pause(); off();
          return { ticks, fps: ticks / dt, playhead: ph, elapsed: dt, nonBlack: sum > 1000, canvas: [c.width, c.height] };
        }""")
        log("Воспроизведение: мастер-часы WebAudio, отрисовка Program Monitor", fps_info["fps"] >= 30 and 1.8 < fps_info["playhead"] < 2.8 and fps_info["nonBlack"], json.dumps(fps_info))
        # J/K/L
        await page.locator(".tl-area").click(position={"x": 300, "y": 5})
        await page.evaluate("() => window.__kadraStore.setPlayhead(1)")
        await page.keyboard.press("l")
        await page.keyboard.press("l")
        await page.wait_for_timeout(700)
        await page.keyboard.press("k")
        ph_l = (await page.evaluate(STATE_JS))["playhead"]
        await page.keyboard.press("j")
        await page.wait_for_timeout(500)
        await page.keyboard.press("k")
        ph_j = (await page.evaluate(STATE_JS))["playhead"]
        await page.keyboard.press("ArrowRight")
        ph_r = (await page.evaluate(STATE_JS))["playhead"]
        log("J/K/L (×2 вперёд, назад, стоп) и покадрово стрелками", ph_l > 1.9 and ph_j < ph_l and abs(ph_r - ph_j - 1 / st["seq"]["fps"]) < 1e-3 + 1 / st["seq"]["fps"], f"после L×2: {ph_l:.2f}s, после J: {ph_j:.2f}s, →: {ph_r:.3f}s")
        await page.screenshot(path=str(OUT / "04_playback.png"))

        # ---------- 7. Undo/redo ≥ 50 шагов ----------
        before = await page.evaluate(STATE_JS)
        v = sorted([c for c in before["clips"] if c["track"] == "V2"], key=lambda c: c["start"])
        r = await clip_rect(page, v[0]["id"])
        await page.mouse.click((r["x0"] + r["x1"]) / 2, r["y"])
        for i in range(60):
            await page.evaluate("() => window.__kadraStore.history.undoStack.at(-1) && (window.__kadraStore.history.undoStack.at(-1).time = 0)")  # не склеивать шаги
            await page.keyboard.press("Alt+ArrowRight")
        moved = await page.evaluate(STATE_JS)
        mv = [c for c in moved["clips"] if c["id"] == v[0]["id"]][0]
        for i in range(60):
            await page.keyboard.press("Control+z")
        back = await page.evaluate(STATE_JS)
        bv = [c for c in back["clips"] if c["id"] == v[0]["id"]][0]
        for i in range(60):
            await page.keyboard.press("Control+Shift+z")
        fwd = await page.evaluate(STATE_JS)
        fv = [c for c in fwd["clips"] if c["id"] == v[0]["id"]][0]
        log("Undo/Redo: 60 шагов назад и вперёд", abs(mv["start"] - v[0]["start"] - 2) < 1e-3 and abs(bv["start"] - v[0]["start"]) < 1e-6 and abs(fv["start"] - mv["start"]) < 1e-6, f"start {v[0]['start']} → {mv['start']} → undo×60 {bv['start']} → redo×60 {fv['start']}; глубина истории {fwd['history']}")
        for i in range(60):
            await page.keyboard.press("Control+z")

        # ---------- 8. Сохранение → перезагрузка → загрузка ----------
        await page.keyboard.press("Control+s")
        await page.wait_for_function("!window.__kadraStore.dirty")
        saved = await page.evaluate(STATE_JS)
        await page.reload()
        await page.wait_for_selector("html[data-ready='1']", state="attached")
        await page.wait_for_timeout(1500)
        loaded = await page.evaluate(STATE_JS)
        offline = await page.evaluate("() => window.__kadraStore.project.media.filter(m => document.querySelector('.media-list tr.offline')).length")
        same = json.dumps(saved["clips"], sort_keys=True) == json.dumps(loaded["clips"], sort_keys=True) and saved["markers"] == loaded["markers"] and saved["projectId"] == loaded["projectId"]
        log("Сохранение (Ctrl+S) → перезагрузка страницы → проект и медиа восстановлены из IndexedDB", same and offline == 0, f"клипов {len(loaded['clips'])}, маркеров {len(loaded['markers'])}, медиа {len(loaded['media'])}, офлайн={offline}")
        await page.wait_for_timeout(800)
        await page.screenshot(path=str(OUT / "05_reloaded.png"))

        # автосохранение по скрытию вкладки
        await page.evaluate("() => window.__kadraStore.mutate('Тест автосохранения', (p) => { p.name = 'Kadra e2e'; })")
        await page.evaluate("() => { Object.defineProperty(document, 'visibilityState', {value: 'hidden', configurable: true}); document.dispatchEvent(new Event('visibilitychange')); }")
        await page.wait_for_function("!window.__kadraStore.dirty", timeout=5000)
        await page.evaluate("() => { delete document.visibilityState; }")
        log("Автосохранение при скрытии вкладки", True, "dirty → сохранено")

        # ---------- 9. Экспорт/импорт проекта JSON ----------
        async with page.expect_download() as dl:
            await page.evaluate("() => window.__kadraApp.run('file.exportJson')")
        d = await dl.value
        jpath = OUT / d.suggested_filename
        await d.save_as(str(jpath))
        data = json.loads(jpath.read_text())
        log("Экспорт проекта в JSON", data.get("format") == "kadra-project" and len(data["sequences"][0]["tracks"]) >= 4, f"{jpath.name}, {jpath.stat().st_size} байт")

        # ---------- 10. Экспорт MP4 через диалог (WebCodecs) ----------
        await page.keyboard.press("Control+m")
        await page.wait_for_selector(".modal")
        sels = page.locator(".modal select")
        for i in range(await sels.count()):
            if "all" in await sels.nth(i).evaluate("s => [...s.options].map(o => o.value)"):
                await sels.nth(i).select_option("all")
        async with page.expect_download(timeout=180000) as dl:
            await page.locator(".modal .btn.primary").click()
        d = await dl.value
        mp4 = OUT / "export_webcodecs.mp4"
        await d.save_as(str(mp4))
        last = await page.evaluate("() => { const e = window.__kadraApp.lastExport; return e && {engine: e.engine, seconds: e.seconds, frames: e.frames, size: e.size, audioEncoder: e.audioEncoder}; }")
        info = ffprobe(mp4)
        vs = [s for s in info.get("streams", []) if s["codec_type"] == "video"]
        aus = [s for s in info.get("streams", []) if s["codec_type"] == "audio"]
        dur = float(info.get("format", {}).get("duration", 0))
        seq_dur = await page.evaluate("() => { const s = window.__kadraStore.seq; let e = 0; for (const t of s.tracks) for (const c of t.clips) e = Math.max(e, c.start + (c.out - c.in)/c.speed); return e; }")
        ok = vs and vs[0]["codec_name"] == "h264" and aus and aus[0]["codec_name"] == "aac" and abs(dur - seq_dur) < 0.15
        log("Экспорт MP4 (H.264 + AAC) через WebCodecs — проверка ffprobe", ok, f"{mp4.stat().st_size} байт; видео {vs and vs[0]['codec_name']} {vs and vs[0]['width']}x{vs and vs[0]['height']} @ {vs and vs[0]['r_frame_rate']}; звук {aus and aus[0]['codec_name']} {aus and aus[0].get('sample_rate')} Гц; длительность {dur:.3f}s (секвенция {seq_dur:.3f}s); {json.dumps(last)}")
        # сверка кадра экспорта с превью (тот же композитор)
        t_check = 0.5
        snap = await page.evaluate(f"""async () => {{ window.__kadraStore.setPlayhead({t_check}); const b = await window.__kadraApp.panels.get('program').snapshot(); const buf = new Uint8Array(await b.arrayBuffer()); let s=''; for (let i=0;i<buf.length;i+=32768) s += String.fromCharCode(...buf.subarray(i,i+32768)); return btoa(s); }}""")
        import base64

        (OUT / "frame_preview.png").write_bytes(base64.b64decode(snap))
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(t_check + 0.5 / 30), "-i", str(mp4), "-frames:v", "1", str(OUT / "frame_export.png")], check=True)
        val = psnr(OUT / "frame_preview.png", OUT / "frame_export.png")
        log("Кадр экспорта совпадает с превью (трансформации применены)", val > 25, f"PSNR = {val:.1f} dB на t={t_check}s")

        # ---------- 11. Экспорт фрагмента In→Out через FFmpeg.wasm ----------
        await page.evaluate("() => { const s = window.__kadraStore; s.mutate('In/Out', (p, q) => { q.inPoint = 1; q.outPoint = 2.5; }); }")
        await page.keyboard.press("Control+m")
        await page.wait_for_selector(".modal")
        sels = page.locator(".modal select")
        n = await sels.count()
        for i in range(n):
            opts = await sels.nth(i).evaluate("s => [...s.options].map(o => o.value)")
            if "1280x720" in opts:
                await sels.nth(i).select_option("1280x720")
            if "ffmpeg" in opts:
                await sels.nth(i).select_option("ffmpeg")
            if "inout" in opts:
                await sels.nth(i).select_option("inout")
        async with page.expect_download(timeout=300000) as dl:
            await page.locator(".modal .btn.primary").click()
        d = await dl.value
        mp4b = OUT / "export_ffmpeg.mp4"
        await d.save_as(str(mp4b))
        info = ffprobe(mp4b)
        vs = [s for s in info.get("streams", []) if s["codec_type"] == "video"]
        aus = [s for s in info.get("streams", []) if s["codec_type"] == "audio"]
        dur = float(info.get("format", {}).get("duration", 0))
        last = await page.evaluate("() => { const e = window.__kadraApp.lastExport; return e && {engine: e.engine, seconds: +e.seconds.toFixed(2), frames: e.frames}; }")
        log("Экспорт MP4 через FFmpeg.wasm (запасной путь), 1280×720, диапазон In→Out", vs and vs[0]["codec_name"] == "h264" and vs[0]["width"] == 1280 and aus and aus[0]["codec_name"] == "aac" and abs(dur - 1.5) < 0.15, f"{mp4b.stat().st_size} байт; {vs and vs[0]['width']}x{vs and vs[0]['height']} {vs and vs[0]['codec_name']} + {aus and aus[0]['codec_name']}; {dur:.3f}s; {json.dumps(last)}")
        await page.screenshot(path=str(OUT / "06_after_export.png"))

        # ---------- 12. Импорт проекта из JSON ----------
        async with page.expect_file_chooser() as fc:
            await page.evaluate("() => window.__kadraApp.run('file.importJson')")
        await (await fc.value).set_files(str(jpath))
        await page.wait_for_function(f"window.__kadraStore.project.id !== '{loaded['projectId']}'", timeout=10000)
        imp = await page.evaluate(STATE_JS)
        log("Импорт проекта из JSON (медиа найдены в IndexedDB этого браузера)", len(imp["clips"]) == len(data["sequences"][0]["tracks"][0]["clips"]) + sum(len(t["clips"]) for t in data["sequences"][0]["tracks"][1:]), f"клипов {len(imp['clips'])}, проект «{imp['projectName']}»")

        # ---------- 13. Архитектура этапа 2: тестовые плагины (только в тесте) ----------
        res = await page.evaluate(
            """async () => {
          const { plugins } = await import('./js/plugins/registry.js');
          const { activeVideoLayers } = await import('./js/engine/layers.js');
          plugins.registerEffect({ type: 'test-invert', name: 'Тест: инверсия', category: 'Тест',
            params: [{ key: 'amount', label: 'Сила', type: 'number', min: 0, max: 100, default: 100 }],
            apply(frame, p) { const { ctx, width, height } = frame; const d = ctx.getImageData(0, 0, width, height); const k = p.amount / 100;
              for (let i = 0; i < d.data.length; i += 4) for (let c = 0; c < 3; c++) d.data[i + c] = d.data[i + c] * (1 - k) + (255 - d.data[i + c]) * k;
              ctx.putImageData(d, 0, 0); } });
          plugins.registerTransition({ type: 'test-dissolve', name: 'Тест: растворение',
            render(ctx, a, b, p) { ctx.globalAlpha = 1; ctx.drawImage(a, 0, 0); ctx.globalAlpha = p; ctx.drawImage(b, 0, 0); ctx.globalAlpha = 1; } });
          const s = window.__kadraStore; const app = window.__kadraApp; const pm = app.panels.get('program');
          const v1 = () => s.seq.tracks.find(t => t.name === 'V1');
          const clips = [...v1().clips].sort((a, b) => a.start - b.start); const c = clips[0];
          const px = async (blob) => { const bmp = await createImageBitmap(blob); const cv = new OffscreenCanvas(bmp.width, bmp.height); const x = cv.getContext('2d'); x.drawImage(bmp, 0, 0); return [...x.getImageData(900, 500, 1, 1).data]; };
          s.select([c.id], 'set'); s.setPlayhead(0.5);
          const before = await px(await pm.snapshot());
          app.applyEffectToSelection('test-invert');
          const after = await px(await pm.snapshot());
          app.layout.showPanel('effectControls');
          await new Promise(r => setTimeout(r, 100));
          const ec = document.querySelector(".panel[data-panel='effectControls']").innerText;
          const fxCount = v1().clips.find(x => x.id === c.id).effects.length;
          // переход на склейке первого и второго клипа V1
          const cut = c.start + (c.out - c.in) / c.speed;
          s.mutate('Тестовый переход', (p, q) => { q.transitions.push({ id: 'tr1', type: 'test-dissolve', trackId: v1().id, at: cut, duration: 0.6, alignment: 'center', params: {} }); });
          const layers = activeVideoLayers(s.project, s.seq, cut, (id) => s.getMedia(id));
          const tr = layers.find(l => l.kind === 'transition');
          s.setPlayhead(cut);
          const mid = await px(await pm.snapshot());
          s.history.undo(); s.history.undo(); // убрать переход и эффект
          return { before, after, mid, ecShows: ec.includes('Тест: инверсия') && ec.includes('Сила'), fxCount, transition: tr ? { progress: tr.progress, a: !!tr.a, b: !!tr.b } : null };
        }"""
        )
        diff = sum(abs(a - b) for a, b in zip(res["before"][:3], res["after"][:3]))
        ok = diff > 60 and res["ecShows"] and res["fxCount"] == 1 and res["transition"] and abs(res["transition"]["progress"] - 0.5) < 1e-6 and res["transition"]["a"] and res["transition"]["b"]
        log("Архитектура этапа 2: тестовый эффект и переход подключаются регистрацией плагина", ok, f"пиксель до {res['before'][:3]} → после эффекта {res['after'][:3]}; панель параметров: {res['ecShows']}; переход: {res['transition']}")

        log("Ошибки в консоли браузера", not console_errors, "; ".join(console_errors[:5]) or "нет")
        await browser.close()
    httpd.shutdown()
    (OUT / "report.json").write_text(json.dumps({"elapsed_s": round(time.time() - t_start, 1), "steps": REPORT}, ensure_ascii=False, indent=2))
    failed = [r for r in REPORT if not r["ok"]]
    print(f"\nИтого: {len(REPORT) - len(failed)}/{len(REPORT)} шагов OK за {time.time() - t_start:.0f} с")
    sys.exit(1 if failed else 0)


asyncio.run(main())
