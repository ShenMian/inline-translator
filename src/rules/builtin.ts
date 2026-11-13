import type { SiteRule } from '../lib/rules';

/** Curated tweaks for high-traffic sites. The generic engine covers most sites; this only fixes edges. */
export const BUILTIN_RULES: SiteRule[] = [
  {
    matches: ['*://*.wikipedia.org/*', '*://*.wikimedia.org/*', '*://*.wiktionary.org/*'],
    ignore: ['.mw-editsection', '.reference', '.navbox', '.vertical-navbox', '.catlinks', '.mw-jump-link', '.sistersitebox', '.noprint'],
  },
  {
    matches: ['*://github.com/*', '*://*.github.com/*'],
    ignore: ['nav', '.Header', '.footer', '.blob-wrapper', '.highlight', '.js-blob-code', '.commit-tease', '.react-blob-print-hide', '[data-testid="code-cell"]', '.BorderGrid'],
    keep: ['a:has(code)', '.markdown-body code'],
  },
  {
    matches: ['*://news.ycombinator.com/*'],
    ignore: ['.sitebit', '.subtext'],
    inline: ['.pagetop', '.yclinks'],
  },
  {
    matches: ['*://x.com/*', '*://twitter.com/*', '*://mobile.x.com/*'],
    block: ['[data-testid="tweetText"]'],
    ignore: ['nav', '[data-testid="sidebarColumn"]', '[data-testid="SideNav_AccountSwitcher_Button"]', '[aria-label="Trending"]'],
  },
  {
    matches: ['*://*.reddit.com/*', '*://reddit.com/*'],
    ignore: ['nav', 'shreddit-sidebar', '[slot="credit-bar"]', '.comment-count'],
  },
  {
    matches: ['*://*.youtube.com/*', '*://youtube.com/*'],
    ignore: ['#masthead-container', '#actions', '#menu', '#sponsor-button', 'ytd-watch-metadata #top-row', '.ytp-caption-window-container', '#guide', '#chips'],
  },
  {
    matches: ['*://stackoverflow.com/*', '*://*.stackexchange.com/*', '*://serverfault.com/*', '*://superuser.com/*'],
    ignore: ['.s-btn', '.js-add-link', '.js-post-menu', '#sidebar', '.s-navigation', '.js-vote-count', '.relativetime'],
  },
  {
    matches: ['*://developer.mozilla.org/*'],
    ignore: ['mdn-user-menu', '.article-actions', '.metadata', 'pre', '.notecard'],
  },
  {
    matches: ['*://medium.com/*', '*://*.medium.com/*'],
    ignore: ['nav', 'footer', '.metabar', '.js-postShareWidget'],
  },
  {
    matches: ['*://*.substack.com/*'],
    ignore: ['nav', '.subscription-widget', '.pencraft.pc-display-flex', '.footer'],
  },
  {
    matches: ['*://arxiv.org/*'],
    ignore: ['.extra-services', '.submission-history', '.extra-ref-citation', '#abs-outer .extra-services'],
  },
  {
    matches: ['*://*.bbc.com/*', '*://*.bbc.co.uk/*', '*://*.cnn.com/*', '*://*.nytimes.com/*', '*://*.theguardian.com/*'],
    ignore: ['nav', 'footer', '[data-component="ad-slot"]', '.advert', '#site-header', '.css-1yzxwqi'],
  },
  {
    matches: ['*://*.notion.site/*', '*://*.notion.so/*'],
    ignore: ['.notion-topbar', '.notion-sidebar', '.notion-peek-renderer'],
  },
  {
    matches: ['*://discord.com/*'],
    ignore: ['nav', '[class*="sidebar"]', '[class*="guilds"]', '[aria-label="Servers"]'],
  },
  {
    matches: ['*://docs.python.org/*'],
    ignore: ['.sphinxsidebar', '.related', '.footer', '.headerlink', '.copybutton'],
  },
  {
    matches: ['*://dev.to/*', '*://*.forem.com/*'],
    ignore: ['nav', '.crayons-layout__left-sidebar', '.crayons-layout__right-sidebar'],
  },
  {
    matches: ['*://react.dev/*'],
    // Tailwind arbitrary-height utility truncates the taller translated line (verified against Immersive Translate)
    css: "[class*='h-[40px]']{height:unset !important;}",
  },
];