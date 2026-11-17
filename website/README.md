# ntfy Desk website

The public site for https://ntfy-desk.minddevops.eu: a home page, a getting started guide and the privacy policy. Static HTML and CSS, built with Vite. The pages run no script and load nothing from other sites.

From the repository root:

```sh
pnpm website:dev          # http://127.0.0.1:5180, with reload
pnpm website:build        # .output/website
pnpm website:preview      # http://127.0.0.1:5181, serves the build
pnpm website:screenshots  # retake the screenshots in media/
pnpm website:card         # render media/social-card.png again
```

The site is **not public yet**. It goes live only when the owner does the steps under [Going live](#going-live).

## Layout

| File | What it is |
|---|---|
| `index.html`, `getting-started.html`, `privacy-policy.html`, `404.html` | The pages. Their text is written here by hand, from `README.md` and the code. |
| `site.ts` | The parts the pages share, filled in at build time: header, footer, install list, screenshots, privacy policy, Content-Security-Policy and the `_headers` file. |
| `install.ts` | Where the extension can be installed from. An empty store URL is shown as "coming soon". |
| `markdown.ts` | Converts `PRIVACY.md` for the privacy policy page. |
| `website.css` | The one stylesheet. Colours and fonts are the extension's (`assets/styles.css`, `public/fonts`). |
| `media/` | Screenshots (WebP, light and dark), their sizes (`shots.json`), and the social card with its source. |
| `public/` | `robots.txt` and `sitemap.xml`, copied as they are. |
| `wrangler.jsonc`, `deploy/` | The Cloudflare deployment. |

The build also writes `LICENSE.txt` (the GPL, `NOTICE.md` and the Roboto fonts' Apache licence), `_headers` and `social-card.png` (unhashed, because link previews need a fixed address).

`tests/unit/website.test.ts` builds the site and checks the output, as part of `pnpm check`: nothing loaded from another site, every link and file exists, every image has a description and a size, and the privacy page says what `PRIVACY.md` says.

## Publishing the extension in a store

Put the listing's address in `install.ts` (`chromeWebStore` or `firefoxAddons`). The home page and the guide then link to it instead of saying "coming soon", and the test stops refusing store addresses. Set `repositoryPublic` to `true` when the GitHub repository is public; until then the pages say that its links only open for people with access.

## Privacy policy

`privacy-policy.html` holds only the frame. The policy itself is `PRIVACY.md`, converted when the site is built, so the two can't differ. `markdown.ts` supports what that file uses (headings, paragraphs, lists, bold, https links) and stops the build on anything else: extend it when `PRIVACY.md` needs more.

## Screenshots

`pnpm website:screenshots` (`scripts/website-screenshots.ts`) takes them from the real extension. It builds the E2E build, loads it in Playwright's Chromium, and connects it to the test ntfy server of the end-to-end tests, filled with invented messages. Each view is captured in light and dark at twice the size and converted to WebP with ImageMagick. It needs Playwright's Chromium (`pnpm exec playwright install chromium`), `openssl` and `magick`.

- The extension shows its server's address, so the test server gets an invented name. Chromium maps `ntfy.example.com` to a local HTTPS front with a certificate made for that run. The front also serves the attached image, which the test server can't.
- The demo server needs no sign-in. With a token stored, the extension asks for access to the server in a browser prompt, which a script can't answer.
- The operating system draws desktop notifications, so the notifications section shows the topic rules in the settings.
- A page screenshot can't include the browser's right-click menu or toolbar. For "From the page", the script runs the real **Send this page to ntfy** command on a sample page and captures the inbox with the message it delivered. The caption on the page says so.
- In the Topics table, **Sync server deletions** is selected but not applied: applying it also asks for access to the server.

Screenshots are written into the pages as `<img data-shot="name" alt="…" />`. The build replaces that with the light and dark files and the size from `shots.json`.

Run one Chromium at a time, and look at the new files before committing them: the times ("4m ago") and file sizes change with every run.

## Link previews

The pages' Open Graph tags point at `/social-card.png`. It is rendered from `media/social-card.html`, a 1200 × 627 layout, at twice that size (2400 × 1254). LinkedIn shows it about 520 pixels wide and recompresses it, so keep text large: nothing under 30 pixels in the layout. After editing the layout, run `pnpm website:card` (Playwright's Chromium and `magick`). LinkedIn caches previews: after deploying a new card, refresh it with its Post Inspector.

## Security headers

`site.ts` holds the Content-Security-Policy: `default-src 'none'`, with styles, images and fonts from the site itself only. No scripts, frames, forms or connections. The built pages carry it in a meta tag, and `_headers` sends it as a header together with `frame-ancestors 'none'`, HSTS (this host only), `nosniff`, a referrer policy and a permissions policy. Fingerprinted files under `/assets/` are cached for a year; HTML is revalidated.

Vite's preview doesn't apply `_headers` and answers an unknown address with an empty 404. To see the site as Cloudflare serves it, with the headers, clean addresses and `404.html`:

```sh
pnpm website:build
pnpm --dir website/deploy install --frozen-lockfile
website/deploy/node_modules/.bin/wrangler dev --local --config website/wrangler.jsonc
```

That runs on this machine only and needs no Cloudflare account. It leaves a `.wrangler` folder, which git ignores.

## Deployment

The site is a Cloudflare Worker with static assets only, `ntfy-desk-website` (`wrangler.jsonc`), on the custom domain `ntfy-desk.minddevops.eu`. In `.github/workflows/ci.yml`:

- The `check` job builds the site and uploads `.output/website` as the `website` artifact. It has no secrets.
- The `website` job runs on pushes to `main`, in the environment `production`. It checks out only `wrangler.jsonc` and `deploy/`, installs the Wrangler locked in `deploy/pnpm-lock.yaml` (a standalone pnpm project), downloads the artifact and deploys it. It is skipped while the variable `CLOUDFLARE_ACCOUNT_ID` is unset.

There are no pull request previews.

### Going live

Nothing is deployed until the owner does this, once:

1. In Cloudflare, create an API token from the **Edit Cloudflare Workers** template, limited to the account and to the `minddevops.eu` zone.
2. In the repository's settings on GitHub, under **Environments**, create the environment `production`. Under **Deployment branches and tags**, choose **Selected branches and tags** and add `main`.
3. In that environment, add the secret `CLOUDFLARE_API_TOKEN` with the token. Keep it an environment secret, not a repository secret.
4. Add the variable `CLOUDFLARE_ACCOUNT_ID` with the Cloudflare account ID. A repository variable works, and so does a variable of the `production` environment.
5. Push to `main`, or run the CI workflow again on `main`. The `website` job then deploys, and Cloudflare creates the DNS record and the certificate for the custom domain on the first deployment.
6. Open https://ntfy-desk.minddevops.eu and check the pages, and the response headers with `curl -I`.

Why an environment secret: a repository secret is passed to every `pull_request` run from a branch of this repository, and that branch controls its own workflow file, so it could add a job that reads the token. An environment limited to `main` refuses those runs. Anyone who can push to `main` can still change the workflow and use the token.

To take the site down again, clear the variable (the job is skipped) and delete the Worker in Cloudflare.

To update Wrangler, change its version in `deploy/package.json` and run `pnpm install --lockfile-only` in `deploy/`.
