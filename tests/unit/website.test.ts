// The public website (website/): built here as pnpm website:build does, then the output is checked.
// It loads nothing from other sites, its pages and files all exist, images are described and sized,
// the privacy policy page says what PRIVACY.md says, and what search engines read is there: descriptions,
// canonical addresses, the sitemap, structured data and security.txt.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Window, type Document } from 'happy-dom';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INSTALL } from '@/website/install';
import { renderMarkdown } from '@/website/markdown';
import { CONTENT_SECURITY_POLICY, SITE_URL, STRUCTURED_DATA } from '@/website/site';

const PAGES = [
  { file: 'index.html', route: '/' },
  { file: 'getting-started.html', route: '/getting-started' },
  { file: 'privacy-policy.html', route: '/privacy-policy' },
  { file: '404.html', route: undefined },
];
/** Attributes that make a browser fetch something (links a visitor follows are not among them) */
const LOADING = ['src', 'srcset', 'poster', 'data', 'action', 'background', 'ping', 'manifest'];

let output: string;
const documents = new Map<string, Document>();
const sources = new Map<string, string>();

const page = (file: string) => documents.get(file)!;
const text = (value: string | null | undefined) => (value ?? '').replaceAll(/\s+/g, ' ').trim();
/** A site path as a file of the build, the way the host resolves it (/page is page.html) */
const builtFile = (path: string) => [path, `${path}.html`, join(path, 'index.html')].map((candidate) => join(output, candidate));

beforeAll(async () => {
  output = mkdtempSync(join(tmpdir(), 'ntfy-desk-website-'));
  await build({ configFile: resolve('website/vite.config.ts'), logLevel: 'silent', build: { outDir: output, emptyOutDir: true } });
  for (const { file } of PAGES) {
    const html = readFileSync(join(output, file), 'utf8');
    sources.set(file, html);
    const window = new Window({ url: `${SITE_URL}/${file}` });
    window.document.write(html);
    documents.set(file, window.document as unknown as Document);
  }
}, 60_000);

afterAll(() => rmSync(output, { recursive: true, force: true }));

