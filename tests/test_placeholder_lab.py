from pathlib import Path
from playwright.sync_api import sync_playwright
import json, time
ROOT=Path(__file__).resolve().parent.parent
URL=(ROOT/'docs/placeholder-lab.html').as_uri()
OUT=ROOT/'tests/screenshots'
results=[]
def check(name, cond, detail=''):
    results.append((name,bool(cond)))
    print(('PASS' if cond else 'FAIL')+'  '+name+'  '+str(detail),flush=True)

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    for label,vp in [('desktop',{'width':1440,'height':1000}),('mobile',{'width':390,'height':844})]:
        page=browser.new_page(viewport=vp, device_scale_factor=1)
        errs=[]
        page.on('pageerror',lambda e: errs.append(str(e)))
        page.on('console',lambda m: errs.append(m.text) if m.type=='error' else None)
        page.goto(URL,wait_until='load')
        page.wait_for_timeout(300)
        check(label+': opens without runtime errors',not errs,errs[:3])
        check(label+': corpus populated',page.locator('#art-A .src').count()>=12 and page.locator('#art-B .src').count()>=12)
        check(label+': real screenshots embedded',page.eval_on_selector_all('.shots img','els=>els.every(e=>e.complete&&e.naturalWidth>100)'))
        check(label+': real measurement table populated',page.locator('#real-body tr').count()==6)
        check(label+': no horizontal overflow',page.evaluate('document.documentElement.scrollWidth <= innerWidth+1'),page.evaluate('[document.documentElement.scrollWidth,innerWidth]'))
        # Primary loop: let it finish with low latency and no lazy gating.
        page.locator('#lat').fill('100')
        page.locator('#lat').dispatch_event('input')
        page.locator('#lazy').uncheck()
        page.locator('#replay').click()
        page.wait_for_function("() => document.getElementById('state-A').textContent === '完成' && document.getElementById('state-B').textContent === '完成'",timeout=12000)
        check(label+': primary simulation completes',True)
        check(label+': all translations delivered',page.locator('#art-A .tr').count()==page.locator('#art-A .src').count() and page.locator('#art-B .tr').count()==page.locator('#art-B .src').count())
        check(label+': no placeholders left',page.locator('.ilt-p,.ilt-p-sk').count()==0)
        check(label+': comparison table live',page.locator('#cmp-body tr').count()==4)
        # Pause/replay repeated stability.
        page.locator('#replay').click(); page.wait_for_timeout(120)
        page.locator('#pause').click()
        check(label+': pause state visible',page.locator('#pause').inner_text()=='继续' and '暂停' in page.locator('#runtext').inner_text())
        before=page.locator('#art-A .tr').count(); page.wait_for_timeout(400)
        check(label+': pause freezes delivery',page.locator('#art-A .tr').count()==before)
        page.locator('#pause').click(); page.wait_for_timeout(400)
        check(label+': resume progresses',page.locator('#art-A .tr').count()>=before)
        # Live controls.
        page.locator('#fid').select_option('block'); page.wait_for_timeout(150)
        check(label+': fidelity control replays',page.locator('#state-B').inner_text()!='完成')
        page.locator('#alpha').fill('0.7'); page.locator('#alpha').dispatch_event('input')
        check(label+': opacity updates CSS',page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--sk-alpha').trim()")=='0.7')
        page.locator('#shim').fill('2.4'); page.locator('#shim').dispatch_event('input')
        check(label+': shimmer updates CSS',page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--shim-dur').trim()")=='2.4s')
        page.locator('#fs').fill('20'); page.locator('#fs').dispatch_event('input')
        check(label+': font size updates CSS',page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--article-fs').trim()")=='20px')
        page.locator('#batch-inc').click(); check(label+': batch stepper increments',page.locator('#batch-val').inner_text()=='7')
        page.locator('#batch-dec').click(); check(label+': batch stepper decrements',page.locator('#batch-val').inner_text()=='6')
        page.locator('#dir').select_option('zhen'); page.wait_for_timeout(100)
        check(label+': language direction reverses',page.locator('#art-A .src').first.evaluate('e=>e.firstChild.textContent')=='论阅读与翻译',[page.locator('#dir').input_value(),page.locator('#art-A .src').first.evaluate('e=>e.firstChild.textContent')])
        page.locator('#theme').click(); check(label+': theme switches',page.locator('html').get_attribute('data-theme')=='dark')
        page.locator('#rand').click(); check(label+': randomize stays valid',page.locator('#lat-out').inner_text().endswith('ms'))
        page.locator('#reset').click(); check(label+': reset restores defaults',page.locator('#lat').input_value()=='900' and page.locator('#dir').input_value()=='enzh' and page.locator('html').get_attribute('data-theme')=='dark')
        # Export action produces a real JSON download.
        with page.expect_download() as dl:
            page.locator('#export').click()
        download=dl.value; path=download.path()
        data=json.loads(Path(path).read_text(encoding='utf-8'))
        check(label+': export JSON complete',set(data['panels'])=={'A','B'} and 'realExtension' in data and len(data['panels']['A']['samples'])>0,{k:len(v['samples']) for k,v in data['panels'].items()})
        # Scroll controls and sync.
        page.locator('#scroll-A').evaluate("e=>e.scrollTop=180")
        page.wait_for_timeout(80)
        check(label+': synchronized scroll',page.locator('#scroll-B').evaluate('e=>e.scrollTop')>0,page.evaluate("()=>[document.getElementById('scroll-A').scrollTop,document.getElementById('scroll-B').scrollTop,document.getElementById('scroll-A').scrollHeight,document.getElementById('scroll-A').clientHeight]"))
        page.locator('#sync').uncheck()
        page.locator('#scroll-B').evaluate('e=>e.scrollTop=0')
        page.wait_for_timeout(80)
        check(label+': unsynchronized scroll stays independent',page.locator('#scroll-A').evaluate('e=>e.scrollTop')>0)
        # Check all rail controls remain reachable in their scroll container.
        reach=page.locator('#export').evaluate("e=>{e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return r.top>=0&&r.bottom<=innerHeight}")
        check(label+': rail controls reachable',reach)
        page.locator('#reset').click()
        page.locator('#theme').click()
        page.locator('#lazy').uncheck()
        page.locator('#replay').click(); page.wait_for_timeout(350)
        page.screenshot(path=str(OUT/f'placeholder_lab_{label}_mid.png'),full_page=True)
        page.wait_for_function("() => document.getElementById('state-A').textContent === '完成' && document.getElementById('state-B').textContent === '完成'",timeout=12000)
        page.wait_for_timeout(700)  # let the translation entrance fade settle before capture
        page.screenshot(path=str(OUT/f'placeholder_lab_{label}_final.png'),full_page=True)
        check(label+': no errors after repeated interactions',not errs,errs[:5])
        page.close()
    browser.close()
failed=[n for n,ok in results if not ok]
print(f'\n{len(results)-len(failed)}/{len(results)} passed')
if failed:
    print('FAILED:',failed); raise SystemExit(1)