# ntfy Desk website

The public site for https://ntfy-desk.minddevops.eu: a home page, the setup instructions and the privacy policy. Static HTML and CSS, built with Vite. The pages run no script and load nothing from other sites.

From the repository root:

```sh
pnpm website:dev          # http://127.0.0.1:5180, with reload
pnpm website:build        # .output/website
pnpm website:preview      # http://127.0.0.1:5181, serves the build
pnpm website:screenshots  # retake the screenshots in media/
pnpm website:card         # render media/social-card.png again
```

The site is live since 2026-11-23: every push to `main` that passes CI deploys it ([Deployment](#deployment)).

## Layout

| File | What it is |
|---|---|
| `index.html`, `setup-instructions.html`, `privacy-policy.html`, `404.html` | The pages. Their text is written here by hand, from `README.md` and the code. |
| `site.ts` | The parts the pages share, filled in at build time: header, footer, install list, screenshots, privacy policy, Content-Security-Policy and the `_headers` file. |
| `install.ts` | Where the extension can be installed from. An empty store URL is shown as "coming soon". |
| `markdown.ts` | Converts `PRIVACY.md` for the privacy policy page. |
| `website.css` | The one stylesheet. Colours and fonts are the extension's (`assets/styles.css`, `public/fonts`). |
| `media/` | Screenshots (WebP, light and dark, each with smaller copies), their sizes (`shots.json`), the social card with its source, and the browser icons of the header's store buttons (`browsers/`, sources in its README). |
| `public/` | `robots.txt`, `sitemap.xml`, `_redirects` (old addresses: `/getting-started` is now `/setup-instructions`; `/security.txt`) and `.well-known/security.txt`, copied as they are. |
| `wrangler.jsonc`, `deploy/` | The Cloudflare deployment. |

The build also writes `LICENSE.txt` (the GPL, `NOTICE.md` and the Roboto fonts' Apache licence), `_headers` and `social-card.png` (unhashed, because link previews need a fixed address).

`tests/unit/website.test.ts` builds the site and checks the output, as part of `pnpm check`: nothing loaded from another site, every link and file exists, every image has a description and a size, and the privacy page says what `PRIVACY.md` says.

## Publishing the extension in a store

Put the listing's address in `install.ts` (`chromeWebStore` or `firefoxAddons`). The header's store buttons, the install lists and the guide then link to it instead of saying "coming soon". `tests/unit/website.test.ts` allows exactly the addresses configured there and still refuses any other store address, so write a store link nowhere else. `repositoryPublic` is `true` since the repository became public on 2026-11-23; set to `false`, the pages would say that its GitHub links only open for people with access.

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

Each screenshot also comes in smaller copies (`<name>-<scheme>-<width>w.webp`, widths in `shot-sizes.ts`), written from the full-size file by `pnpm website:image-sizes` (ImageMagick), which `website:screenshots` runs at the end. The pages list every copy in `srcset`, with a `sizes` value per place (`SHOT_SIZES` in `site.ts`, which follows the widths in `website.css`), so a browser downloads the smallest copy that is still sharp. Change `SHOT_SIZES` when a screenshot's place or width changes. The pages also preload the three Roboto weights, so text doesn't move when the fonts arrive.

Run one Chromium at a time, and look at the new files before committing them: the times ("4m ago") and file sizes change with every run.

## Search engines

What search engines read is checked by `tests/unit/website.test.ts`: a description of 50 to 160 characters on every page (a result shows about that much), one `h1`, a canonical address equal to the page's address, and a sitemap that lists exactly the public pages (`PAGES` in the test; the 404 page is `noindex` and stays out). The home page carries `WebSite` structured data (`STRUCTURED_DATA` in `site.ts`), so results can show the name "ntfy Desk" instead of the domain. It is a JSON-LD data block: browsers don't run it, so the Content-Security-Policy still allows no script.

The checklist this follows, and the steps outside the repository (Search Console, Bing, the store listings), are in the owner's setup repository (`z_project_tooling/website-checklist.md`).

## security.txt

`public/.well-known/security.txt` tells security researchers where to report: GitHub's private vulnerability reporting, with `SECURITY.md` as the policy; `/security.txt` redirects there (`public/_redirects`). Its `Expires` date must stay in the future and at most a year ahead: the website test fails otherwise. Renew it before 2027-05-23.

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

- Pull requests get a preview through `.github/workflows/website-preview.yml` (below).

### Pull request previews

When the CI run of a pull request from a branch of this repository succeeds, **Website preview** uploads its `website` artifact as a preview version of the Worker with the alias `pr-<number>`, at `https://pr-<number>-ntfy-desk-website.<subdomain>.workers.dev`. Production doesn't change. The pull request's commit gets the status **Website preview**, linking the preview, or the run when the upload failed. Previews send `X-Robots-Tag: noindex` (`_headers`).

- It is a `workflow_run` workflow: GitHub always runs the definition on `main`, with `main` as its ref, so a branch can't rewrite the job that holds the token. Its changes take effect only once merged. A `pull_request` workflow would run the branch's own file.
- The artifact comes from the branch, so it is treated as files to publish and nothing else. A job without secrets downloads it through the API, checks that it belongs to the tested commit, and extracts regular files only: no path traversal, links or encrypted entries, no `_worker.js`, `.assetsignore`, `.wrangler` or `node_modules`, at most 2,000 files, 25 MiB per file and 100 MiB in all, with an `index.html`. Only then does the deploy job, on another machine, run `main`'s locked Wrangler on them.
- Pull requests from forks and from Dependabot get no preview. A commit that is no longer the pull request's head when its upload starts is skipped, so a late run can't replace a newer preview.
- It is skipped while `CLOUDFLARE_ACCOUNT_ID` is unset, like production. It needs the workers.dev subdomain enabled on the Cloudflare account.

### Going live

Done on 2026-11-23; kept as the record, and for setting it up again:

1. In Cloudflare, create an API token from the **Edit Cloudflare Workers** template, limited to the account and to the `minddevops.eu` zone.
2. The environments `production` and `preview` exist on GitHub (created on 2026-11-22 and 2026-11-23), each accepting deployments from `main` only (**Deployment branches and tags**: *Selected branches and tags*, `main`). A job that names a missing environment creates it without that rule.
3. In both environments, add the secret `CLOUDFLARE_API_TOKEN` with the token. Keep it an environment secret, not a repository secret.
4. Add the repository variable `CLOUDFLARE_ACCOUNT_ID` with the Cloudflare account ID. It has to be a repository variable: the preview workflow checks it before it enters an environment.
5. Check that the account's workers.dev subdomain is enabled (**Workers & Pages**): previews are served there.
6. Cloudflare creates the custom domain's DNS record: remove any existing record for `ntfy-desk.minddevops.eu` first, or the first deployment fails.
7. Push to `main`, or run the CI workflow again on `main`. The `website` job then deploys, and Cloudflare creates the DNS record and the certificate for the custom domain on the first deployment.
8. Open https://ntfy-desk.minddevops.eu and check the pages, and the response headers with `curl -I`. Then push to a pull request and check its **Website preview** status.

Why an environment secret: a repository secret is passed to every `pull_request` run from a branch of this repository, and that branch controls its own workflow file, so it could add a job that reads the token. An environment limited to `main` refuses those runs (their ref is `refs/pull/<n>/merge`), while pushes to `main` and the preview workflow (ref `main`) are let in. Anyone who can push to `main` can still change the workflow and use the token.

To take the site down again, clear the variable (both workflows are skipped) and delete the Worker in Cloudflare.

Dependabot proposes Wrangler updates (`.github/dependabot.yml`, directory `/website/deploy`). To update it by hand, change its version in `deploy/package.json` and run `pnpm install --lockfile-only` in `deploy/`.