describe.each(PAGES)('website page $file', ({ file, route }) => {
  it('loads nothing from another site', () => {
    const document = page(file);
    // The home page's JSON-LD is data that no browser runs; any other script is refused
    expect(
      document.querySelectorAll('script:not([type="application/ld+json"]), iframe, object, embed, video, audio, form, style, [style]'),
    ).toHaveLength(0);
    expect(document.querySelectorAll('script')).toHaveLength(file === 'index.html' ? 1 : 0);
    const loaded = [...document.querySelectorAll('*')].flatMap((element) => [
      ...LOADING.map((name) => element.getAttribute(name)),
      // A stylesheet or icon is fetched; a canonical link is only an address
      element.tagName === 'LINK' && element.getAttribute('rel') !== 'canonical' ? element.getAttribute('href') : null,
    ]);
    const urls = loaded.filter((value) => value !== null).flatMap((value) => value.split(',').map((part) => part.trim().split(/\s+/)[0]!));
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url, `${file} loads ${url}`).toMatch(/^\/(?!\/)/);
      expect(existsSync(join(output, url)), `${file}: ${url} is missing from the build`).toBe(true);
    }
    expect(document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toBe(CONTENT_SECURITY_POLICY);
  });

  it('has no external address in its stylesheet', () => {
    const href = page(file).querySelector('link[rel="stylesheet"]')!.getAttribute('href')!;
    const css = readFileSync(join(output, href), 'utf8');
    const urls = [...css.matchAll(/url\(\s*['"]?([^'")]+)/g)].map((match) => match[1]!);
    expect(css).not.toMatch(/@import/);
    for (const url of urls) {
      expect(url).toMatch(/^\/(?!\/)/);
      expect(existsSync(join(output, url)), `${url} is missing from the build`).toBe(true);
    }
    expect(urls.some((url) => url.endsWith('.woff2'))).toBe(true);
  });

  it('describes and sizes every image', () => {
    const images = [...page(file).querySelectorAll('img')];
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      const src = image.getAttribute('src');
      expect(image.hasAttribute('alt'), `${src} has no alt`).toBe(true);
      expect(Number(image.getAttribute('width')), `${src} has no width`).toBeGreaterThan(0);
      expect(Number(image.getAttribute('height')), `${src} has no height`).toBeGreaterThan(0);
      // Only the logo next to the site's name is decorative
      if (!image.closest('.wordmark')) expect(image.getAttribute('alt')!.length, `${src} needs a description`).toBeGreaterThan(40);
    }
    // Every screenshot has a dark version of the same size next to it
    for (const picture of page(file).querySelectorAll('picture')) {
      expect(picture.querySelector('source')?.getAttribute('media')).toBe('(prefers-color-scheme: dark)');
    }
  });

  it('links only to pages and anchors that exist, or to the intended sites', () => {
    const allowed = ['https://github.com/valentindimitrov/ntfy-desk', 'https://ntfy.sh', 'https://docs.ntfy.sh/'];
    for (const link of page(file).querySelectorAll('a[href]')) {
      const href = link.getAttribute('href')!;
      const url = new URL(href, `${SITE_URL}${route ?? '/404'}`);
      if (url.origin !== SITE_URL) {
        expect(
          allowed.some((prefix) => href.startsWith(prefix)),
          `${file} links to ${href}`,
        ).toBe(true);
        continue;
      }
      const target = builtFile(url.pathname).find((candidate) => existsSync(candidate) && !candidate.endsWith('/'));
      expect(target, `${file}: ${href} leads nowhere`).toBeDefined();
      if (url.hash) {
        const targetPage = PAGES.find(({ file: name }) => target!.endsWith(`/${name}`))!;
        expect(page(targetPage.file).getElementById(url.hash.slice(1)), `${file}: no ${href}`).not.toBeNull();
      }
    }
  });

  it('has one main heading, landmarks and the preview tags', () => {
    const document = page(file);
    expect(document.querySelectorAll('h1')).toHaveLength(1);
    expect(document.querySelectorAll('header')).toHaveLength(1);
    expect(document.querySelectorAll('main')).toHaveLength(1);
    expect(document.querySelectorAll('footer')).toHaveLength(1);
    expect(document.documentElement.getAttribute('lang')).toBe('en');
    expect(text(document.querySelector('footer')?.textContent)).toContain('not affiliated with ntfy');
    expect(sources.get(file)).not.toMatch(/<!-- site:|data-shot=/);
    const meta = (selector: string) => document.querySelector(selector)?.getAttribute('content');
    // What a search result shows under the title: long enough to say something, short enough not to be cut
    expect(meta('meta[name="description"]')?.length).toBeGreaterThanOrEqual(50);
    expect(meta('meta[name="description"]')?.length).toBeLessThanOrEqual(160);
    if (!route) {
      expect(meta('meta[name="robots"]')).toBe('noindex');
      return;
    }
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(SITE_URL + route);
    expect(meta('meta[property="og:url"]')).toBe(SITE_URL + route);
    expect(meta('meta[property="og:title"]')).toBe(document.title);
    expect(meta('meta[property="og:description"]')).toBe(meta('meta[name="description"]'));
    expect(meta('meta[property="og:image"]')).toBe(`${SITE_URL}/social-card.png`);
    expect(readFileSync(resolve('website/public/sitemap.xml'), 'utf8')).toContain(`<loc>${SITE_URL}${route}</loc>`);
  });
});

describe('website', () => {
  it('shows the privacy policy as PRIVACY.md has it', () => {
    const markdown = readFileSync(resolve('PRIVACY.md'), 'utf8');
    // The file's text without its Markdown marks: headings, list items, bold, and links as their text
    const expected = markdown
      .replaceAll(/^#+ /gm, '')
      .replaceAll(/^- /gm, '')
      .replaceAll('**', '')
      .replaceAll(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    const article = page('privacy-policy.html').querySelector('main article')!;
    expect(text(article.textContent)).toBe(text(expected));
    const links = [...markdown.matchAll(/\]\((https:[^)]+)\)/g)].map((match) => match[1]);
    expect([...article.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual(links);
    expect(article.querySelectorAll('h2')).toHaveLength(markdown.match(/^## /gm)!.length);
    expect(article.querySelectorAll('li')).toHaveLength(markdown.match(/^- /gm)!.length);
  });

  it('refuses Markdown the privacy page cannot show', () => {
    expect(renderMarkdown('# Title\n\nText with **bold** and a [link](https://example.com/a).')).toBe(
      '<h1>Title</h1>\n<p>Text with <strong>bold</strong> and a <a href="https://example.com/a">link</a>.</p>',
    );
    expect(renderMarkdown('A <b> & "quote"')).toBe('<p>A &lt;b&gt; &amp; &quot;quote&quot;</p>');
    for (const unsupported of [
      'Some `code`',
      '> quote',
      '1. step',
      '### Deep',
      '| a | b |',
      'An *emphasis*',
      '[link](http://plain.example)',
    ]) {
      expect(() => renderMarkdown(unsupported), unsupported).toThrow(/Unsupported Markdown/);
    }
  });

  it('says "coming soon" for a store without an address and links the others', () => {
    const list = page('getting-started.html').querySelector('.install-list')!;
    const stores = [
      ['Chrome Web Store', INSTALL.chromeWebStore],
      ['Firefox Add-ons', INSTALL.firefoxAddons],
    ] as const;
    for (const [name, url] of stores) {
      if (url) expect(list.querySelector(`a[href="${url}"]`)).not.toBeNull();
      else expect(text(list.textContent)).toContain(`${name}: coming soon`);
    }
    expect(list.querySelector(`a[href="${INSTALL.githubReleases}"]`)).not.toBeNull();
    // No store address anywhere while none is configured
    const stored = [...sources.values()].join('\n');
    if (!INSTALL.chromeWebStore) expect(stored).not.toContain('chromewebstore.google.com');
    if (!INSTALL.firefoxAddons) expect(stored).not.toContain('addons.mozilla.org');
  });

  it("tells search engines the site's name on the home page", () => {
    const blocks = [...page('index.html').querySelectorAll('script[type="application/ld+json"]')];
    expect(blocks).toHaveLength(1);
    expect(JSON.parse(blocks[0]!.textContent!)).toEqual(STRUCTURED_DATA);
    expect(STRUCTURED_DATA).toEqual({ '@context': 'https://schema.org', '@type': 'WebSite', name: 'ntfy Desk', url: `${SITE_URL}/` });
  });

  it('lists exactly the public pages in the sitemap', () => {
    const sitemap = readFileSync(join(output, 'sitemap.xml'), 'utf8');
    const listed = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    const routes = PAGES.flatMap(({ route }) => (route ? [SITE_URL + route] : []));
    expect(new Set(listed)).toEqual(new Set(routes));
    expect(listed).toHaveLength(routes.length);
    expect(readFileSync(join(output, 'robots.txt'), 'utf8')).toContain(`Sitemap: ${SITE_URL}/sitemap.xml`);
  });

  it('publishes a security.txt that has not expired', () => {
    const security = readFileSync(join(output, '.well-known', 'security.txt'), 'utf8');
    expect(security).toMatch(/^Contact: https:\/\/github\.com\/valentindimitrov\/ntfy-desk\/security\/advisories\/new$/m);
    expect(security).toContain(`Canonical: ${SITE_URL}/.well-known/security.txt`);
    expect(security).toMatch(/^Policy: https:\/\/github\.com\/valentindimitrov\/ntfy-desk\/blob\/main\/SECURITY\.md$/m);
    expect(existsSync(resolve('SECURITY.md'))).toBe(true);
    // Renew it before this fails: website/README.md, "security.txt"
    const expires = Date.parse(/^Expires: (\S+)$/m.exec(security)?.[1] ?? '');
    expect(expires, 'security.txt has expired: set a new Expires date, at most a year ahead').toBeGreaterThan(Date.now());
    expect(expires - Date.now()).toBeLessThan(366 * 24 * 60 * 60 * 1000);
    expect(readFileSync(join(output, '_redirects'), 'utf8')).toContain('/security.txt /.well-known/security.txt 301');
  });

  it('ships the licences, the security headers and the social card', () => {
    const license = readFileSync(join(output, 'LICENSE.txt'), 'utf8');
    for (const part of ['LICENSE', 'NOTICE.md', 'public/fonts/LICENSE.txt']) expect(license).toContain(readFileSync(resolve(part), 'utf8'));
    const headers = readFileSync(join(output, '_headers'), 'utf8');
    expect(headers).toContain(`Content-Security-Policy: ${CONTENT_SECURITY_POLICY}; frame-ancestors 'none'`);
    // Pull request previews (pr-<number>-….workers.dev) stay out of search engines
    expect(headers).toMatch(/^https:\/\/:version\.:subdomain\.workers\.dev\/\*\n {2}X-Robots-Tag: noindex$/m);
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe|https?:|\*|data:/);
    // PNG: 2400 × 1254, as the pages' og:image tags say
    const card = readFileSync(join(output, 'social-card.png'));
    expect([card.readUInt32BE(16), card.readUInt32BE(20)]).toEqual([2400, 1254]);
    expect(existsSync(join(output, 'robots.txt'))).toBe(true);
  });
});
