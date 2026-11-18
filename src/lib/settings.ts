import { storage } from 'wxt/utils/storage';
import type { SiteRule } from './rules';

export type ServiceId = 'google' | 'edge' | 'openai';

/** Translation themes offered in the popup. */
export const STYLE_IDS = [
  'none', 'underline', 'dashed', 'dotted', 'wavy',
  'highlight', 'blockquote', 'solidBorder', 'paper', 'background',
  'dividingLine', 'weakening', 'grey', 'italic', 'bold', 'mask', 'opacity',
] as const;
export type StyleId = (typeof STYLE_IDS)[number];

/** In-flight placeholder shown at the translation's future spot. */
export type PendingStyle = 'ring' | 'skeleton';

export interface Settings {
  targetLang: string;
  service: ServiceId;
  /** Auto-translate new sites by default */
  auto: boolean;
  /** Per-host auto-translate switch (takes precedence over auto) */
  autoSites: Record<string, boolean>;
  openai: { baseUrl: string; apiKey: string; model: string };
  style: StyleId;
  pending: PendingStyle;
  /** Floating button visibility */
  floating: boolean;
  customRules: SiteRule[];
}

export const DEFAULT_SETTINGS: Settings = {
  targetLang: 'zh-CN',
  service: 'google',
  auto: false,
  autoSites: {},
  openai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
  style: 'none',
  pending: 'ring',
  floating: true,
  customRules: [],
};

export const settingsItem = storage.defineItem<Settings>('local:settings', {
  fallback: DEFAULT_SETTINGS,
});

export async function loadSettings(): Promise<Settings> {
  const s = await settingsItem.getValue();
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    openai: { ...DEFAULT_SETTINGS.openai, ...s.openai },
    autoSites: { ...s.autoSites },
    customRules: Array.isArray(s.customRules) ? s.customRules : [],
  };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const cur = await loadSettings();
  const next = { ...cur, ...patch, openai: { ...cur.openai, ...patch.openai } };
  await settingsItem.setValue(next);
  return next;
}