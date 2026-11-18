"""A/B metrics: ring vs source-size skeleton placeholder on the real fixture.
Usage: python tests/test_pending_ab.py <ring|skeleton>"""
import json
import os
import sys
import tempfile
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / ".output" / "chrome-mv3"
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
SHOTS = ROOT / "tests" / "screenshots"

MODE = sys.argv[1] if len(sys.argv) > 1 else "ring"

OBSERVERS = """
window.__cls = 0; window.__shifts = []; window.__lt = [];
new PerformanceObserver((l) => {
  for (const e of l.getEntries()) if (!e.hadRecentInput) { window.__cls += e.value; window.__shifts.push({t: Math.round(performance.now()), v: +e.value.toFixed(4)}); }
}).observe({type: 'layout-shift', buffered: true});
new PerformanceObserver((l) => {
  for (const e of l.getEntries()) window.__lt.push({t: Math.round(e.startTime), d: Math.round(e.duration)});
}).observe({type: 'longtask', buffered: true});
"""


def start_fixture_server():
    handler = partial(SimpleHTTPRequestHandler, directory=str(ROOT / "tests" / "fixtures"))
    handler.log_message = lambda *a: None
    srv = ThreadingHTTPServer(("127.0.0.1", 8765), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()


def main():
    start_fixture_server()
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=tempfile.mkdtemp(prefix=f"ilt-ab-{MODE}-"),
            executable_path=EDGE,
            headless=bool(os.environ.get("CI")),
            args=[
                f"--disable-extensions-except={EXT}",
                f"--load-extension={EXT}",
                "--no-first-run",
                "--no-default-browser-check",
            ],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.add_init_script(OBSERVERS)
        page.goto("http://127.0.0.1:8765/", wait_until="domcontentloaded")
        ext_id = ""
        deadline = time.time() + 15
        while time.time() < deadline and not ext_id:
            for sw in ctx.service_workers:
                if sw.url.startswith("chrome-extension://"):
                    ext_id = sw.url.split("/")[2]
            if not ext_id:
                time.sleep(0.3)
        pop = ctx.new_page()
        pop.goto(f"chrome-extension://{ext_id}/popup.html")
        pop.wait_for_selector("#lang")
        pop.select_option("#lang", "zh-CN")
        pop.select_option("#pending", MODE)
        pop.wait_for_function(
            "(m) => chrome.storage.local.get('settings').then(s => (s.settings || {}).pending === m && (s.settings || {}).targetLang === 'zh-CN')",
            arg=MODE,
        )
        pop.close()
        page.goto("http://127.0.0.1:8765/", wait_until="networkidle")
        page.wait_for_selector("[data-ilt-ui]", timeout=15000)
        # Read from mid-page so insertions land above AND below the viewport: drift then measures
        # what the reader's eye actually experiences (including the engine's scroll correction).
        page.evaluate("() => window.scrollTo(0, 1200)")
        time.sleep(0.4)

        base = page.evaluate(
            """() => {
                const hit = document.elementsFromPoint(innerWidth / 2, innerHeight / 2)
                    .find((e) => !e.closest('.ilt-t, .ilt-p, .ilt-p-sk, [data-ilt-ui]') && e !== document.body && e !== document.documentElement);
                window.__probe = hit;
                return {h: document.body.scrollHeight, top: hit.getBoundingClientRect().top, y: window.scrollY, id: hit.id || hit.tagName};
            }"""
        )
        t0 = time.time()
        page.locator("[data-ilt-ui] button.main").click()
        samples = []
        mid_shot = False
        last_w, since = -1, time.time()
        stable_at = None
        drift_events = 0
        corrections = 0
        prev_top, prev_y = base["top"], base["y"]
        while time.time() - t0 < 60:
            s = page.evaluate(
                """() => ({
                    h: document.body.scrollHeight,
                    top: window.__probe.getBoundingClientRect().top,
                    pend: document.querySelectorAll('.ilt-p, .ilt-p-sk').length,
                    wrap: document.querySelectorAll('.ilt-t').length,
                    y: window.scrollY,
                })"""
            )
            s["t"] = round(time.time() - t0, 2)
            samples.append(s)
            # visible reader-line jerks and scroll-anchor corrections between samples
            if abs(s["top"] - prev_top) > 2:
                drift_events += 1
            if abs(s["y"] - prev_y) > 1:
                corrections += 1
            prev_top, prev_y = s["top"], s["y"]
            if s["pend"] > 0 and not mid_shot:
                page.screenshot(path=str(SHOTS / f"ab_{MODE}_mid.png"))
                mid_shot = True
            if s["wrap"] != last_w:
                last_w, since = s["wrap"], time.time()
            elif s["wrap"] >= 16 and s["pend"] == 0 and time.time() - since >= 2:
                stable_at = s["t"]
                break
            time.sleep(0.08)
        page.screenshot(path=str(SHOTS / f"ab_{MODE}_final.png"))
        obs = page.evaluate("() => ({cls: window.__cls, shifts: window.__shifts, lt: window.__lt})")
        final_h = samples[-1]["h"]
        drift = max(abs(s["top"] - base["top"]) for s in samples)
        overshoot = max(s["h"] for s in samples) - final_h
        early_lt = [x for x in obs["lt"] if x["t"] < 3000]
        out = {
            "mode": MODE,
            "cls": round(obs["cls"], 4),
            "shift_events": len(obs["shifts"]),
            "max_reader_drift_px": round(drift, 1),
            "drift_events": drift_events,
            "scroll_corrections": corrections,
            "scroll_correction_px": round(max(abs(s["y"] - base["y"]) for s in samples), 1),
            "final_drift_px": round(samples[-1]["top"] - base["top"], 1),
            "height_overshoot_px": overshoot,
            "final_height_px": final_h,
            "base_height_px": base["h"],
            "time_to_stable_s": stable_at,
            "longtasks_first_3s": len(early_lt),
            "longtask_ms_first_3s": sum(x["d"] for x in early_lt),
            "samples": samples,
            "shifts": obs["shifts"],
        }
        (ROOT / "tests" / f"ab_{MODE}.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
        print(json.dumps({k: v for k, v in out.items() if k not in ("samples", "shifts")}, indent=1))
        ctx.close()


if __name__ == "__main__":
    main()