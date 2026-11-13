"""Persistent-cache E2E: translations survive a reload via chrome.storage.local.

Verifies that a re-translated page is served from the persisted cache (no new API hits),
that the cache key isolates target languages, and that clearing the cache forces a re-fetch.
"""
import json
import os
import sys
import tempfile
import threading
import time
from functools import partial
from http.server import BaseHTTPRequestHandler, SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / ".output" / "chrome-mv3"
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
RESULTS = []


def check(name, cond, detail=""):
    RESULTS.append((name, bool(cond)))
    print(f"{'PASS' if cond else 'FAIL'}  {name}  {detail}", flush=True)


class MockOpenAI(BaseHTTPRequestHandler):
    hits = 0

    def log_message(self, *a):
        pass

    def do_POST(self):
        MockOpenAI.hits += 1
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n))
        try:
            texts = json.loads(body["messages"][1]["content"])
            out = ["译文 " + t for t in texts]
            data = json.dumps(
                {"choices": [{"message": {"content": json.dumps(out, ensure_ascii=False)}}]},
                ensure_ascii=False,
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass


def count_wrappers(page):
    return page.eval_on_selector_all(".ilt-t", "els => els.length")


def wait_stable(page, timeout=30, stable=1.5, min_count=1):
    deadline = time.time() + timeout
    last, since = -1, time.time()
    while time.time() < deadline:
        n = count_wrappers(page)
        now = time.time()
        if n != last:
            last, since = n, now
        elif n >= min_count and now - since >= stable:
            return n
        time.sleep(0.3)
    return last


def toggle(page):
    page.wait_for_selector("[data-ilt-ui]", timeout=15000)
    page.locator("[data-ilt-ui] button.main").click()


def write_settings(pop, **patch):
    cfg = {
        "targetLang": "zh-CN", "service": "openai", "auto": False, "autoSites": {},
        "openai": {"baseUrl": "http://127.0.0.1:8766/v1", "apiKey": "test", "model": "mock"},
        "style": "default", "floating": True, "customRules": [],
    }
    cfg.update(patch)
    pop.evaluate("(c) => chrome.storage.local.set({ settings: c })", cfg)
    pop.wait_for_function(
        "(t) => chrome.storage.local.get('settings').then(s => (s.settings||{}).targetLang === t)",
        arg=cfg["targetLang"],
    )


def cache_size(pop):
    return pop.evaluate("() => chrome.storage.local.get('cache').then(s => Object.keys(s.cache || {}).length)")


def main():
    mock = ThreadingHTTPServer(("127.0.0.1", 8766), MockOpenAI)
    threading.Thread(target=mock.serve_forever, daemon=True).start()

    class Quiet(SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass

    fixture = ThreadingHTTPServer(("127.0.0.1", 8765), partial(Quiet, directory=str(ROOT / "tests" / "fixtures")))
    threading.Thread(target=fixture.serve_forever, daemon=True).start()

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=tempfile.mkdtemp(prefix="ilt-cache-"),
            executable_path=EDGE,
            headless=bool(os.environ.get("CI")),
            args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}",
                  "--no-first-run", "--no-default-browser-check"],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
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
        pop.wait_for_selector("#service")
        write_settings(pop)

        # Scenario A: translate, reload, re-translate → served from persisted cache, no new API hits
        MockOpenAI.hits = 0
        page.goto("http://127.0.0.1:8765/", wait_until="networkidle")
        toggle(page)
        n1 = wait_stable(page, timeout=30, stable=2)
        hits_a = MockOpenAI.hits
        check("A: first pass translated the page", n1 >= 16, f"count={n1} hits={hits_a}")
        check("A: mock was hit on first pass", hits_a > 0, f"hits={hits_a}")
        # persist debounce is 800ms; wait_stable already waited ≥2s, but give storage a moment
        time.sleep(0.5)
        sz = cache_size(pop)
        check("A: cache persisted to storage.local", sz > 0, f"entries={sz}")

        page.reload(wait_until="networkidle")
        toggle(page)
        n2 = wait_stable(page, timeout=30, stable=2)
        hits_b = MockOpenAI.hits
        check("A: reload restored translations from cache", n2 >= 16 and n2 == n1, f"count={n2} (was {n1})")
        check("A: no new API hits after reload (cache served)", hits_b == hits_a, f"hits={hits_b} (was {hits_a})")
        toggle(page)  # restore

        # Scenario B: a different target language is a different cache key → must re-fetch
        write_settings(pop, targetLang="ja")
        page.reload(wait_until="networkidle")
        toggle(page)
        n3 = wait_stable(page, timeout=30, stable=2)
        hits_c = MockOpenAI.hits
        check("B: new target language re-translated", n3 >= 16, f"count={n3}")
        check("B: language change bypasses cache (new hits)", hits_c > hits_b, f"hits={hits_c} (was {hits_b})")
        toggle(page)

        # Scenario C: clearing the persisted cache forces a re-fetch even for the same language.
        # Use a fresh tab: reloading the current page would fire its pagehide flush, which writes
        # the old in-memory snapshot back to disk and resurrects the cache we just cleared.
        write_settings(pop, targetLang="zh-CN")
        pop.evaluate("() => chrome.storage.local.remove('cache')")
        pop.wait_for_function("() => chrome.storage.local.get('cache').then(s => !s.cache)")
        page2 = ctx.new_page()
        page2.goto("http://127.0.0.1:8765/", wait_until="networkidle")
        cold = cache_size(pop)
        check("C: cache is cold before re-translating", cold == 0, f"entries={cold}")
        toggle(page2)
        n4 = wait_stable(page2, timeout=30, stable=2)
        hits_d = MockOpenAI.hits
        check("C: page re-translated after cache clear", n4 >= 16, f"count={n4}")
        check("C: cache clear forces new API hits", hits_d > hits_c, f"hits={hits_d} (was {hits_c})")
        toggle(page2)

        ctx.close()

    failed = [n for n, ok in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} passed")
    if failed:
        print("FAILED:", failed)
        sys.exit(1)


if __name__ == "__main__":
    main()