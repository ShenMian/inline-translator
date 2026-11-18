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
    slot_info = page.evaluate(
        """() => {
            const fb = document.getElementById('flex-between');
            const fbw = fb && fb.querySelector('.ilt-t');
            const fbv = document.getElementById('fb-val');
            const gb = document.getElementById('grid-bare');
            const gbw = gb && gb.querySelector('.ilt-t');
            const gbv = document.getElementById('gb-val');
            if (!fbw || !fbv || !gbw || !gbv) return null;
            return {
                fbChildren: fb.children.length,
                fbTransLeft: fbw.getBoundingClientRect().left,
                fbMid: (fb.getBoundingClientRect().left + fb.getBoundingClientRect().right) / 2,
                gbChildren: gb.children.length,
                gbSameRow: Math.abs(gbw.getBoundingClientRect().top - gbv.getBoundingClientRect().top) < 8,
            };
        }"""
    )
    check(
        "fixture: bare text in flex space-between and grid keeps single layout slot",
        bool(
            slot_info
            and slot_info["fbChildren"] == 2
            and slot_info["fbTransLeft"] < slot_info["fbMid"]
            and slot_info["gbChildren"] == 2
            and slot_info["gbSameRow"]
        ),
        str(slot_info),
    )
    check(
        "fixture: heading translation inline right",
        page.eval_on_selector("#title", "el => { const w = el.querySelector('.ilt-t'); if (!w) return false; const a = el.getBoundingClientRect(), b = w.getBoundingClientRect(); return getComputedStyle(w).display === 'inline' && b.top < a.top + 10 && b.left > a.left; }"),
    )
    copied_title = page.evaluate(
        """() => {
            const h = document.getElementById('title');
            const sel = window.getSelection();
            sel.removeAllRanges();
            const range = document.createRange();
            range.selectNodeContents(h);
            sel.addRange(range);
            const s = sel.toString();
            sel.removeAllRanges();
            return s;
        }"""
    )
    check(
        "fixture: inline translation copies with a clean separator space",
        copied_title.startswith("The Quick Brown Fox ") and not copied_title.startswith("The Quick Brown Fox  ") and len(copied_title) > len("The Quick Brown Fox "),
        repr(copied_title),
    )
    check(
        "fixture: long heading inside article header breaks to new line",
        page.eval_on_selector("#long-title", "el => { const w = el.querySelector('.ilt-t'); return !!w && getComputedStyle(w).display === 'block'; }"),
    )
    check("fixture: table cell translated", page.eval_on_selector("#td1", "el => !!el.querySelector('.ilt-t')"))
    check("fixture: block inside anchor", page.eval_on_selector("#badnest", "el => !!el.querySelector('.ilt-t')"))
    check(
        "fixture: inline-block strip translates inside items",
        page.eval_on_selector("#tabstrip", "el => !el.querySelector(':scope > .ilt-t') && Array.from(el.children).every(li => { const w = li.querySelector('.ilt-t'); return !!w && getComputedStyle(w).display === 'inline'; })"),
    )
    check(
        "fixture: flex crumb translation inline",
        page.eval_on_selector("#crumb-last", "el => { const w = el.querySelector('.ilt-t'); return !!w && getComputedStyle(w).display === 'inline'; }"),
    )
    check(
        "fixture: metadata value inline beside label",
        page.eval_on_selector("#meta", "el => { const w = el.querySelector(':scope > .ilt-t'); return !!w && getComputedStyle(w).display === 'inline'; }"),
    )
    check(
        "fixture: prose div renders as block",
        page.eval_on_selector("#prose-div", "el => { const w = el.querySelector(':scope > .ilt-t'); return !!w && getComputedStyle(w).display === 'block'; }"),
    )
    check(
        "fixture: inline translate=no preserved in place",
        page.eval_on_selector("#inline-notrans", "el => { const w = el.querySelector('.ilt-t'); return !!w && !!w.querySelector('.kbd-chip') && w.textContent.includes('Ctrl+K'); }"),
    )
    check(
        "fixture: nested hidden/sr-only/icon stripped & link target kept",
        page.eval_on_selector(
            "#nested-skip",
            """el => {
                const a = el.querySelector('.ilt-t a');
                if (!a) return false;
                const t = a.textContent;
                return a.getAttribute('target') === '_blank' && (a.getAttribute('rel') || '').includes('noopener')
                    && !t.includes('arrow_forward') && !t.includes('↗') && !t.includes('new tab') && !t.includes('新标签');
            }""",
        ),
    )
    check(
        "fixture: nav dropdown places translation before trailing svg chevron without cloning svg",
        page.eval_on_selector(
            "#nav-chevron",
            """el => {
                const w = el.querySelector(':scope > .ilt-t');
                const svg = el.querySelector('#chevron-svg');
                if (!w || !svg) return false;
                const wr = w.getBoundingClientRect(), sr = svg.getBoundingClientRect();
                return w.nextElementSibling === svg && !w.querySelector('svg') && wr.left < sr.left && Math.abs(wr.top - sr.top) < 12;
            }""",
        ),
    )
    check(
        "fixture: inline-flex link inside prose stays single paragraph",
        page.eval_on_selector(
            "#inline-flex-prose",
            "el => el.querySelectorAll('.ilt-t').length === 1 && !!el.querySelector('.ilt-t a[href=\"https://example.com/guide\"]') && !el.querySelector('.ilt-t svg')",
        ),
    )
    check(
        "fixture: visible pre block splits surrounding prose runs",
        page.eval_on_selector(
            "#split-around-pre",
            "el => el.querySelectorAll(':scope > .ilt-t').length === 2 && !el.querySelector('pre .ilt-t')",
        ),
    )
    check(
        "fixture: ruby strips rt/rp without splitting sentence",
        page.eval_on_selector("#ruby-p", "el => el.querySelectorAll('.ilt-t').length === 1 && !el.querySelector('.ilt-t rt')"),
    )
    check(
        "fixture: katex math kept atomic",
        page.eval_on_selector("#math-p", "el => { const k = el.querySelector('.ilt-t .katex'); return !!k && k.textContent === 'E = mc^2'; }"),
    )
    check(
        "fixture: direct text inside display:contents translated",
        page.eval_on_selector("#direct-contents", "el => !!el.querySelector('.ilt-t')"),
    )
    check(
        "fixture: line-clamp unlocked while translated",
        page.eval_on_selector("#clamped-p", "el => el.hasAttribute('data-ilt-unclamp') && getComputedStyle(el).webkitLineClamp === 'none'"),
    )
    check(
        "fixture: pre-wrap preserves whitespace mode",
        page.eval_on_selector("#prewrap-div", "el => { const w = el.querySelector('.ilt-t'); return !!w && getComputedStyle(w).whiteSpace === 'pre-wrap'; }"),
    )
    check(
        "fixture: font wrapper immune to host span CSS",
        page.eval_on_selector("#span-trap", "el => { const w = el.querySelector('.ilt-t'); return !!w && w.tagName === 'FONT' && getComputedStyle(w).display === 'block'; }"),
    )
    rtl_info = page.evaluate(
        """() => {
            const hi = document.querySelector('#rtl-heading .ilt-i');
            const hw = document.querySelector('#rtl-heading .ilt-t');
            const pw = document.querySelector('#rtl-para .ilt-t');
            if (!hi || !hw || !pw) return null;
            const hcs = getComputedStyle(hw), pcs = getComputedStyle(pw);
            return {
                hInnerDir: hi.getAttribute('dir'),
                hMarginRight: parseFloat(hcs.marginRight),
                hMarginLeft: parseFloat(hcs.marginLeft),
                pDir: pw.getAttribute('dir'),
                pBidi: pcs.unicodeBidi,
                pAlign: pcs.textAlign,
            };
        }"""
    )
    check(
        "fixture: RTL source isolates LTR translation direction and alignment",
        bool(
            rtl_info
            and rtl_info["hInnerDir"] == "ltr"
            and rtl_info["hMarginRight"] > 0
            and rtl_info["hMarginLeft"] == 0
            and rtl_info["pDir"] == "ltr"
            and rtl_info["pBidi"] == "isolate"
            and rtl_info["pAlign"] == "start"
        ),
        str(rtl_info),
    )
    check("fixture: long paragraph translated", page.eval_on_selector("#long", "el => { const w = el.querySelector('.ilt-t'); return !!w && w.textContent.length > 500; }"))
    check("fixture: button text translated inline", page.eval_on_selector("#add-btn", "el => { const w = el.querySelector('.ilt-t'); return !!w && getComputedStyle(w).display === 'inline'; }"))
    check("fixture: flex button child span translated inline", page.eval_on_selector("#flex-btn", "el => { const w = el.querySelector('.ilt-t'); return !!w && getComputedStyle(w).display === 'inline'; }"))

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

    # Hidden <details> reveals and translates on open
    check("fixture: closed details body initially untranslated", no_wrapper_after(page, "#details-p"))
    page.click("#details-reveal > summary")
    page.wait_for_selector("#details-p .ilt-t", timeout=15000)
    check("fixture: opened details body translated", True)

    # Inner scroll container: lazy below-200% item translates on scroll, and above-fold insertions keep scroll anchor
    check("fixture: inner scroller top item translated", page.eval_on_selector("#sc-top", "el => !!el.querySelector('.ilt-t')"))
    check("fixture: inner scroller deep item initially lazy", no_wrapper_after(page, "#sc-bottom"))
    page.eval_on_selector("#inner-scroller", "sc => { sc.scrollIntoView({ block: 'center' }); sc.scrollTop = sc.scrollHeight; }")
    page.wait_for_selector("#sc-bottom .ilt-t", state="attached", timeout=15000)
    page.evaluate(
        """() => {
            const sc = document.getElementById('inner-scroller');
            const tail = document.createElement('div');
            tail.style.height = '160px';
            sc.append(tail);
            const p = document.createElement('p');
            p.id = 'sc-prepended';
            p.textContent = 'Newly inserted paragraph right above the inner scroller reading line.';
            const b = document.getElementById('sc-bottom');
            b.parentNode.insertBefore(p, b);
            sc.scrollTop = b.offsetTop - 12;
        }"""
    )
    before_top = page.eval_on_selector("#sc-bottom", "el => el.getBoundingClientRect().top")
    page.wait_for_selector("#sc-prepended .ilt-t", state="attached", timeout=15000)
    time.sleep(0.2)
    after_top = page.eval_on_selector("#sc-bottom", "el => el.getBoundingClientRect().top")
    check("fixture: inner scroller translates on scroll and anchors position", abs(after_top - before_top) < 6, f"before={before_top:.1f} after={after_top:.1f}")

    # Dynamic insertion
    page.click("#add-btn")
    page.wait_for_selector("#added .ilt-t", timeout=15000)
    check("fixture: dynamically added paragraph", True)

    # Streaming text holdoff + ticking short counter guard
    mid_stream = page.evaluate(
        """async () => {
            const dyn = document.getElementById('dynamic');
            dyn.scrollIntoView({ block: 'center' });
            const sp = document.createElement('p');
            sp.id = 'stream-p';
            sp.textContent = 'Streaming';
            dyn.appendChild(sp);
            const chunks = [
                'Streaming artificial',
                'Streaming artificial intelligence',
                'Streaming artificial intelligence response',
                'Streaming artificial intelligence response settles cleanly.',
            ];
            for (const c of chunks) {
                await new Promise(r => setTimeout(r, 60));
                sp.firstChild.nodeValue = c;
            }
            return !!sp.querySelector('.ilt-t');
        }"""
    )
    check("fixture: streaming text holds off premature partial translation", not mid_stream)
    page.wait_for_selector("#stream-p .ilt-t", timeout=15000)
    check("fixture: streaming text translates once settled", True)

    ticker_skipped = page.evaluate(
        """async () => {
            const dyn = document.getElementById('dynamic');
            const tp = document.createElement('p');
            tp.id = 'ticker-p';
            tp.textContent = 'Live 19s left';
            dyn.appendChild(tp);
            for (const s of ['Live 18s left', 'Live 17s left', 'Live 16s left', 'Live 15s left']) {
                await new Promise(r => setTimeout(r, 25));
                tp.firstChild.nodeValue = s;
            }
            await new Promise(r => setTimeout(r, 600));
            return !tp.querySelector('.ilt-t');
        }"""
    )
    check("fixture: rapid short ticking counter skips retranslation churn", ticker_skipped)

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

    page.evaluate("window.scrollTo(0, 0)")
    page.screenshot(path=str(SHOTS / "fixture-top.png"))
    page.eval_on_selector("#flex-between", "el => el.scrollIntoView({ block: 'center' })")
    page.screenshot(path=str(SHOTS / "fixture-flex.png"))
    page.eval_on_selector("#rtl-heading", "el => el.scrollIntoView({ block: 'center' })")
    page.screenshot(path=str(SHOTS / "fixture-rtl.png"))

    # Restore
    toggle(page)
    time.sleep(0.5)
    check(
        "fixture: no residue after restore",
        count_wrappers(page) == 0 and page.eval_on_selector_all(".ilt-g", "els => els.length") == 0,
        f"count={count_wrappers(page)}",
    )
    check("fixture: line-clamp attribute cleaned up after restore", page.eval_on_selector("#clamped-p", "el => !el.hasAttribute('data-ilt-unclamp')"))

    page.screenshot(path=str(SHOTS / "fixture.png"), full_page=True)


