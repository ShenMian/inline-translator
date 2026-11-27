import './style.css';
import { browser } from 'wxt/browser';
import { STYLE_IDS, loadSettings, saveSettings, type PendingStyle, type Settings, type StyleId } from '../../lib/settings';
import { measureLines, renderPendingSkeleton, styleCss } from '../../core/render';
import { openShortcutsPage, getToggleShortcut } from '../../lib/shortcut';
import type { Paragraph } from '../../core/types';
import type { EngineStatus } from '../../core/engine';
import type { SiteRule } from '../../lib/rules';
import { requestToggle } from '../../lib/messaging';
import { createErrorNotice, errorMessage } from '../../ui/error-notice';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const STYLE_LABELS: Record<StyleId, string> = {
  none: 'None',
  underline: 'Straight line',
  dashed: 'Dashed lines',
  dotted: 'Dotted lines',
  wavy: 'Wavy lines',
  highlight: 'Highlight',
  blockquote: 'Quote style',
  solidBorder: 'Solid border',
  paper: 'Paper shadow',
  background: 'Background',
  dividingLine: 'Dividing line',
  mask: 'Blur',
  opacity: 'Transparency',
  weakening: 'Weaken',
  grey: 'Black gray',
  italic: 'Italic',
  bold: 'Bold',
};

let settings: Settings;
let tabId: number | undefined;
let host = '';
let active = false;
let failed = 0;
let lastError = '';
let errorRetryable = true;
let pageError = '';

const errorNotice = createErrorNotice(document, () => void retryFailed());
$('error-mount').append(errorNotice.root);

async function notifyContent(): Promise<void> {
  if (tabId == null) return;
  let result: { ok?: boolean; error?: string } | undefined;
  try {
    result = (await browser.tabs.sendMessage(tabId, { type: 'settings-changed' })) as {
      ok?: boolean;
      error?: string;
    };
  } catch {
    return;
  }
  if (result?.ok === false) throw new Error(result.error || 'The page could not apply the settings.');
}

function renderToggle(): void {
  const btn = $<HTMLButtonElement>('toggle');
  btn.textContent = active ? 'Restore original' : 'Translate page';
  btn.classList.toggle('btn-primary', !active);
  btn.classList.toggle('btn-neutral', active);
}

function renderError(): void {
  const translationError = failed > 0 ? `${failed} failed — ${lastError || 'check service settings'}` : '';
  errorNotice.render(
    pageError
      ? { message: pageError }
      : translationError
        ? { message: translationError, retryable: errorRetryable }
        : null,
  );
}

async function refreshState(): Promise<void> {
  pageError = '';
  if (tabId != null) {
    try {
      const s = (await browser.tabs.sendMessage(tabId, { type: 'get-state' }, { frameId: 0 })) as EngineStatus;
      if (!s || typeof s.active !== 'boolean') throw new Error('Invalid page state');
      active = s.active;
      failed = s.failed;
      lastError = s.error;
      errorRetryable = s.errorRetryable;
    } catch {
      active = false;
      failed = 0;
      lastError = '';
      errorRetryable = true;
      pageError = 'Inline Translator is not available on this page. Try a regular web page.';
    }
  }
  renderToggle();
  renderError();
}

async function performPageAction(action: () => Promise<unknown>, fallback: string): Promise<void> {
  let actionError = '';
  try {
    await action();
  } catch (error) {
    actionError = errorMessage(error) || fallback;
  }
  await refreshState();
  if (actionError) {
    pageError = actionError;
    renderError();
  }
}

async function retryFailed(): Promise<void> {
  const id = tabId;
  if (id == null) {
    pageError = 'No active tab to translate.';
    renderError();
    return;
  }
  await performPageAction(
    () => browser.tabs.sendMessage(id, { type: 'retry' }),
    'Could not retry translations. Reload the page and try again.',
  );
}

async function renderShortcut(): Promise<void> {
  const shortcut = await getToggleShortcut();
  $('shortcut').textContent = shortcut;
  $('shortcut-label').hidden = !shortcut;
  $('shortcut-row').hidden = !!shortcut;
  $<HTMLButtonElement>('shortcut-fix').addEventListener('click', () => {
    void openShortcutsPage();
    window.close();
  });
}

// Live preview reuses the exact CSS injected into pages, so what you see is what you get
let previewSheet: HTMLStyleElement | null = null;
function renderStylePreview(style: StyleId): void {
  if (!previewSheet) {
    previewSheet = document.createElement('style');
    document.head.append(previewSheet);
  }
  previewSheet.textContent = styleCss(style);
}

