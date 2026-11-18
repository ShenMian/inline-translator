"""Generate 1280x800 24-bit RGB screenshots for README and browser extension stores."""
import io
import json
import os
import re
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / ".output" / "chrome-mv3"
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
OUT = ROOT / "docs"
WIDTH, HEIGHT = 1280, 800


def _to_rgb(img_or_bytes) -> Image.Image:
    img = Image.open(io.BytesIO(img_or_bytes)) if isinstance(img_or_bytes, (bytes, bytearray)) else img_or_bytes
    return img if img.mode == "RGB" else img.convert("RGB")


def save_rgb_png(img_or_bytes, path: Path) -> None:
    img = _to_rgb(img_or_bytes)
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, format="PNG", optimize=True)
    saved = Image.open(path)
    print(f"SAVED {path.relative_to(ROOT)}  size={saved.size}  mode={saved.mode}  bytes={path.stat().st_size}")


def save_rgb_1280x800(img_or_bytes, path: Path) -> None:
    img = _to_rgb(img_or_bytes)
    if img.size != (WIDTH, HEIGHT):
        img = img.resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS)
    save_rgb_png(img, path)


def count_wrappers(page) -> int:
    return page.eval_on_selector_all(".ilt-t", "els => els.length")


def wait_translation_done(page, min_count=12, timeout=45, stable=1.8) -> int:
    deadline = time.time() + timeout
    last, since = -1, time.time()
    while time.time() < deadline:
        n = count_wrappers(page)
        busy = page.evaluate(
            """() => {
                const host = document.querySelector('[data-ilt-ui]');
                const btn = host && host.shadowRoot && host.shadowRoot.querySelector('button.main');
                if (!btn) return false;
                return btn.classList.contains('busy') || !btn.classList.contains('active');
            }"""
        )
        now = time.time()
        if n != last or busy:
            last, since = n, now
        elif n >= min_count and now - since >= stable:
            return n
        time.sleep(0.25)
    return last


def set_settings(pop, cfg: dict) -> None:
    pop.evaluate("(c) => chrome.storage.local.set({ settings: c })", cfg)
    pop.wait_for_function(
        "(expected) => chrome.storage.local.get('settings').then(r => JSON.stringify(r.settings) === JSON.stringify(expected))",
        arg=cfg,
    )


def build_shot1_mdn(page, pop) -> None:
    set_settings(
        pop,
        {
            "targetLang": "zh-CN",
            "service": "google",
            "auto": False,
            "autoSites": {},
            "openai": {"baseUrl": "", "apiKey": "", "model": ""},
            "style": "none",
            "floating": True,
            "customRules": [],
        },
    )
    page.goto("https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver", wait_until="networkidle")
    page.add_style_tag(
        content=(
            ".page-layout__banner, mdn-placement-top, mdn-placement-sidebar, mdn-placement-bottom, "
            ".top-banner, .pong-box, .ethical-ads, [data-testid*='placement'] { display: none !important; }"
        )
    )
    page.evaluate("window.scrollTo(0, 0)")
    page.wait_for_selector("[data-ilt-ui]", timeout=15000)
    page.locator("[data-ilt-ui] button.main").click()
    n = wait_translation_done(page, min_count=12, timeout=45, stable=2.0)
    print(f"Shot 1 (MDN): translated wrappers={n}")
    page.evaluate("window.scrollTo(0, 0)")
    time.sleep(0.3)
    save_rgb_1280x800(page.screenshot(), OUT / "inline-translation.png")


def build_shot2_popup(ctx, ext_id: str) -> None:
    pop = ctx.new_page()
    pop.set_viewport_size({"width": 300, "height": 800})
    pop.goto(f"chrome-extension://{ext_id}/popup.html")
    pop.wait_for_selector("#style option", state="attached")

    set_settings(
        pop,
        {
            "targetLang": "zh-CN",
            "service": "google",
            "auto": False,
            "autoSites": {},
            "openai": {
                "baseUrl": "https://api.openai.com/v1",
                "apiKey": "",
                "model": "gpt-4o-mini",
            },
            "style": "wavy",
            "floating": True,
            "customRules": [],
        },
    )
    pop.reload(wait_until="load")
    pop.wait_for_selector("#style option", state="attached")
    pop.evaluate(
        """() => {
            const label = document.getElementById('auto-site-label');
            label.textContent = 'Auto-translate this site';
            label.title = '';
            const btn = document.getElementById('toggle');
            btn.textContent = 'Translate page';
            btn.classList.add('btn-primary');
            btn.classList.remove('btn-neutral');
        }"""
    )
    time.sleep(0.25)
    popup_bytes = pop.locator("body").screenshot()
    pop.close()
    save_rgb_png(popup_bytes, OUT / "popup-controls.png")


