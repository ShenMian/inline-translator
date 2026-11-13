"""Failure/retry E2E: a local mock OpenAI endpoint that fails then recovers, plus an always-failing one.

Verifies the engine's bounded auto-retry, the floating busy spinner, and the manual retry affordance.
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
    fail_first = 2
    fail_status = 500
    hits = 0

    def log_message(self, *a):
        pass

    def do_POST(self):
        MockOpenAI.hits += 1
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n))
        if MockOpenAI.hits <= MockOpenAI.fail_first:
            self.send_response(MockOpenAI.fail_status)
            self.end_headers()
            self.wfile.write(b'{"error":"mock failure"}')
            return
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


def floating_state(page):
    return page.eval_on_selector(
        "[data-ilt-ui]",
        """el => {
            const m = el.shadowRoot.querySelector('.main');
            const r = el.shadowRoot.querySelector('.retry');
            return { active: m.classList.contains('active'), busy: m.classList.contains('busy'),
                     error: m.classList.contains('error'),
                     retryShow: r.classList.contains('show'), count: r.querySelector('.count').textContent };
        }""",
    )


def toggle(page):
    page.wait_for_selector("[data-ilt-ui]", timeout=15000)
    page.locator("[data-ilt-ui] button.main").click()


def set_openai(pop, ext_id, port):
    pop.goto(f"chrome-extension://{ext_id}/popup.html")
    pop.wait_for_selector("#service")
    cfg = {
        "targetLang": "zh-CN", "service": "openai", "auto": False, "autoSites": {},
        "openai": {"baseUrl": f"http://127.0.0.1:{port}/v1", "apiKey": "test", "model": "mock"},
        "style": "default", "floating": True, "customRules": [],
    }
    pop.evaluate("(c) => chrome.storage.local.set({ settings: c })", cfg)
    pop.wait_for_function("() => chrome.storage.local.get('settings').then(s => (s.settings||{}).service === 'openai')")


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
            user_data_dir=tempfile.mkdtemp(prefix="ilt-retry-"),
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
        set_openai(pop, ext_id, 8766)

        # Scenario A: mock fails the first 2 requests then recovers → auto-retry must translate the page
        MockOpenAI.fail_first = 2
        MockOpenAI.hits = 0
        page.goto("http://127.0.0.1:8765/", wait_until="networkidle")
        toggle(page)
        time.sleep(0.4)
        st = floating_state(page)
        check("A: busy spinner while translating", st["active"] and st["busy"], str(st))
        n = wait_stable(page, timeout=30, stable=2)
        check("A: auto-retry recovered translations", n >= 16, f"count={n} hits={MockOpenAI.hits}")
        st = floating_state(page)
        check("A: no retry button after recovery", st["active"] and not st["retryShow"] and not st["busy"], str(st))
        check("A: mock was actually hit (failures occurred)", MockOpenAI.hits > 2, f"hits={MockOpenAI.hits}")
        toggle(page)  # restore

        # Scenario B: mock always fails → retry button appears; clicking it re-enqueues
        MockOpenAI.fail_first = 10**9
        MockOpenAI.hits = 0
        page.goto("http://127.0.0.1:8765/", wait_until="networkidle")
        toggle(page)
        # MAX_ATTEMPTS=3 with 1.2s + 2.4s backoff → failures settle after ~4s
        deadline = time.time() + 20
        st = {}
        while time.time() < deadline:
            st = floating_state(page)
            if st["retryShow"] and not st["busy"]:
                break
            time.sleep(0.4)
        check("B: retry button appears on failure", st.get("retryShow") and int(st.get("count", "0")) > 0, str(st))
        check("B: spinner stops after exhausting retries", not st.get("busy"), str(st))
        page.locator("[data-ilt-ui] button.retry").click()
        time.sleep(0.4)
        st2 = floating_state(page)
        check("B: manual retry re-enqueues (count cleared, busy again)", not st2["retryShow"] and st2["busy"], str(st2))
        toggle(page)

        # Scenario C: non-retryable 401 → no futile retry button; main button flags a config error
        MockOpenAI.fail_first = 10**9
        MockOpenAI.fail_status = 401
        MockOpenAI.hits = 0
        page.goto("http://127.0.0.1:8765/", wait_until="networkidle")
        toggle(page)
        deadline = time.time() + 15
        st = {}
        while time.time() < deadline:
            st = floating_state(page)
            if int(st.get("count", "0")) > 0 and not st["busy"]:
                break
            time.sleep(0.3)
        check("C: config error flagged on main button", st.get("error") and int(st.get("count", "0")) > 0, str(st))
        check("C: no futile retry button for 401", not st.get("retryShow"), str(st))
        check("C: non-retryable settles without backoff", not st.get("busy"), str(st))
        toggle(page)

        ctx.close()

    failed = [n for n, ok in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} passed")
    if failed:
        print("FAILED:", failed)
        sys.exit(1)


if __name__ == "__main__":
    main()