"""Translation style E2E: the 17 themes against a local mock service.

Verifies the computed wrapper/inner styles per theme, hover reveal for blur/transparency,
inline (heading) variants, and the popup's option list + live preview.
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
SHOTS = ROOT / "tests" / "screenshots"
SHOTS.mkdir(exist_ok=True)
RESULTS = []

STYLE_IDS = [
    "none", "underline", "dashed", "dotted", "wavy",
    "highlight", "blockquote", "solidBorder", "paper", "background",
    "dividingLine", "weakening", "grey", "italic", "bold", "mask", "opacity",
]

CYAN = "rgb(114, 236, 233)"     # #72ece9
SLATE = "rgb(148, 163, 184)"    # #94a3b8
CRIMSON = "rgb(204, 51, 85)"    # #cc3355
YELLOW = "rgb(255, 255, 0)"     # #ffff00

# Expected computed values on the block wrapper (w), its inline inner (i) and wrapper ::before.
EXPECTED = {
    "none": {"wDisplay": "block", "wOpacity": "1", "iDecLine": "none", "iBgImage": "none", "iFilter": "none"},
    "underline": {"iBorderBottomStyle": "solid", "iBorderBottomColor": CYAN, "iBorderBottomWidth": "1px"},
    "dashed": {"iBgImage": "linear-gradient", "iBgSize": "8px 2px"},
    "dotted": {"iBgImage": "linear-gradient", "iBgSize": "5px 1px"},
    "wavy": {"iDecLine": "underline", "iDecStyle": "wavy", "iDecColor": CYAN},
    "highlight": {"iBg": YELLOW},
    "blockquote": {"wDisplay": "inline-block", "wBorderLeftStyle": "solid", "wBorderLeftWidth": "4px", "wBorderLeftColor": CRIMSON, "wPaddingLeft": "12px"},
    "solidBorder": {"wDisplay": "inline-block", "wBorderTopStyle": "solid", "wBorderTopColor": SLATE, "wPaddingTop": "6px"},
    "paper": {"wDisplay": "inline-block", "wPaddingTop": "16px", "wPaddingLeft": "32px", "wShadow": "rgba(0, 0, 0, 0.24)"},
    "background": {"wDisplay": "inline-block", "wBg": "rgba(219, 175, 175, 0.12)", "wRadius": "4px", "wPaddingTop": "12px"},
    "dividingLine": {"beforeContent": '""', "beforeBorderTopStyle": "dashed", "beforeBorderTopColor": SLATE},
    "mask": {"iFilter": "blur(5px)", "iDisplay": "inline-block"},
    "opacity": {"iFilter": "opacity(0.1)", "iDisplay": "inline-block"},
    "weakening": {"wOpacity": "0.618"},
    "grey": {"iColor": "rgb(47, 79, 79)"},
    "italic": {"iFontStyle": "italic"},
    "bold": {"iFontWeight": "700"},
}

# Heading translations are inline units: box themes use the compact inline variant.
INLINE_EXPECTED = {
    "none": {"wDisplay": "inline"},
    "solidBorder": {"wDisplay": "inline", "wBorderTopStyle": "solid", "wPaddingTop": "2px"},
    "dividingLine": {"beforeContent": '""', "beforeBorderLeftStyle": "dashed"},
    "background": {"iBg": "rgba(219, 175, 175, 0.12)", "iPaddingLeft": "6px"},
}

PROPS_JS = """(sel) => {
    const w = document.querySelector(sel + ' .ilt-t');
    const i = w && w.querySelector('.ilt-i');
    if (!w || !i) return null;
    const cs = getComputedStyle(w), ci = getComputedStyle(i), cb = getComputedStyle(w, '::before');
    return {
        wDisplay: cs.display, wOpacity: cs.opacity, wLineHeight: cs.lineHeight,
        wBorderTopStyle: cs.borderTopStyle, wBorderTopColor: cs.borderTopColor,
        wBorderLeftStyle: cs.borderLeftStyle, wBorderLeftWidth: cs.borderLeftWidth, wBorderLeftColor: cs.borderLeftColor,
        wPaddingTop: cs.paddingTop, wPaddingLeft: cs.paddingLeft,
        wBg: cs.backgroundColor, wRadius: cs.borderRadius, wShadow: cs.boxShadow,
        beforeContent: cb.content, beforeBorderTopStyle: cb.borderTopStyle, beforeBorderTopColor: cb.borderTopColor,
        beforeBorderLeftStyle: cb.borderLeftStyle,
        iDisplay: ci.display, iFilter: ci.filter, iColor: ci.color, iPaddingLeft: ci.paddingLeft,
        iBg: ci.backgroundColor, iBgImage: ci.backgroundImage, iBgSize: ci.backgroundSize,
        iBorderBottomStyle: ci.borderBottomStyle, iBorderBottomColor: ci.borderBottomColor, iBorderBottomWidth: ci.borderBottomWidth,
        iDecLine: ci.textDecorationLine, iDecStyle: ci.textDecorationStyle, iDecColor: ci.textDecorationColor,
        iFontStyle: ci.fontStyle, iFontWeight: ci.fontWeight, iTextShadow: ci.textShadow,
    };
}"""


def check(name, cond, detail=""):
    RESULTS.append((name, bool(cond)))
    print(f"{'PASS' if cond else 'FAIL'}  {name}  {detail}", flush=True)


class MockOpenAI(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n))
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


def wait_stable(page, timeout=30, stable=1.0, min_count=10):
    deadline = time.time() + timeout
    last, since = -1, time.time()
    while time.time() < deadline:
        n = count_wrappers(page)
        now = time.time()
        if n != last:
            last, since = n, now
        elif n >= min_count and now - since >= stable:
            return n
        time.sleep(0.2)
    return last


def toggle(page):
    page.wait_for_selector("[data-ilt-ui]", timeout=15000)
    page.locator("[data-ilt-ui] button.main").click()


def matches(props, expected):
    """Substring match so gradient/shadow lists compare by their distinctive part."""
    if props is None:
        return False, "no wrapper/inner"
    bad = {k: (props.get(k), v) for k, v in expected.items() if v not in str(props.get(k))}
    return not bad, str(bad)


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
            user_data_dir=tempfile.mkdtemp(prefix="ilt-styles-"),
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

        page.goto("http://127.0.0.1:8765/", wait_until="domcontentloaded")
        ext_id = ""
        deadline = time.time() + 15
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

        pop = ctx.new_page()
        pop.goto(f"chrome-extension://{ext_id}/popup.html")
        pop.wait_for_selector("#style option", state="attached")

        def seed(style):
            cfg = {
                "targetLang": "zh-CN", "service": "openai", "auto": False, "autoSites": {},
                "openai": {"baseUrl": "http://127.0.0.1:8766/v1", "apiKey": "test", "model": "mock"},
                "style": style, "floating": True, "customRules": [],
            }
            pop.evaluate("(c) => chrome.storage.local.set({ settings: c })", cfg)
            pop.wait_for_function("(s) => chrome.storage.local.get('settings').then(r => (r.settings||{}).style === s)", arg=style)

        # --- per-theme computed styles on the fixture ---
        for style in STYLE_IDS:
            seed(style)
            page.goto("http://127.0.0.1:8765/", wait_until="networkidle")
            toggle(page)
            n = wait_stable(page)
            ok, detail = matches(page.evaluate(PROPS_JS, "#p1"), EXPECTED[style])
            check(f"style {style}: block", ok and n >= 10, detail if not ok else f"count={n}")
            if style in INLINE_EXPECTED:
                ok, detail = matches(page.evaluate(PROPS_JS, "#title"), INLINE_EXPECTED[style])
                check(f"style {style}: inline variant", ok, detail)
            if style in ("mask", "opacity"):
                page.hover("#p1 .ilt-i")
                try:
                    page.wait_for_function("() => getComputedStyle(document.querySelector('#p1 .ilt-i')).filter === 'none'", timeout=3000)
                    revealed = True
                except Exception:
                    revealed = False
                filt = page.eval_on_selector("#p1 .ilt-i", "el => getComputedStyle(el).filter")
                check(f"style {style}: hover reveals", revealed and filt == "none", filt)
                page.mouse.move(0, 0)
            page.screenshot(path=str(SHOTS / f"style-{style}.png"))

        # --- popup option list + live preview ---
        def wait_value(v):
            try:
                pop.wait_for_function("(x) => document.getElementById('style').value === x", arg=v, timeout=5000)
                return True
            except Exception:
                return False

        opts = pop.eval_on_selector_all("#style option", "els => els.map(e => e.value)")
        check("popup lists all 17 themes in order", opts == STYLE_IDS, str(opts))

        group = pop.eval_on_selector("#style optgroup", "el => ({ label: el.label, ids: Array.from(el.children).map(o => o.value) })")
        check("hover-to-reveal styles grouped under a text header",
              group["label"] == "Hover to reveal" and group["ids"] == ["mask", "opacity"], str(group))

        pop.select_option("#style", "highlight")
        bg = pop.eval_on_selector("#style-preview .ilt-i", "el => getComputedStyle(el).backgroundColor")
        check("popup preview updates live", bg == YELLOW, bg)
        pop.wait_for_function("() => chrome.storage.local.get('settings').then(s => (s.settings||{}).style === 'highlight')")
        pop.reload()
        pop.wait_for_selector("#style option", state="attached")
        ok = wait_value("highlight")
        val = pop.eval_on_selector("#style", "el => el.value")
        bg = pop.eval_on_selector("#style-preview .ilt-i", "el => getComputedStyle(el).backgroundColor")
        check("style choice + preview persist", ok and val == "highlight" and bg == YELLOW, f"{val} {bg}")
        pop.select_option("#style", "mask")
        pop.wait_for_function("() => getComputedStyle(document.querySelector('#style-preview .ilt-i')).filter === 'blur(5px)'", timeout=3000)
        filt = pop.eval_on_selector("#style-preview .ilt-i", "el => getComputedStyle(el).filter")
        check("popup preview shows blur", filt == "blur(5px)", filt)
        pop.screenshot(path=str(SHOTS / "popup-style.png"))

        check("no [ilt] runtime errors", not ilt_errors, "; ".join(ilt_errors[:3])[:200])
        ctx.close()

    failed = [n for n, ok in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} passed")
    if failed:
        print("FAILED:", failed)
        sys.exit(1)


if __name__ == "__main__":
    main()