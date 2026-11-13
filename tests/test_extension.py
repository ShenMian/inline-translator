"""Inline Translator E2E: local fixtures + real sites, driven through system Edge."""
import os
import sys
import tempfile
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

# Windows consoles/CI default to cp1252; translation details contain CJK → force UTF-8 output
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / ".output" / "chrome-mv3"
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
SHOTS = ROOT / "tests" / "screenshots"
SHOTS.mkdir(exist_ok=True)

RESULTS = []


def check(name, cond, detail=""):
    RESULTS.append((name, bool(cond)))
    print(f"{'PASS' if cond else 'FAIL'}  {name}  {detail}", flush=True)


def count_wrappers(page):
    return page.eval_on_selector_all(".ilt-t", "els => els.length")


def wait_stable(page, timeout=40, stable=1.5, min_count=1):
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


def no_wrapper_after(page, sel):
    return page.eval_on_selector(
        sel,
        "el => !(el.nextElementSibling && el.nextElementSibling.classList.contains('ilt-t')) && !el.querySelector('.ilt-t')",
    )


def run_fixture(page):
    page.goto("http://127.0.0.1:8765/", wait_until="networkidle")
    toggle(page)
    n = wait_stable(page, timeout=60, stable=3)
    check("fixture: translation count", n >= 16, f"count={n}")

    check("fixture: pre kept verbatim", page.eval_on_selector("#pre1", "el => !el.querySelector('.ilt-t') && el.textContent.includes('const x = 42')"))
    check("fixture: contenteditable skipped", no_wrapper_after(page, "#editable"))
    check("fixture: hidden paragraph skipped", no_wrapper_after(page, "#hiddenp"))
    check("fixture: translate=no skipped", no_wrapper_after(page, "#notrans"))
    check("fixture: notranslate skipped", no_wrapper_after(page, "#notrans2"))
    check("fixture: digits-only skipped", no_wrapper_after(page, "#numbers"))
    check("fixture: URL skipped", no_wrapper_after(page, "#url"))
    check("fixture: page-shell stray run skipped", no_wrapper_after(page, "#stray"))
    check("fixture: nested in shell translated", page.eval_on_selector("#shell-p", "el => !!el.querySelector('.ilt-t')"))
    check("fixture: same-language skipped", no_wrapper_after(page, "#samelang"))

    rich = page.evaluate(
        """() => {
            const w = document.querySelector('#p1 .ilt-t');
            if (!w) return { ok: false };
            return {
                ok: true,
                link: !!w.querySelector('a[href="https://example.com"]'),
                code: !!w.querySelector('code'),
                bold: !!w.querySelector('b'),
                text: w.textContent.slice(0, 60),
            };
        }"""
    )
    check("fixture: rich-text link preserved", rich.get("link"), str(rich))
    ls = page.evaluate(
        """() => {
            const w = document.querySelector('#p-link .ilt-t');
            if (!w) return null;
            const d = w.querySelector('a[href="https://example.com/dark"]');
            const b = w.querySelector('a[href="https://example.com/blue"]');
            return {
                dark: d && getComputedStyle(d).color, origDark: getComputedStyle(document.querySelector('#link-dark')).color,
                darkDec: d && getComputedStyle(d).textDecorationLine, origDarkDec: getComputedStyle(document.querySelector('#link-dark')).textDecorationLine,
                blue: b && getComputedStyle(b).color, origBlue: getComputedStyle(document.querySelector('#link-blue')).color,
            };
        }"""
    )
    check(
        "fixture: link color matches original",
        ls and ls["dark"] == ls["origDark"] and ls["blue"] == ls["origBlue"] and ls["darkDec"] == ls["origDarkDec"],
        str(ls),
    )
    check("fixture: atomic code preserved", rich.get("code"))
    check("fixture: bold shell preserved", rich.get("bold"))

    # Translation typography matches the original
    def wrapper_style(sel):
        return page.eval_on_selector(
            sel,
            """el => {
                const w = el.querySelector('.ilt-t');
                if (!w) return null;
                const cs = getComputedStyle(w);
                return { fontSize: cs.fontSize, fontWeight: cs.fontWeight, color: cs.color,
                         letterSpacing: cs.letterSpacing, textTransform: cs.textTransform,
                         fontFamily: cs.fontFamily, lineHeight: cs.lineHeight, opacity: cs.opacity };
            }""",
        )

    st = wrapper_style("#p-styled")
    check(
        "fixture: translation inherits paragraph style",
        st and st["fontSize"] == "22px" and st["fontWeight"] == "700"
        and st["color"] == "rgb(180, 40, 40)" and st["letterSpacing"] == "1px"
        and st["textTransform"] == "uppercase" and "Georgia" in st["fontFamily"]
        and st["lineHeight"] == "41.8px" and st["opacity"] == "1",
        str(st),
    )
    sf = wrapper_style("#p-fancy")
    check(
        "fixture: single-element style match",
        sf and sf["fontSize"] == "19px" and sf["fontWeight"] == "600" and sf["color"] == "rgb(30, 110, 200)",
        str(sf),
    )
    sh = wrapper_style("#title")
    check("fixture: heading keeps bold size", sh and sh["fontWeight"] == "700" and sh["fontSize"] == "32px", str(sh))

    check("fixture: display:contents paragraph", page.eval_on_selector("#p3", "el => !!el.querySelector('.ilt-t') || (el.nextElementSibling && el.nextElementSibling.classList.contains('ilt-t'))"))
    check("fixture: flex item translated", page.eval_on_selector("#flex1", "el => !!el.querySelector('.ilt-t')"))
    check(
        "fixture: flex direct text inline",
        page.eval_on_selector("#flexdirect", "el => { const w = el.querySelector('.ilt-t'); if (!w) return false; const a = el.getBoundingClientRect(), b = w.getBoundingClientRect(); return b.top < a.top + 10 && b.left > a.left; }"),
    )
    check(
        "fixture: heading translation inline right",
        page.eval_on_selector("#title", "el => { const w = el.querySelector('.ilt-t'); if (!w) return false; const a = el.getBoundingClientRect(), b = w.getBoundingClientRect(); return getComputedStyle(w).display === 'inline' && b.top < a.top + 10 && b.left > a.left; }"),
    )
    check("fixture: table cell translated", page.eval_on_selector("#td1", "el => !!el.querySelector('.ilt-t')"))
    check("fixture: block inside anchor", page.eval_on_selector("#badnest", "el => !!el.querySelector('.ilt-t')"))
    check("fixture: long paragraph translated", page.eval_on_selector("#long", "el => { const w = el.querySelector('.ilt-t'); return !!w && w.textContent.length > 500; }"))

    shadow_n = page.eval_on_selector("#shadow-host", "el => el.shadowRoot.querySelectorAll('.ilt-t').length")
    check("fixture: Shadow DOM pierced", shadow_n >= 1, f"count={shadow_n}")

    check(
        "fixture: slot-less shadow fallback untranslated",
        page.eval_on_selector("#fallback-host", "el => !el.querySelector('.ilt-t') && !!el.shadowRoot.querySelector('.ilt-t')"),
    )

    frame_n = 0
    deadline = time.time() + 15
    while time.time() < deadline:
        frame_n = page.frame_locator("#frame1").locator(".ilt-t").count()
        if frame_n >= 1:
            break
        time.sleep(0.5)
    check("fixture: same-origin iframe translated", frame_n >= 1, f"count={frame_n}")

    # Dynamic insertion
    page.click("#add-btn")
    page.wait_for_selector("#added .ilt-t", timeout=15000)
    check("fixture: dynamically added paragraph", True)

    # Text change → retranslation (old wrapper removed, new one inserted async; tolerate a brief gap)
    before = page.eval_on_selector("#p1 .ilt-t", "el => el.textContent")
    page.click("#mutate-btn")
    page.eval_on_selector("#p1", "el => el.scrollIntoView()")
    deadline = time.time() + 20
    changed = False
    after = ""
    while time.time() < deadline:
        el = page.query_selector("#p1 .ilt-t")
        after = el.text_content() if el else ""
        if after and after != before:
            changed = True
            break
        time.sleep(0.4)
    check("fixture: text change triggers retranslation", changed, f"{before[:20]} -> {after[:20]}")

    # Restore
    toggle(page)
    time.sleep(0.5)
    check("fixture: no residue after restore", count_wrappers(page) == 0, f"count={count_wrappers(page)}")

    page.screenshot(path=str(SHOTS / "fixture.png"), full_page=True)


