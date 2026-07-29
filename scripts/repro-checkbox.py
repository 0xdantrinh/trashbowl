import asyncio, subprocess, time, os
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

async def main():
    server = subprocess.Popen(["node", "server.js"], cwd=ROOT,
                              env={**os.environ, "PORT": "3198"},
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    time.sleep(1.5)
    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(args=["--no-sandbox"])
            page = await browser.new_page(viewport={"width": 1400, "height": 900})
            errors = []
            page.on("console", lambda m: m.type == "error" and errors.append(m.text))
            page.on("pageerror", lambda e: errors.append(str(e)))
            await page.goto("http://localhost:3198/checktest")
            await page.wait_for_timeout(1200)
            state0 = await page.is_checked("#opt-multibuzz")
            print("initial checked:", state0)
            await page.click("#opt-multibuzz")
            await page.wait_for_timeout(200)
            print("after click:", await page.is_checked("#opt-multibuzz"))
            await page.wait_for_timeout(1500)
            print("after 1.5s (post-sync):", await page.is_checked("#opt-multibuzz"))
            # click again (re-enable)
            await page.click("#opt-multibuzz")
            await page.wait_for_timeout(1500)
            print("re-enabled, post-sync:", await page.is_checked("#opt-multibuzz"))
            # also test with a question running (sync traffic)
            await page.click("#start-btn")
            await page.wait_for_timeout(800)
            await page.click("#opt-multibuzz")
            await page.wait_for_timeout(1500)
            print("toggled during reading, post-sync:", await page.is_checked("#opt-multibuzz"))
            print("js errors:", errors[:5])
            await browser.close()
    finally:
        server.terminate()

asyncio.run(main())
