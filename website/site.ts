// The parts the pages share, put into the HTML when the site is built (website/vite.config.ts):
// header, footer, the install list, the screenshots and the privacy policy from PRIVACY.md.
// The pages are static: nothing here runs in the visitor's browser. Links in the shared parts start at
// the site's root, because the 404 page is served at any address.

import { readFileSync } from 'node:fs';
import { INSTALL } from './install.ts';
import { renderMarkdown } from './markdown.ts';
import { shotFile, shotWidths } from './shot-sizes.ts';

export const SITE_URL = 'https://ntfy-desk.minddevops.eu';
export const REPOSITORY_URL = 'https://github.com/valentindimitrov/ntfy-desk';
export const ISSUES_URL = `${REPOSITORY_URL}/issues`;

/**
 * No scripts, frames or connections; styles, fonts and images only from the site itself. The pages
 * carry it in a meta tag and the host sends it as a header (with frame-ancestors, which a meta tag
 * can't set).
 */
export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'";

/**
 * Cloudflare's _headers file: the policy above and the other security headers, long caching for fingerprinted
 * files, and noindex on the workers.dev addresses of pull request previews
 */
export const HEADERS_FILE = `/*
  Content-Security-Policy: ${CONTENT_SECURITY_POLICY}; frame-ancestors 'none'
  Strict-Transport-Security: max-age=31536000
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()

/assets/*
  Cache-Control: public, max-age=31536000, immutable

https://:version.:subdomain.workers.dev/*
  X-Robots-Tag: noindex
`;

const GITHUB_ICON = `<svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>`;

/**
 * Structured data for search engines, on the home page: the site's name, which results then show instead of
 * the domain. A JSON-LD data block, not a script: browsers never run it, so the policy above needs no change.
 */
export const STRUCTURED_DATA = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: 'ntfy Desk',
  url: `${SITE_URL}/`,
};

/** The extension's icon at 32 px (header) or 26 px (footer): the 32 px file, and 96 px for sharper screens */
const wordmark = (size: number) =>
  `<a class="wordmark" href="/"><img src="../public/icon/32.png" srcset="../public/icon/32.png 1x, ../public/icon/96.png 3x" width="${size}" height="${size}" alt="" />ntfy Desk</a>`;

/** The header's store buttons, in this order; an empty store address leads to the guide's manual install */
const STORE_BUTTONS = [
  { name: 'Vivaldi', icon: 'vivaldi', store: 'the Chrome Web Store', url: INSTALL.chromeWebStore },
  { name: 'Chrome', icon: 'chrome', store: 'the Chrome Web Store', url: INSTALL.chromeWebStore },
  { name: 'Edge', icon: 'edge', store: 'the Chrome Web Store', url: INSTALL.chromeWebStore },
  { name: 'Firefox', icon: 'firefox', store: 'Firefox Add-ons', url: INSTALL.firefoxAddons },
];

function storeButton({ name, icon, store, url }: (typeof STORE_BUTTONS)[number]): string {
  const target = url
    ? `href="${url}" target="_blank" rel="noreferrer" title="Get ntfy Desk from ${store}"`
    : `href="/setup-instructions#install" title="Coming soon to ${store}: until then, install a release build by hand"`;
  return `<a class="store-link" aria-label="${name}" ${target}><img src="./media/browsers/${icon}.svg" width="20" height="20" alt="" /><span class="store-name">${name}</span></a>`;
}

function header(page: string): string {
  const current = (name: string) => (page === name ? ' aria-current="page"' : '');
  return `<div class="header-shell">
  <header class="site-header wrap">
    ${wordmark(32)}
    <nav aria-label="Main navigation">
      <a class="nav-setup" href="/setup-instructions"${current('setup-instructions')}>Setup instructions</a>
      <div class="header-install">
        <div class="store-links" role="group" aria-label="Extension stores">
          ${STORE_BUTTONS.map(storeButton).join('\n          ')}
        </div>
        <a class="nav-github" href="${REPOSITORY_URL}" target="_blank" rel="noreferrer">${GITHUB_ICON}<span>GitHub</span></a>
      </div>
    </nav>
  </header>
</div>`;
}

const FOOTER = `<footer class="site-footer wrap">
  ${wordmark(26)}
  <p>
    A browser extension to send and receive <a href="https://ntfy.sh">ntfy</a> notifications.<br />
    ntfy Desk is an independent project and is not affiliated with ntfy.
  </p>
  <nav class="footer-links" aria-label="Project and legal">
    <a href="${ISSUES_URL}">Contact</a>
    <a href="/privacy-policy">Privacy policy</a>
    <a href="/LICENSE.txt">License &amp; attribution</a>
  </nav>
</footer>`;

/** A store with an address is a link; one without is "coming soon" */
function installTarget(browsers: string, store: string, url: string): string {
  const action = url ? `<a href="${url}">${store}</a>` : `<span class="soon">${store}: coming soon</span>`;
  return `<li><strong>${browsers}</strong>${action}</li>`;
}