def run_site(page, name, url, min_count=5, extra=None):
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=45000)
        page.wait_for_load_state("networkidle", timeout=30000)
    except Exception as e:
        check(f"{name}: load", False, str(e)[:120])
        return
    try:
        toggle(page)
    except Exception as e:
        check(f"{name}: floating/toggle", False, str(e)[:120])
        return
    n = wait_stable(page, timeout=60, stable=3)
    check(f"{name}: translation count", n >= min_count, f"count={n}")
    if extra:
        extra(page, name)
    page.screenshot(path=str(SHOTS / f"{name}.png"))
    # Restore so the next site starts clean
    try:
        toggle(page)
    except Exception:
        pass
    # Cool down to stay under the free endpoint's rate limit across sites
    time.sleep(12)


def github_extra(page, name):
    ok = page.evaluate("() => !document.querySelector('pre .ilt-t') && !document.querySelector('.highlight .ilt-t')")
    check(f"{name}: code regions untranslated", ok)
    dates = page.evaluate(
        "() => [...document.querySelectorAll('relative-time')].every(rt => !rt.querySelector(':scope > .ilt-t') && (!rt.shadowRoot || rt.shadowRoot.querySelectorAll('.ilt-t').length <= 1))"
    )
    check(f"{name}: relative-time translated once", dates)


