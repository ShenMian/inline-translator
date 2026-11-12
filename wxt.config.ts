import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  manifestVersion: 3,
  manifest: ({ browser }) => ({
    name: 'Inline Translator',
    description: 'A lean inline web page translator',
    icons: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' },
    permissions: ['storage', 'contextMenus'],
    host_permissions: ['<all_urls>'],
    ...(browser === 'firefox' && {
      browser_specific_settings: {
        gecko: {
          id: 'inline-translator@translator',
          // Translation sends page text to the selected service; declare websiteContent truthfully
          data_collection_permissions: { required: ['websiteContent'] },
        },
      },
    }),
    commands: {
      'toggle-translate': {
        suggested_key: { default: 'Alt+A' },
        description: 'Translate / restore current page',
      },
    },
  }),
});