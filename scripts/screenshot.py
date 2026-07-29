# Takes UI screenshots of TrashBowl states for visual verification.
import asyncio, subprocess, time, sys, os
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/shots"
os.makedirs(OUT, exist_ok=True)

async def main():
    server = subprocess.Popen(["node", "server.js"], cwd=ROOT,
                              env={**os.environ, "PORT": "3199"},
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    time.sleep(1.5)
    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(args=["--no-sandbox"])
            page = await browser.new_page(viewport={"width": 1400, "height": 900})
            await page.goto("http://localhost:3199/swag")
            await page.wait_for_timeout(1200)
            await page.screenshot(path=f"{OUT}/1-idle.png")

            # start a question
            await page.click("#start-btn")
            await page.wait_for_timeout(2500)
            await page.screenshot(path=f"{OUT}/2-reading.png")

            # pause
            await page.keyboard.press("p")
            await page.wait_for_timeout(400)
            await page.screenshot(path=f"{OUT}/3-paused.png")
            await page.keyboard.press("p")
            await page.wait_for_timeout(300)

            # buzz
            await page.keyboard.press("Space")
            await page.wait_for_timeout(400)
            await page.type("#guess-input", "some guess")
            await page.wait_for_timeout(300)
            await page.screenshot(path=f"{OUT}/4-buzzed.png")

            # answer wrong -> neg, resume
            await page.keyboard.press("Enter")
            await page.wait_for_timeout(600)
            await page.screenshot(path=f"{OUT}/5-after-wrong.png")

            # skip to end
            await page.keyboard.press("s")
            await page.wait_for_timeout(600)
            await page.screenshot(path=f"{OUT}/6-done.png")

            # next question then chat
            await page.keyboard.press("j")
            await page.wait_for_timeout(1000)
            await page.keyboard.press("/")
            await page.type("#guess-input", "hello world")
            await page.keyboard.press("Enter")
            await page.wait_for_timeout(400)
            await page.keyboard.press("s")
            await page.wait_for_timeout(500)
            await page.screenshot(path=f"{OUT}/7-feed.png")

            # search
            await page.fill("#search", "brady")
            await page.wait_for_timeout(800)
            await page.screenshot(path=f"{OUT}/8-search.png")

            await browser.close()
    finally:
        server.terminate()

asyncio.run(main())
print("done")