def run_only_rule(ctx, page, ext_id):
    pop = ctx.new_page()
    pop.goto(f"chrome-extension://{ext_id}/popup.html")
    pop.wait_for_selector("#rules-text", state="attached")
    pop.evaluate(
        """() => chrome.storage.local.get('settings').then(r => {
            const s = r.settings || {};
            s.customRules = [{ matches: ['*://127.0.0.1*/*'], only: ['#shell'] }];
            return chrome.storage.local.set({ settings: s });
        })"""
    )
    page.goto("http://127.0.0.1:8765/", wait_until="networkidle")
    toggle(page)
    n = wait_stable(page, timeout=15, stable=1.2)
    only_ok = page.evaluate(
        """() => {
            const shellCount = document.querySelectorAll('#shell .ilt-t').length;
            const total = document.querySelectorAll('.ilt-t').length;
            return shellCount === 2 && total === 2 && !document.querySelector('#p1 .ilt-t') && !document.querySelector('#title .ilt-t');
        }"""
    )
    check("fixture: site rule 'only' whitelist restricts translation scope", only_ok, f"count={n}")
    toggle(page)
    pop.evaluate(
        """() => chrome.storage.local.get('settings').then(r => {
            const s = r.settings || {};
            s.customRules = [{ matches: ['*://127.0.0.1*/*'], only: ['#p1', '#p-link', '#p2'] }];
            s.service = 'edge';
            return chrome.storage.local.set({ settings: s });
        })"""
    )
    page.goto("http://127.0.0.1:8765/", wait_until="networkidle")
    toggle(page)
    wait_stable(page, timeout=20, stable=1.2, min_count=3)
    edge_rich = page.evaluate(
        """() => {
            const p1 = document.querySelector('#p1 .ilt-t');
            const p2 = document.querySelector('#p2 .ilt-t');
            return {
                link: !!(p1 && p1.querySelector('a[href="https://example.com"]')),
                bold: !!(p1 && p1.querySelector('b')),
                code: !!(p1 && p1.querySelector('code')),
                nested: !!(p2 && p2.querySelector('em strong')),
            };
        }"""
    )
    check(
        "fixture: Edge service preserves rich-text links, bold, code, and nested inline tags",
        all(edge_rich.values()),
        str(edge_rich),
    )
    page.screenshot(path=str(SHOTS / "fixture-edge.png"))
    toggle(page)
    pop.evaluate(
        """() => chrome.storage.local.get('settings').then(r => {
            const s = r.settings || {};
            s.customRules = [];
            s.service = 'google';
            return chrome.storage.local.set({ settings: s });
        })"""
    )

    # Floating button vertical drag + persistence + click suppression, and Alt-hover single-paragraph toggle
    page.goto("http://127.0.0.1:8765/", wait_until="networkidle")
    page.wait_for_selector("[data-ilt-ui]", timeout=15000)
    btn_box = page.locator("[data-ilt-ui] button.main").bounding_box()
    cx = btn_box["x"] + btn_box["width"] / 2
    cy = btn_box["y"] + btn_box["height"] / 2
    page.mouse.move(cx, cy)
    page.mouse.down()
    page.mouse.move(cx, cy - 140, steps=8)
    page.mouse.up()
    time.sleep(0.3)
    dragged_bottom = page.eval_on_selector("[data-ilt-ui]", "el => parseFloat(el.style.bottom)")
    check(
        "fixture: floating button drags vertically without triggering toggle",
        abs(dragged_bottom - 160) <= 4 and count_wrappers(page) == 0,
        f"bottom={dragged_bottom} wrappers={count_wrappers(page)}",
    )
    page.reload(wait_until="networkidle")
    page.wait_for_selector("[data-ilt-ui]", timeout=15000)
    time.sleep(0.3)
    persisted_bottom = page.eval_on_selector("[data-ilt-ui]", "el => parseFloat(el.style.bottom)")
    check("fixture: floating button vertical position persists across reload", abs(persisted_bottom - dragged_bottom) <= 2, f"persisted={persisted_bottom}")
    pop.evaluate("() => chrome.storage.local.set({ floatingBottom: 20 })")

    page.bring_to_front()
    page.hover("#p2")
    page.keyboard.press("Alt")
    page.wait_for_selector("#p2 .ilt-t", timeout=15000)
    check(
        "fixture: Alt-hover spot-translates only the hovered paragraph",
        count_wrappers(page) == 1 and page.eval_on_selector("#p2", "el => !!el.querySelector('.ilt-t')"),
        f"wrappers={count_wrappers(page)}",
    )
    page.hover("#p2")
    page.keyboard.press("Alt")
    time.sleep(0.2)
    check("fixture: Alt-hover second tap restores the hovered paragraph", count_wrappers(page) == 0, f"wrappers={count_wrappers(page)}")
    pop.close()


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
            const navBtns = [...document.querySelectorAll('.menu__tab-button')].filter(b => /Learn|Tools|About/.test(b.textContent));
            if (navBtns.length < 3 || !navBtns.every(b => { const w = b.querySelector('.ilt-t'); return !!w && getComputedStyle(w).display === 'inline'; })) return false;
            const blogTab = document.querySelector('.menu__tab:has(.menu__tab-link)');
            if (blogTab && blogTab.getBoundingClientRect().height > 45) return false;
            if (document.documentElement.scrollWidth > window.innerWidth) return false;
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

        # The same-language fixture is Chinese, matching the target (zh-CN). Commit the target
        # explicitly and reset the page before the fixture run so the content script initializes
        # cleanly with the committed settings.
        pop = ctx.new_page()
        pop.goto(f"chrome-extension://{ext_id}/popup.html")
        pop.wait_for_selector("#lang")
        pop.select_option("#lang", "zh-CN")
        pop.wait_for_function("() => chrome.storage.local.get('settings').then(s => (s.settings || {}).targetLang === 'zh-CN')")
        pop.close()
        page.goto("about:blank", wait_until="domcontentloaded")

        run_fixture(page)
        run_only_rule(ctx, page, ext_id)
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