// The indicator preview runs the same renderer as the page, sized to the preview's own line boxes
function renderPendingPreview(mode: PendingStyle): void {
  const box = $('pending-preview');
  box.querySelector('.ilt-p, .ilt-p-sk')?.remove();
  $('pending-hint').textContent =
    mode === 'ring'
      ? 'A quiet ring marks each paragraph in flight; the page grows once, when translations land.'
      : "The skeleton reserves the original's line sizes; translations of a different length settle twice.";
  const src = $('pending-src');
  const txt = src.firstChild!;
  if (mode === 'ring') {
    const el = document.createElement('font');
    el.className = 'ilt-p';
    src.append(el);
    return;
  }
  const lines = measureLines([txt], txt);
  const fake = { root: src, nodes: [txt], anchor: txt, text: src.textContent ?? '' } as unknown as Paragraph;
  renderPendingSkeleton(fake, lines);
}

function renderForm(): void {
  $<HTMLSelectElement>('lang').value = settings.targetLang;
  $<HTMLSelectElement>('service').value = settings.service;
  $<HTMLSelectElement>('style').value = settings.style;
  renderStylePreview(settings.style);
  $<HTMLSelectElement>('pending').value = settings.pending;
  renderPendingPreview(settings.pending);
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
  const run = patchQueue.then(async () => {
    settings = await saveSettings(p);
    await notifyContent();
  });
  patchQueue = run.catch(() => {});
  return run;
}

function updateSettings(p: Partial<Settings>): void {
  void patch(p).catch((error) => {
    pageError = `Could not save settings: ${errorMessage(error)}`;
    renderError();
  });
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
  // The header is gone; the per-site switch label carries the current host instead
  $('auto-site-label').textContent = host ? `Auto-translate ${host}` : 'Auto-translate this site';
  $('auto-site-label').title = host;
  const styleSel = $<HTMLSelectElement>('style');
  let hoverGroup: HTMLOptGroupElement | null = null;
  for (const id of STYLE_IDS) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = STYLE_LABELS[id];
    // Blur/transparency only show the translation on hover; group them under a plain-text
    // header so the behavior is stated at the option without restyling the native select.
    if (id === 'mask' || id === 'opacity') {
      if (!hoverGroup) {
        hoverGroup = document.createElement('optgroup');
        hoverGroup.label = 'Hover to reveal';
        styleSel.append(hoverGroup);
      }
      hoverGroup.append(opt);
    } else {
      styleSel.append(opt);
    }
  }
  await refreshState();
  renderForm();
  await renderShortcut();

  $<HTMLButtonElement>('toggle').addEventListener('click', async () => {
    if (tabId == null) {
      pageError = 'No active tab to translate.';
      renderError();
      return;
    }
    const id = tabId;
    await performPageAction(async () => {
      const result = await requestToggle(id);
      if (!result.ok) throw new Error(result.error);
    }, 'Could not contact Inline Translator. Reload the extension and try again.');
  });

  $<HTMLSelectElement>('lang').addEventListener('change', (e) => updateSettings({ targetLang: (e.target as HTMLSelectElement).value }));
  $<HTMLSelectElement>('service').addEventListener('change', (e) => {
    const service = (e.target as HTMLSelectElement).value as Settings['service'];
    $('openai-panel').hidden = service !== 'openai';
    updateSettings({ service });
  });
  styleSel.addEventListener('change', (e) => {
    const style = (e.target as HTMLSelectElement).value as StyleId;
    renderStylePreview(style);
    updateSettings({ style });
  });
  $<HTMLSelectElement>('pending').addEventListener('change', (e) => {
    const pending = (e.target as HTMLSelectElement).value as PendingStyle;
    renderPendingPreview(pending);
    updateSettings({ pending });
  });

  const oaHandler = () =>
    updateSettings({
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
    updateSettings({ autoSites: { ...settings.autoSites, [host]: on } });
  });
  $<HTMLInputElement>('auto-global').addEventListener('change', (e) => updateSettings({ auto: (e.target as HTMLInputElement).checked }));
  $<HTMLInputElement>('floating').addEventListener('change', (e) => updateSettings({ floating: (e.target as HTMLInputElement).checked }));

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
      msg.classList.remove('text-error');
      msg.classList.add('text-success');
    } catch (e) {
      msg.textContent = `Rules not saved: ${errorMessage(e)}`;
      msg.classList.remove('text-success');
      msg.classList.add('text-error');
    }
  });
}

void init().catch((error) => {
  pageError = `Could not open Inline Translator: ${errorMessage(error)}`;
  renderError();
});