"""Быстрая проверка: страница загружается без ошибок в консоли."""
import asyncio
import sys

from playwright.async_api import async_playwright

from harness import chrome_path, route_cdn, start_static_server


async def main():
    httpd, base = start_static_server()
    errors = []
    async with async_playwright() as p:
        kw = {"executable_path": chrome_path()} if chrome_path() else {}
        browser = await p.chromium.launch(**kw)
        ctx = await browser.new_context(viewport={"width": 1600, "height": 900})
        await route_cdn(ctx)
        page = await ctx.new_page()
        page.on("console", lambda m: m.type in ("error", "warning") and errors.append(f"{m.type}: {m.text}"))
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        await page.goto(base + "/index.html")
        try:
            await page.wait_for_selector("html[data-ready='1']", state="attached", timeout=15000)
        except Exception as ex:
            errors.append(f"error: not ready {ex.__class__.__name__}")
        await page.wait_for_timeout(800)
        await page.screenshot(path=sys.argv[1] if len(sys.argv) > 1 else "smoke.png")
        await browser.close()
    httpd.shutdown()
    for e in errors:
        print(e)
    print("OK" if not [e for e in errors if e.startswith(("error", "pageerror"))] else "ERRORS")


asyncio.run(main())
