/** Floating toggle at bottom right: Shadow DOM isolates styles from the host page. */
export function createFloatingButton(onToggle: () => void, getState: () => boolean): { host: HTMLElement; sync: () => void } {
  const host = document.createElement('div');
  host.setAttribute('data-ilt-ui', '');
  host.setAttribute('translate', 'no');
  host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
<style>
  :host{all:initial;}
  button{width:42px;height:42px;border-radius:50%;border:1px solid rgba(0,0,0,.08);background:#fff;color:#333;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 10px rgba(0,0,0,.18);transition:background .15s,color .15s,transform .1s;padding:0;}
  button:hover{transform:scale(1.06);}
  button.active{background:#2563eb;color:#fff;border-color:transparent;}
  svg{width:22px;height:22px;}
  @media (prefers-color-scheme: dark){button{background:#1f2937;color:#e5e7eb;border-color:rgba(255,255,255,.1);}}
</style>
<button title="Inline Translator: translate / restore (Alt+A)" aria-label="Translate this page">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 5h7M7.5 3v2c0 3.5-2 6.5-4.5 8"/>
    <path d="M5 8c0 2.5 2.5 5 6 6"/>
    <path d="M12.5 20l4-9 4 9M13.8 17h5.4"/>
  </svg>
</button>`;
  const btn = shadow.querySelector('button')!;
  const sync = () => btn.classList.toggle('active', getState());
  btn.addEventListener('click', () => {
    onToggle();
    sync();
  });
  document.body.appendChild(host);
  sync();
  return { host, sync };
}