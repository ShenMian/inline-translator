import type { EngineStatus } from '../core/engine';

/** Floating toggle at bottom right: Shadow DOM isolates styles from the host page.
 *  A spinner ring marks translation in progress; a separate retry pill appears when units fail. */
export function createFloatingButton(
  onToggle: () => void,
  onRetry: () => void,
  getStatus: () => EngineStatus,
): { host: HTMLElement; sync: () => void } {
  const host = document.createElement('div');
  host.setAttribute('data-ilt-ui', '');
  host.setAttribute('translate', 'no');
  host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
<style>
  :host{all:initial;}
  .wrap{display:flex;flex-direction:column;align-items:center;gap:8px;}
  button{border:1px solid rgba(0,0,0,.08);background:#fff;color:#333;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 10px rgba(0,0,0,.18);transition:background .15s,color .15s,transform .1s;padding:0;font:inherit;}
  .main{position:relative;width:42px;height:42px;border-radius:50%;}
  .main:hover{transform:scale(1.06);}
  .main.active{background:#2563eb;color:#fff;border-color:transparent;}
  .main.error{background:#dc2626;color:#fff;border-color:transparent;}
  .main svg{width:22px;height:22px;}
  .main.busy::after{content:'';position:absolute;inset:-5px;border-radius:50%;border:2px solid transparent;border-top-color:#2563eb;animation:ilt-spin .8s linear infinite;pointer-events:none;}
  .main.active.busy::after{border-top-color:#fff;}
  @keyframes ilt-spin{to{transform:rotate(360deg);}}
  .retry{display:none;height:28px;border-radius:14px;padding:0 10px;gap:5px;background:#dc2626;color:#fff;border-color:transparent;font-size:12px;font-weight:600;}
  .retry.show{display:flex;}
  .retry:hover{filter:brightness(1.08);}
  .retry svg{width:14px;height:14px;}
  @media (prefers-color-scheme: dark){button{background:#1f2937;color:#e5e7eb;border-color:rgba(255,255,255,.1);}.retry{background:#dc2626;color:#fff;}}
</style>
<div class="wrap">
  <button class="retry" title="Retry failed translations" aria-label="Retry failed translations">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
    <span class="count"></span>
  </button>
  <button class="main" title="Inline Translator: translate / restore (Alt+A)" aria-label="Translate this page">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <!-- 文: dot + bar on top, crossing 撇/捺 below; a vertical through the bar reads as 丈 -->
      <path d="M4 5.5h7.5M7.75 3v2.5"/>
      <path d="M10 5.5c-.2 2.2-1.6 4.6-6.5 8.5"/>
      <path d="M4.5 8c1.7 2.7 4.3 5 7 6.5"/>
      <path d="M12.5 20l4-9 4 9M13.8 17h5.4"/>
    </svg>
  </button>
</div>`;
  const main = shadow.querySelector('.main') as HTMLButtonElement;
  const retry = shadow.querySelector('.retry') as HTMLButtonElement;
  const count = shadow.querySelector('.count') as HTMLSpanElement;
  const sync = () => {
    const s = getStatus();
    main.classList.toggle('active', s.active);
    main.classList.toggle('busy', s.active && s.busy);
    retry.classList.toggle('show', s.active && s.failed > 0 && s.errorRetryable);
    count.textContent = String(s.failed);
    retry.title = s.error ? `Retry ${s.failed} failed — ${s.error}` : `Retry ${s.failed} failed translations`;
    // Config-type failure (e.g. bad API key): flag the main button instead of offering a futile retry
    const configErr = s.active && s.failed > 0 && !s.errorRetryable;
    main.classList.toggle('error', configErr);
    main.title = configErr
      ? `Translation failed — check service settings${s.error ? `: ${s.error}` : ''}`
      : 'Inline Translator: translate / restore (Alt+A)';
  };
  main.addEventListener('click', () => {
    onToggle();
    sync();
  });
  retry.addEventListener('click', () => {
    onRetry();
    sync();
  });
  document.body.appendChild(host);
  sync();
  return { host, sync };
}