"""Popup checks: no 'free' wording in service options; OpenAI config only visible when selected."""
import os
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

# Windows consoles/CI default to cp1252; translation details contain CJK → force UTF-8 output
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / ".output" / "chrome-mv3"
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
SHOTS = ROOT / "tests" / "screenshots"

RESULTS = []


def check(name, cond, detail=""):
    RESULTS.append((name, bool(cond)))
    print(f"{'PASS' if cond else 'FAIL'}  {name}  {detail}", flush=True)


def main():
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=tempfile.mkdtemp(prefix="ilt-test-"),
            executable_path=EDGE,
            headless=bool(os.environ.get("CI")),
            args=[
                f"--disable-extensions-except={EXT}",
                f"--load-extension={EXT}",
                "--no-first-run",
                "--no-default-browser-check",
            ],
        )
        deadline = time.time() + 15
        ext_id = ""
        # MV3 service worker starts on page activity
        trigger = ctx.pages[0] if ctx.pages else ctx.new_page()
        trigger.goto("http://example.com", wait_until="domcontentloaded")
        while time.time() < deadline and not ext_id:
            for sw in ctx.service_workers:
                if sw.url.startswith("chrome-extension://"):
                    ext_id = sw.url.split("/")[2]
            if not ext_id:
                time.sleep(0.3)
        check("extension loaded", bool(ext_id), ext_id)
        if not ext_id:
            ctx.close()
            sys.exit(1)

        page = ctx.new_page()
        page.goto(f"chrome-extension://{ext_id}/popup.html")
        page.wait_for_selector("#service")

        opts = page.eval_on_selector_all("#service option", "els => els.map(e => e.textContent)")
        check("service options without free wording", opts == ["Google", "Edge", "OpenAI compatible"], str(opts))

        def panel_display():
            return page.eval_on_selector("#openai-panel", "el => getComputedStyle(el).display")

        check("API config hidden by default", panel_display() == "none", panel_display())
        page.screenshot(path=str(SHOTS / "popup-google.png"))

        page.select_option("#service", "openai")
        check("API config shown for OpenAI", panel_display() == "grid", panel_display())
        page.fill("#oa-base", "https://api.example.com/v1")
        page.fill("#oa-key", "sk-test-123")
        page.fill("#oa-model", "my-model")
        for sel in ["#oa-base", "#oa-key", "#oa-model"]:
            page.dispatch_event(sel, "change")
        time.sleep(0.5)
        page.screenshot(path=str(SHOTS / "popup-openai.png"))

        page.select_option("#service", "edge")
        check("API config hidden after switching to Edge", panel_display() == "none", panel_display())
        page.wait_for_function("() => chrome.storage.local.get('settings').then(s => (s.settings || {}).service === 'edge')")

        page.reload()
        page.wait_for_selector("#service")
        check("service choice persists across reload", page.eval_on_selector("#service", "el => el.value") == "edge")
        check("API config still hidden after reload", panel_display() == "none", panel_display())

        page.select_option("#service", "openai")
        vals = page.evaluate(
            "() => ['oa-base','oa-key','oa-model'].map(id => document.getElementById(id).value)"
        )
        check("OpenAI config persists", vals == ["https://api.example.com/v1", "sk-test-123", "my-model"], str(vals))

        # Floating toggle: pages read settings at load (in real use the popup is a separate window, settings-changed applies instantly)
        check("floating shown by default", trigger.locator("[data-ilt-ui]").count() == 1)
        page.bring_to_front()
        page.set_checked("#floating", False)
        time.sleep(0.4)
        trigger.reload(wait_until="load")
        time.sleep(1)
        check("no floating after disable", trigger.locator("[data-ilt-ui]").count() == 0)
        page.reload()
        page.wait_for_selector("#floating")
        check("floating switch persists", not page.eval_on_selector("#floating", "el => el.checked"))
        page.set_checked("#floating", True)
        time.sleep(0.4)
        trigger.reload(wait_until="load")
        time.sleep(1)
        check("floating restored after enable", trigger.locator("[data-ilt-ui]").count() == 1)

        ctx.close()

    failed = [n for n, ok in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} passed")
    if failed:
        print("FAILED:", failed)
        sys.exit(1)


if __name__ == "__main__":
    main()