SHOWCASE_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    width: 1280px;
    height: 800px;
    overflow: hidden;
    background: #f8fafc;
    color: #0f172a;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  .grid {
    width: 1280px;
    height: 800px;
    padding: 20px 26px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-rows: repeat(3, 1fr);
    gap: 16px 20px;
  }
  .card {
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 12px;
    padding: 14px 18px;
    box-shadow: 0 1px 3px rgba(15, 23, 42, 0.05);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .badge {
    align-self: flex-start;
    display: inline-block;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: #475569;
    background: #f1f5f9;
    border: 1px solid #e2e8f0;
    border-radius: 999px;
    padding: 2px 10px;
    margin-bottom: 8px;
  }
  h3 {
    margin: 0 0 8px 0;
    font-size: 15px;
    font-weight: 700;
    line-height: 1.35;
    color: #0f172a;
  }
  p {
    margin: 0;
    font-size: 13px;
    line-height: 1.5;
    color: #334155;
  }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    background: #f1f5f9;
    color: #0f172a;
    padding: 1px 5px;
    border-radius: 4px;
    border: 1px solid #e2e8f0;
  }
  a {
    color: #2563eb;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
</style>
</head>
<body>
  <div class="grid">
    <section class="card" id="card-wavy">
      <div class="badge notranslate" translate="no">Wavy lines</div>
      <h3>DOM Observation</h3>
      <p>Call <code>observe()</code> to watch <a href="#dom">DOM mutations</a> in real time without blocking page layout or losing scroll position.</p>
    </section>
    <section class="card" id="card-blockquote">
      <div class="badge notranslate" translate="no">Quote style</div>
      <h3>DOM Observation</h3>
      <p>Call <code>observe()</code> to watch <a href="#dom">DOM mutations</a> in real time without blocking page layout or losing scroll position.</p>
    </section>
    <section class="card" id="card-background">
      <div class="badge notranslate" translate="no">Background</div>
      <h3>DOM Observation</h3>
      <p>Call <code>observe()</code> to watch <a href="#dom">DOM mutations</a> in real time without blocking page layout or losing scroll position.</p>
    </section>
    <section class="card" id="card-dividingLine">
      <div class="badge notranslate" translate="no">Dividing line</div>
      <h3>DOM Observation</h3>
      <p>Call <code>observe()</code> to watch <a href="#dom">DOM mutations</a> in real time without blocking page layout or losing scroll position.</p>
    </section>
    <section class="card" id="card-paper">
      <div class="badge notranslate" translate="no">Paper shadow</div>
      <h3>DOM Observation</h3>
      <p>Call <code>observe()</code> to watch <a href="#dom">DOM mutations</a> in real time without blocking page layout or losing scroll position.</p>
    </section>
    <section class="card" id="card-mask">
      <div class="badge notranslate" translate="no">Blur · Hover to reveal</div>
      <h3>DOM Observation</h3>
      <p>Call <code>observe()</code> to watch <a href="#dom">DOM mutations</a> in real time without blocking page layout or losing scroll position.</p>
    </section>
  </div>
</body>
</html>
"""

SCOPED_STYLE_CSS = """
#card-wavy .ilt-i {
  text-decoration: underline;
  text-decoration-color: #72ece9;
  text-decoration-style: wavy;
}
#card-blockquote .ilt-t.ilt-block {
  display: block;
  width: fit-content;
  border-left: 4px solid #cc3355;
  padding: 4px 0 4px 12px;
  margin-top: 6px;
  margin-bottom: 2px;
}
#card-background .ilt-t.ilt-block {
  display: block;
  width: fit-content;
  margin: 6px 0 0 0;
  background: rgba(219, 175, 175, 0.12);
  border-radius: 4px;
  padding: 10px 12px;
}
#card-background .ilt-t.ilt-inline .ilt-i {
  background: rgba(219, 175, 175, 0.12);
  padding-left: 6px;
  padding-right: 6px;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}
