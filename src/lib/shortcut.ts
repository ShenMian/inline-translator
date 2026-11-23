import { browser } from 'wxt/browser';

/** Manifest command that toggles translation from the keyboard. */
export const TOGGLE_COMMAND = 'toggle-translate';

/**
 * The accelerator the browser actually assigned to the toggle command, or '' when the suggestion
 * never bound (usually because another extension already owns it).
 */
export async function getToggleShortcut(): Promise<string> {
  try {
    const commands = await browser.commands.getAll();
    return commands.find((c) => c.name === TOGGLE_COMMAND)?.shortcut ?? '';
  } catch {
    return '';
  }
}

/** Chromium maps chrome:// to its own scheme; Firefox manages shortcuts from the add-ons page. */
export function shortcutsPageUrl(): string {
  return navigator.userAgent.includes('Firefox') ? 'about:addons' : 'chrome://extensions/shortcuts';
}

export async function openShortcutsPage(): Promise<void> {
  try {
    await browser.tabs.create({ url: shortcutsPageUrl() });
  } catch {
    /* browser refuses to open its own settings from an extension */
  }
}
