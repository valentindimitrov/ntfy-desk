# ntfy Desk website: notes for agents

The public site for `https://ntfy-desk.minddevops.eu` (its policy at `/privacy-policy`). How it is built, its screenshots and its deployment: `README.md` in this folder. The root `AGENTS.md` applies too.

## Rules

- Every claim comes from the repository's `README.md`, `PRIVACY.md`, `ARCHITECTURE.md` or the code. No invented features, numbers, ratings, testimonials or availability. When the extension changes, change the page that describes it in the same change.
- Availability is `install.ts` only: store addresses stay empty until a listing is published, and the pages say "coming soon". Never write a store link into a page.
- The pages run no script and load nothing from another site: no CDN, analytics, embeds, remote fonts or inline styles. The one `<script>` element is the home page's JSON-LD (`STRUCTURED_DATA` in `site.ts`), a data block browsers don't run; add no other. The Content-Security-Policy in `site.ts` allows none of it; don't loosen it to make something work.
- The privacy policy is `PRIVACY.md`. Edit that file, never the page. If it needs Markdown that `markdown.ts` refuses, extend `markdown.ts` and its test.
- Screenshots come from `pnpm website:screenshots`, never from an image editor or a mock-up; their smaller copies only from `pnpm website:image-sizes`. Demo content is invented (`ntfy.example.com`, example hosts): no real server, token, topic or personal data. Don't fake what a page screenshot can't show (OS notifications, the browser's menus and toolbar); say what the picture is in its caption.
- Every image has `alt` text that describes it, and a width and height. Screenshots go in as `<img data-shot="name" alt="…" />`.
- Links in the shared header and footer (`site.ts`) start at the site's root (`/setup-instructions`), because `404.html` is served at any address.
- Keep one `h1` per page, the landmarks, visible focus, AA contrast in both colour schemes, and no horizontal scrolling from 360 px up.
- A new page needs an entry in `vite.config.ts` (`rolldownOptions.input`), in `public/sitemap.xml` and in `PAGES` of `tests/unit/website.test.ts`.

## Checks

1. `pnpm fmt`, then `pnpm check`: `tests/unit/website.test.ts` builds the site and checks the output. Markdown isn't formatted.
2. `pnpm website:build`, then `pnpm website:preview`, and look at each changed page in Playwright's Chromium at 1440 and 390 px wide, light and dark. Stop the server afterwards.
3. `pnpm test:e2e` and the extension builds are needed only when extension code changed, or `tests/e2e/ntfy-server.ts`, which the screenshot script uses.

## Deployment

- Every push to `main` that passes CI deploys through the `website` job in `.github/workflows/ci.yml`, once the owner has set it up (`README.md`, "Going live"). Pull requests get a preview from `.github/workflows/website-preview.yml`, a `workflow_run` workflow that always runs `main`'s definition. Don't deploy by hand, and don't call the Cloudflare API.
- The jobs that hold the token install only `deploy/` and publish the artifact as files. Keep it that way: no build step, no script from the artifact, actions pinned to commits. The preview workflow's checks on the artifact (`resolve` job) are its security boundary: don't loosen them, and keep the token out of `pull_request` workflows.
- A local build or a push doesn't prove the site is live: after a deployment, check the public address.