#card-dividingLine .ilt-t.ilt-block::before {
  content: "";
  display: block;
  max-width: 80px;
  width: 10%;
  border-top: 1px dashed #94a3b8;
  padding-top: 6px;
}
#card-dividingLine .ilt-t.ilt-inline::before {
  content: "";
  border-left: 1px dashed #94a3b8;
  height: 16px;
  max-height: 16px;
  padding-left: 8px;
}
#card-paper .ilt-t.ilt-block {
  display: block;
  width: fit-content;
  margin: 8px 0 0 0;
  box-shadow: rgba(0, 0, 0, 0.24) 0 3px 8px;
  padding: 12px 22px;
}
#card-mask .ilt-i {
  display: inline-block;
  filter: blur(5px);
  transition: filter 0.3s ease;
  border-radius: 10px;
}
"""


def start_showcase_servers():
    class MockOpenAIHandler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            n = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(n))
            texts = json.loads(body["messages"][1]["content"])
            out = []
            for t in texts:
                if "DOM Observation" in t:
                    out.append("DOM 观察")
                else:
                    code_m = re.search(r"\{\{\d+\}\}", t)
                    tag_m = re.search(r"<(t\d+)>.*?</\1>", t)
                    code_tok = code_m.group(0) if code_m else "<code>observe()</code>"
                    if tag_m:
                        tag = tag_m.group(1)
                        link_tok = f"<{tag}>DOM 变更</{tag}>"
                    else:
                        link_tok = "DOM 变更"
                    out.append(
                        f"调用 {code_tok} 即可实时监听 {link_tok}，既不阻塞页面布局，也不会丢失滚动位置。"
                    )
            data = json.dumps(
                {"choices": [{"message": {"content": json.dumps(out, ensure_ascii=False)}}]},
                ensure_ascii=False,
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    class ShowcaseHandler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            data = SHOWCASE_HTML.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    mock_srv = ThreadingHTTPServer(("127.0.0.1", 0), MockOpenAIHandler)
    html_srv = ThreadingHTTPServer(("127.0.0.1", 0), ShowcaseHandler)
    threading.Thread(target=mock_srv.serve_forever, daemon=True).start()
    threading.Thread(target=html_srv.serve_forever, daemon=True).start()
    return mock_srv, html_srv


def build_shot3_styles(page, pop) -> None:
    mock_srv, html_srv = start_showcase_servers()
    mock_port = mock_srv.server_address[1]
    html_port = html_srv.server_address[1]
    try:
        set_settings(
            pop,
            {
                "targetLang": "zh-CN",
                "service": "openai",
                "auto": False,
                "autoSites": {},
                "openai": {
                    "baseUrl": f"http://127.0.0.1:{mock_port}/v1",
                    "apiKey": "test-key",
                    "model": "mock",
                },
                "style": "none",
                "floating": False,
                "customRules": [],
            },
        )
        url = f"http://127.0.0.1:{html_port}/"
        page.goto(url, wait_until="load")
        time.sleep(0.3)
        pop.evaluate(
            "(u) => chrome.tabs.query({url: u + '*'}).then(ts => chrome.tabs.sendMessage(ts[0].id, {type: 'toggle'}))",
            url,
        )
        page.wait_for_function("() => document.querySelectorAll('.ilt-t').length === 12", timeout=15000)
        page.add_style_tag(content=SCOPED_STYLE_CSS)
        time.sleep(0.35)
        n = count_wrappers(page)
        print(f"Shot 3 (Styles): translated wrappers={n}")
        save_rgb_1280x800(page.screenshot(), OUT / "translation-styles.png")
    finally:
        mock_srv.shutdown()
        html_srv.shutdown()


def main() -> None:
    if not EXT.exists():
        raise FileNotFoundError(f"Built extension not found at {EXT}; run `npm run build` first.")

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=tempfile.mkdtemp(prefix="ilt-shots-"),
            executable_path=EDGE,
            headless=bool(os.environ.get("CI")),
            viewport={"width": WIDTH, "height": HEIGHT},
            color_scheme="light",
            locale="en-US",
            args=[
                f"--disable-extensions-except={EXT}",
                f"--load-extension={EXT}",
                "--no-first-run",
                "--no-default-browser-check",
            ],
        )
        try:
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            # Start MV3 service worker via a fast local server request
            mock_srv, html_srv = start_showcase_servers()
            wake_port = html_srv.server_address[1]
            try:
                page.goto(f"http://127.0.0.1:{wake_port}/", wait_until="domcontentloaded")
                ext_id = ""
                deadline = time.time() + 15
                while time.time() < deadline and not ext_id:
                    for sw in ctx.service_workers:
                        if sw.url.startswith("chrome-extension://"):
                            ext_id = sw.url.split("/")[2]
                    if not ext_id:
                        time.sleep(0.25)
                if not ext_id:
                    raise RuntimeError("Extension service worker did not start")
            finally:
                mock_srv.shutdown()
                html_srv.shutdown()

            pop = ctx.new_page()
            pop.goto(f"chrome-extension://{ext_id}/popup.html")
            pop.wait_for_selector("#style option", state="attached")

            build_shot1_mdn(page, pop)
            build_shot3_styles(page, pop)
            pop.close()
            build_shot2_popup(ctx, ext_id)
        finally:
            ctx.close()


if __name__ == "__main__":
    main()