function install(page: string): string {
  const notes = [
    // The guide itself explains it right below the list
    (INSTALL.chromeWebStore && INSTALL.firefoxAddons) || page === 'setup-instructions'
      ? ''
      : 'Until ntfy Desk is in the browser stores, you can load a release build by hand: see <a href="/setup-instructions#install">Install</a> in the guide.',
    INSTALL.repositoryPublic
      ? ''
      : 'The repository is not public yet: until it is, the GitHub links on this site only open for people with access to it.',
  ].filter(Boolean);
  return `<ul class="install-list">
  ${installTarget('Chrome, Edge, Vivaldi and other Chromium browsers', 'Chrome Web Store', INSTALL.chromeWebStore)}
  ${installTarget('Firefox 142 or later', 'Firefox Add-ons', INSTALL.firefoxAddons)}
  <li><strong>Extension ZIPs and source archives</strong><a href="${INSTALL.githubReleases}">GitHub Releases</a></li>
</ul>
${notes.map((note) => `<p class="install-note">${note}</p>`).join('\n')}`;
}

type Shots = Record<string, { width: number; height: number }>;

/**
 * How wide each kind of screenshot is shown, for the browser to pick a copy before the layout exists. It
 * follows website.css: .wrap is 1240 px at most, 96 px narrower than the window, 48 px up to 1100 px wide and
 * 32 px up to 520 px; a feature's picture takes 7 of 12 columns after a 64 px gap, the whole width up to 860 px.
 */
const SHOT_SIZES = {
  hero: '(max-width: 520px) calc(100vw - 32px), (max-width: 1100px) calc(100vw - 48px), min(1240px, calc(100vw - 96px))',
  feature:
    '(max-width: 520px) calc(100vw - 32px), (max-width: 860px) calc(100vw - 48px), (max-width: 1100px) calc((100vw - 112px) * 0.58), min(686px, calc((100vw - 160px) * 0.58))',
  narrow: '(max-width: 520px) calc(100vw - 32px), 410px',
  guide: '(max-width: 520px) calc(100vw - 32px), min(840px, calc(100vw - 48px))',
};

/** Where a screenshot sits: the home page's first picture, its narrow Send form, the guide's column, or a feature */
function shotPlace(page: string, name: string): keyof typeof SHOT_SIZES {
  if (page === 'setup-instructions') return 'guide';
  return name === 'overview' ? 'hero' : name === 'send' ? 'narrow' : 'feature';
}

/** <img data-shot="name" alt="…" /> becomes the light and dark screenshot, in every size, with its size */
function screenshots(html: string, shots: Shots, page: string): string {
  return html.replaceAll(/<img\s+data-shot="([^"]+)"\s+alt="([^"]*)"\s*\/?>/g, (_tag, name: string, alt: string) => {
    const size = shots[name];
    if (!size) throw new Error(`No screenshot named ${name} in website/media/shots.json`);
    const srcset = (scheme: 'light' | 'dark') =>
      shotWidths(size.width)
        .map((width) => `./media/${shotFile(name, scheme, width, size.width)} ${width}w`)
        .join(', ');
    const sizes = SHOT_SIZES[shotPlace(page, name)];
    // The first image of a page is in view at once; the others load when they come near
    const loading = name === 'overview' ? 'fetchpriority="high"' : 'loading="lazy" decoding="async"';
    return `<picture>
  <source srcset="${srcset('dark')}" sizes="${sizes}" media="(prefers-color-scheme: dark)" />
  <img src="./media/${name}-light.webp" srcset="${srcset('light')}" sizes="${sizes}" width="${size.width}" height="${size.height}" alt="${alt}" ${loading} />
</picture>`;
  });
}

/**
 * The text fonts, requested with the page instead of after the stylesheet: text drawn in the fallback font
 * first and in Roboto a moment later moved the content below it (Lighthouse counted it as layout shift)
 */
const FONT_PRELOADS = ['400', '500', '600']
  .map((weight) => `<link rel="preload" href="../public/fonts/roboto-${weight}.woff2" as="font" type="font/woff2" crossorigin />`)
  .join('\n    ');

/** One page's source HTML with the shared parts filled in. `page` is its file name without .html */
export function renderPage(html: string, page: string, root: string, production: boolean): string {
  const shots = JSON.parse(readFileSync(`${root}/media/shots.json`, 'utf8')) as Shots;
  let output = html
    .replace('<!-- site:header -->', () => header(page))
    .replace('<!-- site:footer -->', () => FOOTER)
    .replace('<!-- site:install -->', () => install(page))
    .replace('<!-- site:structured-data -->', () => `<script type="application/ld+json">${JSON.stringify(STRUCTURED_DATA)}</script>`)
    .replace('<!-- site:privacy -->', () => renderMarkdown(readFileSync(`${root}/../PRIVACY.md`, 'utf8')));
  output = screenshots(output, shots, page);
  // Before the stylesheet, which would otherwise be the first to ask for the fonts
  if (!/<link rel="stylesheet"/.test(output)) throw new Error(`${page}.html has no stylesheet link`);
  output = output.replace(/<link rel="stylesheet"/, (link) => `${FONT_PRELOADS}\n    ${link}`);
  if (/<!-- site:|data-shot=/.test(output)) throw new Error(`${page}.html: a placeholder was not filled in`);
  // Not in the dev server, whose hot reload needs scripts and a connection
  if (production) {
    output = output.replace(
      '<meta charset="UTF-8" />',
      () => `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`,
    );
  }
  return output;
}
