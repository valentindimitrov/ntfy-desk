# Publishing to the stores

The **Publish to stores** workflow ([`.github/workflows/publish-stores.yml`](../.github/workflows/publish-stores.yml)) submits a published GitHub release to the Chrome Web Store and Firefox Add-ons (AMO). It never rebuilds: it submits the exact files attached to the release. It starts by itself when you publish a release that **Prepare release** created ([releasing.md](releasing.md)): **Submit published release** ([`.github/workflows/release-to-stores.yml`](../.github/workflows/release-to-stores.yml)) dispatches it on `main` for the release's version with `submit` on, both stores and `publish-after-review`. Then approve the two store jobs under **Review deployments**. A prerelease starts nothing. To submit again, to one store only, or with `stage-for-manual-publish`, start it by hand.

The first version of each store item is submitted by hand ([releasing.md](releasing.md#5-chrome-web-store)): that submission creates the item with its listing, privacy answers and (on AMO) reviewer notes, which are filled in on the store's site. The workflow only submits updates to items that exist: on Chrome it uploads to the item named by `CHROME_PUBLISHER_ID` and `CHROME_EXTENSION_ID` and publishes it; on AMO it adds a version to the add-on with the manifest's id (`/addons/addon/<id>/versions/`). AMO's API could create an add-on too, but this workflow doesn't. The workflow is for every version after the first.

## Running it by hand

**Actions → Publish to stores → Run workflow**, branch `main`, or:

```bash
gh workflow run publish-stores.yml --ref main -f version=1.0.1                  # verify only
gh workflow run publish-stores.yml --ref main -f version=1.0.1 -f submit=true   # submit
```

- `version`: the published release, without the leading `v`.
- `submit`: off by default, so the run only downloads and verifies the files. Turn it on to submit. A submission can't be taken back through the workflow, so verify first.
- `chrome`, `firefox`: which stores.
- `chrome_publish_type`: `publish-after-review` goes live once Chrome's review passes; `stage-for-manual-publish` waits for you to publish it in the developer dashboard (within 30 days; after that the submission goes back to a draft).

`store-chrome` and `store-firefox` have you as required reviewer (since 2026-11-23, when the repository was public): each store job waits until you approve it under **Review deployments**. Check the run's verification first. The `submit` input stays as a second safeguard: a run without it never reaches the environments.

## What it does

1. **Download and verify release packages** (read-only token, no secrets): requires a published, non-draft release whose tag is on `origin/main`, downloads its files, checks them against `SHA256SUMS.txt` and runs `node scripts/publish-stores.ts verify <version>`. That checks both manifests' name (`ntfy Desk`), Manifest V3 and version, the Firefox add-on id, the sources ZIP's `package.json` version and, when CRX signing is on in this checkout, that the CRX is signed with the committed public key and carries exactly the Chromium ZIP.
2. **Submit to the Chrome Web Store** (environment `store-chrome`, only with `submit`): verifies again, uploads through the Chrome Web Store API v2 (the CRX when signing is on, else the Chromium ZIP), waits for processing and calls `publish` with the chosen publish type.
3. **Submit to Firefox Add-ons** (environment `store-firefox`, only with `submit`): verifies again, uploads the Firefox ZIP to the listed channel through the AMO API v5, waits for Mozilla's validation, then creates the version with the sources ZIP attached for review and the license from the sources' `package.json` (an [AMO license slug](https://mozilla.github.io/addons-server/topics/api/licenses.html), checked in step 1; `Apache-2.0` from 1.1.0).

The store jobs install nothing: `scripts/publish-stores.ts` imports only Node built-ins and `crx3.ts`, `sign-chrome.ts` and `validate-packages.ts`, which do the same. Credentials are removed from the environment when the script starts. Every request has a time limit and refuses redirects. Errors show the HTTP status and the API's own message with any credential replaced by `[redacted]`, never a request or a raw response.

When the Chrome job fails after the upload but before `publish`, the new package stays as a draft in the dashboard: submit it there or run the workflow again. AMO refuses a version it already has (HTTP 409).

## Settings it needs

All three environments (`release`, `store-chrome`, `store-firefox`) exist, accept deployments from `main` only and require your approval (**Prevent self-review** off, since you are the only reviewer). A job naming a missing environment creates it without protection, so keep the names exact.

| Name | Kind | Where |
|---|---|---|
| `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`, `CHROME_REFRESH_TOKEN` | secrets | environment `store-chrome` |
| `AMO_JWT_ISSUER`, `AMO_JWT_SECRET` | secrets | environment `store-firefox` |
| `CHROME_PUBLISHER_ID`, `CHROME_EXTENSION_ID` | variables | repository |

Never add the credentials as repository secrets: a workflow on any branch can read those. The Firefox add-on id is not a setting: it is `EXTENSION.firefoxId` in `scripts/validate-packages.ts` and the `gecko.id` in `wxt.config.ts`.

- **Chrome**: an OAuth client (Google Cloud console) with the Chrome Web Store API enabled and a refresh token for the scope `https://www.googleapis.com/auth/chromewebstore`, from the account that owns the item. The publisher id and the item id are in the developer dashboard. See [Chrome credentials](#chrome-credentials).
- **Firefox**: an API key from the [AMO developer hub](https://addons.mozilla.org/developers/addon/api/key/): the JWT issuer and its secret.

Add the secrets yourself, never through an agent. `gh secret set` reads standard input and saves an empty secret when the command feeding it fails, and still reports success. Pipe only after the value was read:

```bash
reader | { IFS= read -r first || { echo "Nothing read; nothing changed" >&2; exit 1; }; { printf '%s\n' "$first"; cat; } | gh secret set NAME --env store-chrome -R valentindimitrov/ntfy-desk; }
```

`gh secret list -e store-chrome -R valentindimitrov/ntfy-desk` then shows the secret's update time; the value can't be read back.

### Chrome credentials

1. In the [Google Cloud console](https://console.cloud.google.com), in the project of KeyMove's client or a new one, enable the **Chrome Web Store API**.
2. **Google Auth Platform → Clients → Create client**, type **Desktop app**. Google shows a new client secret once: save it in Proton Pass.
3. Set the app's publishing status to **In production**: in **Testing**, refresh tokens expire after 7 days.
4. Run, yourself, in a terminal:

   ```bash
   node scripts/chrome-oauth.ts                                                  # ntfy Desk
   node scripts/chrome-oauth.ts --repo valentindimitrov/ntfy-desk --repo valentindimitrov/keymove   # both
   ```

   It reads the client id and secret from `CHROME_CLIENT_ID` and `CHROME_CLIENT_SECRET` (for example through `pass-cli run`), else asks for them without echo. It opens Google's consent page in Vivaldi: sign in with the account that owns the items. It then checks that the new token can read each repository's item (its `CHROME_PUBLISHER_ID` and `CHROME_EXTENSION_ID` variables) and only then stores `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET` and `CHROME_REFRESH_TOKEN` in each repository's `store-chrome` environment through `gh secret set`. Nothing is printed or written to a file: the refresh token exists only in GitHub, and if it is lost or revoked, run the script again.

One client and refresh token cover every item of the account. "No refresh token" means Google remembered an earlier consent: remove the app at myaccount.google.com/permissions and run it again.

## Before the first run

- **Chrome**: the item exists, with its first version submitted by hand. If you opt into **Verified CRX uploads** ([crx-signing.md](crx-signing.md)), every later release must carry the CRX: the workflow uploads it once the public key is committed. Whether the store accepts a CRX before the opt-in isn't documented, so the workflow uploads the ZIP while signing is off.
- **Firefox**: the add-on exists on AMO with the id above and has its name, summary and categories: a new version can't set them. Its license is set with each version.
- Listing text, images and privacy answers stay in each store's dashboard ([`assets/store-listings/`](../assets/store-listings/README.md)).
- Run the workflow once without `submit` against the release, to see the verification pass.
- **Chrome refuses a new version while another is in review**: publish the next release once the store's review of the previous one is done, or cancel that review in the dashboard.
- The Chrome item and its publisher are the same as KeyMove's (`1e59622e-…`, publisher "minddevops.eu"), so the same Google account's OAuth client and refresh token work for both, and the AMO API key covers every add-on of its account. The repository variables are set (2026-11-26). The Chrome secrets are set (2026-11-27) from Proton Pass, vault `minddevops`, item "KeyMove Chrome Web Store CRX signing" (its Client ID, Client Secret and Refresh Token fields). The AMO secrets are set (2026-11-27) from the same vault, item "Firefox Developer Credentials" (JWT Issuer, JWT Secret), the key KeyMove uses.

Live state, without credentials: `https://addons.mozilla.org/api/v5/addons/addon/ntfy-desk@valentindimitrov.github.io/` (`current_version.version`) and the Version on the item's Chrome Web Store page.

## Not yet confirmed

- The workflow hasn't submitted to either store yet: watch the first run's log.
- The ZIP upload to the Chrome Web Store API v2 sends the file as the raw body with `Content-Type: application/zip`; the CRX upload adds `X-Goog-Upload-Protocol: raw` and the file name.
