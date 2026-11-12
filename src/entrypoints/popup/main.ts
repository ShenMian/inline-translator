import { browser } from 'wxt/browser';
import { loadSettings, saveSettings, type Settings } from '../../lib/settings';
import type { SiteRule } from '../../lib/rules';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let settings: Settings;
let tabId: number | undefined;
let host = '';
let active = false;

async function notifyContent(): Promise<void> {
  if (tabId == null) return;
  try {
    await browser.tabs.sendMessage(tabId, { type: 'settings-changed' });
  } catch {
    /* page not injected (chrome:// etc.) */
  }
}

function renderToggle(): void {
  const btn = $<HTMLButtonElement>('toggle');
  btn.textContent = active ? 'Restore original' : 'Translate page';
  btn.classList.toggle('on', active);
}

function renderForm(): void {
  $<HTMLSelectElement>('lang').value = settings.targetLang;
  $<HTMLSelectElement>('service').value = settings.service;
  $<HTMLSelectElement>('style').value = settings.style;
  $<HTMLInputElement>('oa-base').value = settings.openai.baseUrl;
  $<HTMLInputElement>('oa-key').value = settings.openai.apiKey;
  $<HTMLInputElement>('oa-model').value = settings.openai.model;
  $('openai-panel').hidden = settings.service !== 'openai';
  $<HTMLInputElement>('auto-site').checked = settings.autoSites[host] ?? false;
  $<HTMLInputElement>('auto-global').checked = settings.auto;
  $<HTMLInputElement>('floating').checked = settings.floating;
  $<HTMLTextAreaElement>('rules-text').value = settings.customRules.length
    ? JSON.stringify(settings.customRules, null, 2)
    : '';
}

// Serialize read-modify-write so a later write cannot clobber an earlier field
let patchQueue: Promise<void> = Promise.resolve();
function patch(p: Partial<Settings>): Promise<void> {
  patchQueue = patchQueue.then(async () => {
    settings = await saveSettings(p);
    await notifyContent();
  });
  return patchQueue;
}

async function init(): Promise<void> {
  settings = await loadSettings();
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  if (tab?.url) {
    try {
      host = new URL(tab.url).hostname;
    } catch {
      host = '';
    }
  }
  $('host').textContent = host || 'Current page';
  if (tabId != null) {
    try {
      const state = (await browser.tabs.sendMessage(tabId, { type: 'get-state' }, { frameId: 0 })) as { active: boolean };
      active = !!state?.active;
    } catch {
      active = false;
    }
  }
  renderToggle();
  renderForm();

  $<HTMLButtonElement>('toggle').addEventListener('click', async () => {
    if (tabId == null) return;
    try {
      const res = (await browser.tabs.sendMessage(tabId, { type: 'toggle' })) as { active: boolean };
      active = !!res?.active;
    } catch {
      active = !active;
    }
    renderToggle();
  });

  $<HTMLSelectElement>('lang').addEventListener('change', (e) => patch({ targetLang: (e.target as HTMLSelectElement).value }));
  $<HTMLSelectElement>('service').addEventListener('change', (e) => {
    const service = (e.target as HTMLSelectElement).value as Settings['service'];
    $('openai-panel').hidden = service !== 'openai';
    void patch({ service });
  });
  $<HTMLSelectElement>('style').addEventListener('change', (e) => patch({ style: (e.target as HTMLSelectElement).value as Settings['style'] }));

  const oaHandler = () =>
    patch({
      openai: {
        baseUrl: $<HTMLInputElement>('oa-base').value.trim(),
        apiKey: $<HTMLInputElement>('oa-key').value.trim(),
        model: $<HTMLInputElement>('oa-model').value.trim(),
      },
    });
  for (const id of ['oa-base', 'oa-key', 'oa-model']) {
    $<HTMLInputElement>(id).addEventListener('change', () => void oaHandler());
  }

  $<HTMLInputElement>('auto-site').addEventListener('change', (e) => {
    const on = (e.target as HTMLInputElement).checked;
    void patch({ autoSites: { ...settings.autoSites, [host]: on } });
  });
  $<HTMLInputElement>('auto-global').addEventListener('change', (e) => patch({ auto: (e.target as HTMLInputElement).checked }));
  $<HTMLInputElement>('floating').addEventListener('change', (e) => patch({ floating: (e.target as HTMLInputElement).checked }));

  $<HTMLButtonElement>('rules-save').addEventListener('click', async () => {
    const msg = $('rules-msg');
    const raw = $<HTMLTextAreaElement>('rules-text').value.trim();
    try {
      const parsed = raw ? (JSON.parse(raw) as SiteRule[]) : [];
      if (!Array.isArray(parsed) || parsed.some((r) => !Array.isArray(r?.matches))) {
        throw new Error('expected an array of rules, each with a matches array');
      }
      await patch({ customRules: parsed });
      msg.textContent = 'Saved';
      msg.classList.remove('err');
    } catch (e) {
      msg.textContent = `Invalid rules: ${e instanceof Error ? e.message : e}`;
      msg.classList.add('err');
    }
  });
}

void init();