# Verifies: dropdowns (level/sport), checkbox persistence, and survival across server restart.
import asyncio, subprocess, time, os
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = {**os.environ, "PORT": "3197"}

def start():
    p = subprocess.Popen(["node", "server.js"], cwd=ROOT, env=ENV,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    time.sleep(1.4)
    return p

async def main():
    server = start()
    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(args=["--no-sandbox"])
            page = await browser.new_page(viewport={"width": 1400, "height": 900})
            await page.goto("http://localhost:3197/settingstest")
            await page.wait_for_timeout(1200)

            # dropdown contents
            levels = await page.eval_on_selector_all("#level-select option", "els => els.map(e => e.textContent)")
            sports = await page.eval_on_selector_all("#sport-select option", "els => els.map(e => e.textContent)")
            print("level options:", levels)
            print("sport options:", sports[:6], "...")

            # change settings
            await page.select_option("#level-select", label="High School")
            await page.select_option("#sport-select", label="Football")
            await page.click("#opt-multibuzz")  # off
            await page.wait_for_timeout(400)
            print("before restart: multibuzz =", await page.is_checked("#opt-multibuzz"),
                  "| level =", await page.input_value("#level-select"),
                  "| sport =", await page.input_value("#sport-select"))

            # restart server (room state wiped)
            server.terminate(); server.wait()
            time.sleep(0.5)
            server = start()
            await page.wait_for_timeout(3500)  # reconnect + re-push

            print("after restart:  multibuzz =", await page.is_checked("#opt-multibuzz"),
                  "| level =", await page.input_value("#level-select"),
                  "| sport =", await page.input_value("#sport-select"))

            # question respects filters
            await page.click("#start-btn")
            await page.wait_for_timeout(1500)
            crumbs = await page.text_content("#cur-crumbs")
            print("crumbs:", crumbs.strip())
            await page.screenshot(path="/sessions/trusting-confident-shannon/mnt/outputs/shots/9-settings.png")
            await browser.close()
    finally:
        server.terminate()

asyncio.run(main())
print("done")
