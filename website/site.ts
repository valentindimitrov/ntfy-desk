// The parts the pages share, put into the HTML when the site is built (website/vite.config.ts):
// header, footer, the install list, the screenshots and the privacy policy from PRIVACY.md.
// The pages are static: nothing here runs in the visitor's browser. Links in the shared parts start at
// the site's root, because the 404 page is served at any address.

import { readFileSync } from 'node:fs';
import { INSTALL } from './install.ts';
import { renderMarkdown } from './markdown.ts';

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

const wordmark = (size: number) =>
  `<a class="wordmark" href="/"><img src="../public/icon/128.png" width="${size}" height="${size}" alt="" />ntfy Desk</a>`;

function header(page: string): string {
  const current = (name: string) => (page === name ? ' aria-current="page"' : '');
  return `<div class="header-shell">
  <header class="site-header wrap">
    ${wordmark(32)}
    <nav aria-label="Main navigation">
      <a class="nav-link nav-features" href="/#features">Features</a>
      <a class="nav-link" href="/getting-started"${current('getting-started')}>Getting started</a>
      <a class="nav-button" href="${REPOSITORY_URL}">${GITHUB_ICON}<span>GitHub</span></a>
    </nav>
  </header>
</div>`;
}

const FOOTER = `<footer class="site-footer wrap">
  ${wordmark(26)}
  <p>
    A browser extension to send and receive <a href="https://ntfy.sh">ntfy</a> notifications. ntfy Desk is an
    independent project and is not affiliated with ntfy.
  </p>
  <nav class="footer-links" aria-label="Project and legal">
    <a href="${REPOSITORY_URL}">GitHub</a>
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
    (INSTALL.chromeWebStore && INSTALL.firefoxAddons) || page === 'getting-started'
      ? ''
      : 'Until ntfy Desk is in the browser stores, you can load a release build by hand: see <a href="/getting-started#install">Install</a> in the guide.',
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

/** <img data-shot="name" alt="…" /> becomes the light and dark screenshot with its size */
function screenshots(html: string, shots: Shots): string {
  return html.replaceAll(/<img\s+data-shot="([^"]+)"\s+alt="([^"]*)"\s*\/?>/g, (_tag, name: string, alt: string) => {
    const size = shots[name];
    if (!size) throw new Error(`No screenshot named ${name} in website/media/shots.json`);
    // The first image of a page is in view at once; the others load when they come near
    const loading = name === 'overview' ? 'fetchpriority="high"' : 'loading="lazy" decoding="async"';
    return `<picture>
  <source srcset="./media/${name}-dark.webp" media="(prefers-color-scheme: dark)" />
  <img src="./media/${name}-light.webp" width="${size.width}" height="${size.height}" alt="${alt}" ${loading} />
</picture>`;
  });
}

/** One page's source HTML with the shared parts filled in. `page` is its file name without .html */
export function renderPage(html: string, page: string, root: string, production: boolean): string {
  const shots = JSON.parse(readFileSync(`${root}/media/shots.json`, 'utf8')) as Shots;
  let output = html
    .replace('<!-- site:header -->', () => header(page))
    .replace('<!-- site:footer -->', () => FOOTER)
    .replace('<!-- site:install -->', () => install(page))
    .replace('<!-- site:privacy -->', () => renderMarkdown(readFileSync(`${root}/../PRIVACY.md`, 'utf8')));
  output = screenshots(output, shots);
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