def mdn_extra(page, name):
    ok = page.evaluate(
        """() => {
            if (!document.querySelector('nav .ilt-t, aside .ilt-t')) return false;
            const bar = document.querySelector('.breadcrumbs-bar') || document.querySelector('.breadcrumbs');
            if (bar && bar.getBoundingClientRect().height > 60) return false;
            const h = document.querySelector('h1');
            const w = h && h.querySelector('.ilt-t');
            return !!w && getComputedStyle(w).display === 'inline' && w.getBoundingClientRect().top < h.getBoundingClientRect().top + 10;
        }"""
    )
    check(f"{name}: chrome and headings inline", ok)
    shadow_ok = page.evaluate(
        """() => {
            const chrome = 'header, nav, aside, footer';
            const scan = (root, inChrome) => {
                for (const w of root.querySelectorAll('.ilt-t')) {
                    if (inChrome && getComputedStyle(w).display !== 'inline') return false;
                }
                for (const el of root.querySelectorAll('*')) {
                    if (el.shadowRoot && !scan(el.shadowRoot, inChrome || !!el.closest(chrome))) return false;
                }
                return true;
            };
            return scan(document, false);
        }"""
    )
    check(f"{name}: shadow chrome inline, no stacking", shadow_ok)


def hn_extra(page, name):
    check(
        f"{name}: top bar translated",
        page.evaluate("() => { const t = document.querySelector('.pagetop'); return !!t && !!t.closest('tr').querySelector('.ilt-t'); }"),
    )


def wiki_extra(page, name):
    check(
        f"{name}: sidebar and heading translated",
        page.evaluate("() => !!document.querySelector('nav .ilt-t') && !!document.querySelector('h1 .ilt-t')"),
    )


def start_fixture_server():
    class Quiet(SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    handler = partial(Quiet, directory=str(ROOT / "tests" / "fixtures"))
    srv = ThreadingHTTPServer(("127.0.0.1", 8765), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def main():
    start_fixture_server()
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
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        ilt_errors = []
        page.on("console", lambda m: ilt_errors.append(m.text) if "[ilt]" in m.text else None)
        page.on("pageerror", lambda e: ilt_errors.append(str(e)))

        # Wake the background service worker so the extension id can be read from it.
        page.goto("http://127.0.0.1:8765/", wait_until="domcontentloaded")
        ext_id = ""
        deadline = time.time() + 15
        while time.time() < deadline and not ext_id:
            for sw in ctx.service_workers:
                if sw.url.startswith("chrome-extension://"):
                    ext_id = sw.url.split("/")[2]
            if not ext_id:
                time.sleep(0.3)

        # The same-language fixture is Japanese. Commit the target language, then reset the page
        # before the fixture run: reloading straight after the popup write races chrome.storage's
        # cross-process propagation, so the content script occasionally read the stale default
        # (zh-CN) and translated the Japanese #samelang paragraph instead of skipping it.
        pop = ctx.new_page()
        pop.goto(f"chrome-extension://{ext_id}/popup.html")
        pop.wait_for_selector("#lang")
        pop.select_option("#lang", "ja")
        pop.wait_for_function("() => chrome.storage.local.get('settings').then(s => (s.settings || {}).targetLang === 'ja')")
        pop.close()
        page.goto("about:blank", wait_until="domcontentloaded")

        run_fixture(page)
        if "--fixtures-only" not in sys.argv:
            run_site(page, "wikipedia", "https://en.wikipedia.org/wiki/Machine_translation", 20, wiki_extra)
            run_site(page, "hackernews", "https://news.ycombinator.com/", 15, hn_extra)
            run_site(page, "github", "https://github.com/ShenMian/tracker", 10, github_extra)
            run_site(page, "mdn", "https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver", 10, mdn_extra)

        check("no [ilt] runtime errors", not ilt_errors, "; ".join(ilt_errors[:3])[:200])
        ctx.close()

    failed = [n for n, ok in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} passed")
    if failed:
        print("FAILED:", failed)
        sys.exit(1)


if __name__ == "__main__":
    main()