"""Pending-indicator E2E: ring + source-size skeleton appear while translating, disappear on
success/failure/stop/retry; skeleton geometry matches source lines; live mode switch; popup preview."""
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
SHOTS.mkdir(exist_ok=True)

PEND = ".ilt-p, .ilt-p-sk"
RESULTS = []


def check(name, cond, detail=""):
    RESULTS.append((name, bool(cond)))
    print(f"{'PASS' if cond else 'FAIL'}  {name}  {detail}", flush=True)


def pending_count(page):
    return page.eval_on_selector_all(PEND, "els => els.length")


def count(page, sel):
    return page.eval_on_selector_all(sel, "els => els.length")


def wrapper_count(page):
    return count(page, ".ilt-t")


def wait_for(page, fn, want, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if fn(page) == want:
            return True
        time.sleep(0.1)
    return False


def wait_pending_seen(page, timeout=6):
    deadline = time.time() + timeout
    best = 0
    while time.time() < deadline:
        n = pending_count(page)
        best = max(best, n)
        if n > 0:
            return best
        time.sleep(0.05)
    return best


def wait_stable_wrappers(page, timeout=60, stable=2.0, min_count=1):
    deadline = time.time() + timeout
    last, since = -1, time.time()
    while time.time() < deadline:
        n = wrapper_count(page)
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


def start_fixture_server():
    handler = partial(SimpleHTTPRequestHandler, directory=str(ROOT / "tests" / "fixtures"))
    handler.log_message = lambda *a: None
    srv = ThreadingHTTPServer(("127.0.0.1", 8765), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()


def open_popup(ctx, ext_id):
    pop = ctx.new_page()
    pop.goto(f"chrome-extension://{ext_id}/popup.html")
    pop.wait_for_selector("#lang")
    return pop


def commit_settings(ctx, ext_id, mode):
    pop = open_popup(ctx, ext_id)
    pop.select_option("#lang", "zh-CN")
    pop.select_option("#pending", mode)
    pop.wait_for_function(
        "(m) => chrome.storage.local.get('settings').then(s => (s.settings || {}).targetLang === 'zh-CN' && (s.settings || {}).pending === m)",
        arg=mode,
    )
    pop.close()


def notify_fixture(pop):
    """A popup opened as a tab targets itself with settings-changed; relay to the fixture tab
    the way the real browser-action popup (whose active tab is the page) would."""
    pop.evaluate(
        """async () => {
            const [tab] = await chrome.tabs.query({url: 'http://127.0.0.1:8765/*'});
            if (tab?.id != null) await chrome.tabs.sendMessage(tab.id, {type: 'settings-changed'}).catch(() => {});
        }"""
    )


def set_pending(ctx, ext_id, mode):
    pop = open_popup(ctx, ext_id)
    pop.select_option("#pending", mode)
    pop.wait_for_function(
        "(m) => chrome.storage.local.get('settings').then(s => (s.settings || {}).pending === m)",
        arg=mode,
    )
    notify_fixture(pop)
    return pop


def get_ext_id(ctx, page):
    page.goto("http://127.0.0.1:8765/", wait_until="domcontentloaded")
    deadline = time.time() + 15
    while time.time() < deadline:
        for sw in ctx.service_workers:
            if sw.url.startswith("chrome-extension://"):
                return sw.url.split("/")[2]
        time.sleep(0.3)
    return ""


def skeleton_geometry(page):
    """Compare #p1's skeleton bars against the source's own visual line boxes."""
    return page.evaluate(
        """() => {
            const sk = document.querySelector('#p1 .ilt-p-sk');
            if (!sk) return null;
            const p = document.querySelector('#p1');
            const nodes = [...p.childNodes].filter(n => !(n.nodeType === 1 && n.matches('.ilt-t, .ilt-p, .ilt-p-sk')));
            const r = document.createRange();
            r.setStartBefore(nodes[0]); r.setEndAfter(nodes[nodes.length - 1]);
            const rects = [...r.getClientRects()].filter(x => x.width > 1 && x.height > 1);
            const lines = [];
            for (const x of rects) {
                const m = lines.find(l => Math.abs(l.top - x.top) < 2);
                if (m) { m.left = Math.min(m.left, x.left); m.right = Math.max(m.right, x.right); m.h = Math.max(m.h, x.height); }
                else lines.push({top: x.top, left: x.left, right: x.right, h: x.height});
            }
            const bars = [...sk.children];
            const srcH = lines.reduce((a, l) => a + l.h, 0);
            const skH = bars.reduce((a, b) => a + b.getBoundingClientRect().height + parseFloat(getComputedStyle(b).marginBottom), 0);
            return {
                lines: lines.length, bars: bars.length,
                widthsOk: bars.length === lines.length && bars.every((b, i) => Math.abs(b.getBoundingClientRect().width - (lines[i].right - lines[i].left)) <= 2),
                heightRatio: +(skH / srcH).toFixed(2),
                anim: getComputedStyle(bars[0]).animationName,
                text: sk.textContent, aria: sk.getAttribute('aria-hidden'),
            };
        }"""
    )


def run_blocked(ctx, page, ext_id):
    """Google endpoint resolves to a dead local port: requests fail fast, retries back off.
    Skeleton shows during attempts, live-switches to ring mid-flight, vanishes on final failure,
    returns on retry, and vanishes immediately when translation is toggled off mid-flight."""
    page.goto("http://127.0.0.1:8765/", wait_until="networkidle")
    toggle(page)
    n = wait_pending_seen(page, timeout=6)
    check("blocked: skeleton appears while translating", n > 0 and count(page, ".ilt-p-sk") > 0, f"max={n}")
    geo = skeleton_geometry(page)
    check(
        "blocked: skeleton bars match source line widths/heights",
        bool(geo) and geo["widthsOk"] and geo["bars"] == geo["lines"] and 0.75 <= geo["heightRatio"] <= 1.05
        and geo["anim"] == "ilt-shimmer" and geo["text"] == "" and geo["aria"] == "true",
        str(geo),
    )
    page.screenshot(path=str(SHOTS / "pending-skeleton.png"))
    # Live mode switch while retries are in flight: skeletons must become rings in place
    pop = set_pending(ctx, ext_id, "ring")
    pop.close()
    ok = wait_for(page, lambda pg: count(pg, ".ilt-p-sk"), 0, timeout=5)
    check("blocked: mid-flight switch replaces skeletons with rings", ok and count(page, ".ilt-p") > 0,
          f"sk={count(page, '.ilt-p-sk')} ring={count(page, '.ilt-p')}")
    ok = wait_for(page, pending_count, 0, timeout=30)
    check("blocked: indicators removed after final failure", ok, f"left={pending_count(page)}")
    check("blocked: no wrappers on failure", wrapper_count(page) == 0)
    retry = page.locator("[data-ilt-ui] button.retry.show")
    check("blocked: retry affordance shown", retry.count() == 1)
    if retry.count() == 1:
        retry.click()
        n = wait_pending_seen(page, timeout=6)
        check("blocked: retry re-shows indicators", n > 0, f"max={n}")
        toggle(page)
        time.sleep(0.3)
        check("blocked: stop mid-flight clears indicators", pending_count(page) == 0 and wrapper_count(page) == 0)


def run_success(ctx, page, ext_id):
    page.goto("http://127.0.0.1:8765/", wait_until="networkidle")
    toggle(page)
    n = wait_pending_seen(page, timeout=8)
    check("success: skeleton appears while translating", n > 0, f"max={n}")
    geo = None
    deadline = time.time() + 4
    while time.time() < deadline and not geo:
        geo = skeleton_geometry(page)
        if not geo:
            time.sleep(0.05)
    check(
        "success: skeleton geometry tracks source lines",
        bool(geo) and geo["widthsOk"] and geo["bars"] == geo["lines"] and 0.75 <= geo["heightRatio"] <= 1.05,
        str(geo),
    )
    page.screenshot(path=str(SHOTS / "pending-skeleton-success.png"))
    w = wait_stable_wrappers(page, timeout=60, stable=2.5, min_count=16)
    check("success: translations rendered", w >= 16, f"count={w}")
    check("success: no indicator left after completion", pending_count(page) == 0, f"left={pending_count(page)}")
    toggle(page)
    time.sleep(0.3)
    check("success: toggle off clears DOM", pending_count(page) == 0 and wrapper_count(page) == 0)
    # Popup preview follows the selected mode; drop the cache so the spot translation hits network
    pop = open_popup(ctx, ext_id)
    check("popup: skeleton preview renders bars", pop.eval_on_selector_all("#pending-preview .ilt-p-sk .ilt-p-l", "e => e.length") >= 1)
    pop.select_option("#pending", "ring")
    pop.wait_for_function("() => chrome.storage.local.get('settings').then(s => (s.settings || {}).pending === 'ring')")
    check("popup: ring preview renders ring", pop.eval_on_selector_all("#pending-preview .ilt-p", "e => e.length") == 1)
    notify_fixture(pop)
    pop.evaluate("() => chrome.storage.local.remove('cache')")
    pop.close()
    time.sleep(0.5)
    box = page.locator("#p1").bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.keyboard.press("Alt")
    n = wait_pending_seen(page, timeout=6)
    check("hover: ring appears during spot translation", n > 0 and count(page, ".ilt-p") > 0, f"max={n}")
    ok = wait_for(page, lambda pg: pg.eval_on_selector_all("#p1 .ilt-t", "els => els.length"), 1, timeout=30)
    check("hover: spot translation rendered", ok)
    check("hover: no indicator left", pending_count(page) == 0, f"left={pending_count(page)}")


def main():
    start_fixture_server()
    with sync_playwright() as p:
        # Pass 1: deterministic failure path (google endpoint mapped to a dead port), skeleton mode
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=tempfile.mkdtemp(prefix="ilt-pending-"),
            executable_path=EDGE,
            headless=bool(os.environ.get("CI")),
            args=[
                f"--disable-extensions-except={EXT}",
                f"--load-extension={EXT}",
                "--no-first-run",
                "--no-default-browser-check",
                "--host-resolver-rules=MAP translate.googleapis.com 127.0.0.1, MAP translate.google.com 127.0.0.1",
            ],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        errors = []
        page.on("console", lambda m: errors.append(m.text) if "[ilt]" in m.text and "failed" not in m.text and "dbg" not in m.text else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        ext_id = get_ext_id(ctx, page)
        commit_settings(ctx, ext_id, "skeleton")
        page.goto("about:blank", wait_until="domcontentloaded")
        run_blocked(ctx, page, ext_id)
        check("blocked: no unexpected [ilt] errors", not errors, "; ".join(errors[:3])[:200])
        ctx.close()

        # Pass 2: real network success in skeleton mode, then ring hover
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=tempfile.mkdtemp(prefix="ilt-pending-ok-"),
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
        errors = []
        page.on("console", lambda m: errors.append(m.text) if "[ilt]" in m.text and "failed" not in m.text and "dbg" not in m.text else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        ext_id = get_ext_id(ctx, page)
        commit_settings(ctx, ext_id, "skeleton")
        page.goto("about:blank", wait_until="domcontentloaded")
        run_success(ctx, page, ext_id)
        check("success: no unexpected [ilt] errors", not errors, "; ".join(errors[:3])[:200])
        ctx.close()

    failed = [n for n, ok in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} passed")
    if failed:
        print("FAILED:", failed)
        sys.exit(1)


if __name__ == "__main__":
    main()