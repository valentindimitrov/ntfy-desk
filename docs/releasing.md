# Releasing ntfy Desk

A release is prepared by a workflow started by hand and finished by hand: the workflow builds, checks and attaches the packages to a **draft** GitHub release, and you publish the draft. The first submission to each store is done by hand; later versions go to the stores through the **Publish to stores** workflow ([store-publishing.md](store-publishing.md)), which publishing the release starts, with each store job waiting for your approval. Nothing is released by pushing a tag.

Files: [`.github/workflows/prepare-release.yml`](../.github/workflows/prepare-release.yml), `scripts/validate-packages.ts`, `scripts/sign-chrome.ts`, [crx-signing.md](crx-signing.md) (the optional Chrome Web Store signing key and the `release` environment), [`assets/store-listings/`](../assets/store-listings/README.md) (the text for the stores).

## Once, before the first release

1. The environments `release`, `store-chrome` and `store-firefox` exist and accept deployments from `main` only ([crx-signing.md](crx-signing.md#protecting-the-key-owner-setup), [store-publishing.md](store-publishing.md#settings-it-needs)). A job that names a missing environment creates it without any protection.
2. Decide about CRX signing. It is off until a public key is committed, and a first Chrome Web Store submission doesn't need it.

## 1. Bump the version (not for the first release)

The version lives in `package.json` only; WXT writes it into both manifests and the ZIP names. The first release uses the `1.0.0` already there: skip to step 2. For every later release, change it in a commit of its own, separate from releasing:

```bash
pnpm build && pnpm build:firefox   # then check "version" in .output/*/manifest.json
pnpm check
```

Push to `main` and wait for CI. A version is two to four numbers (`1.0.1`); the stores accept nothing else. Each published version needs a new number: the workflow refuses a version whose tag exists.

## 2. Run Prepare release

**Actions → Prepare release → Run workflow**, branch `main`, the version without `v` (it must equal `package.json`'s: `1.0.0` for the first release), or:

```bash
gh workflow run prepare-release.yml --ref main -f version=1.0.0 -f prerelease=false
```

**Build and validate packages** (read-only token, no secrets):

- checks that the version equals `package.json`'s, the commit is on `origin/main` and no tag `v<version>` exists;
- runs the full gate: `pnpm check`, the end-to-end tests, `pnpm lint:firefox`;
- builds `ntfy-desk-<version>-chrome.zip`, `-firefox.zip` and `-sources.zip`;
- validates them (`pnpm verify:packages`): manifests with the expected version, name, permissions and Firefox id; license notices identical to the repository's; no source maps, stray files or E2E hooks; each ZIP equal to its unpacked build; sources identical to the commit;
- uploads the three ZIPs as the artifact `unsigned-release-packages` (kept 3 days).

**Sign and create draft release** (environment `release`, write access to releases):

- waits for your approval if the environment has a required reviewer: open the run and choose **Review deployments → Approve**;
- checks out the commit afresh, downloads the artifact and validates it again. It installs nothing: the scripts import only Node built-ins;
- signs the Chromium ZIP as a CRX when the public key `assets/store-listings/chrome-web-store/crx-signing-public-key.pem` is committed (it then needs the private key secret, [crx-signing.md](crx-signing.md)), otherwise says "CRX signing skipped" in the run's summary;
- writes `SHA256SUMS.txt`;
- creates the draft release `ntfy Desk v<version>` with generated notes ([`.github/release.yml`](../.github/release.yml) sorts pull requests by label). If a draft for that tag exists, it keeps the draft's title and notes, points it at the selected commit, sets the prerelease flag and replaces its files. A published release or an existing tag stops the run.

The run can be repeated for the same version until the draft is published.

## 3. Test the draft's packages

Download the files from the draft's page (**Releases**; drafts are visible to you only) into an empty folder.

```bash
shasum -a 256 -c SHA256SUMS.txt      # Linux: sha256sum -c SHA256SUMS.txt
```

- **Chromium**: extract `-chrome.zip`, load the folder unpacked (extensions page, **Developer mode**), check the version, send and receive a message.
- **Firefox**: `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → the `-firefox.zip`.
- With a signed CRX: put it next to the ZIP in `.output/` of a checkout of that commit and run `pnpm verify:crx`.

## 4. Publish the draft

Edit the notes if needed, check the target commit, then **Publish release**. GitHub creates the tag `v<version>` at that commit; from then on the version is taken. Publishing (not the tag) starts **Submit published release**, which starts **Publish to stores** for the version: approve its Chrome and Firefox jobs under **Review deployments** once its verification passed ([store-publishing.md](store-publishing.md)). A prerelease isn't submitted. Chrome refuses a new version while another is in review, so publish after the previous review is done.

## 5. Chrome Web Store

From the second version on, submit with the **Publish to stores** workflow instead ([store-publishing.md](store-publishing.md)), and change the listing in the dashboard only when its text changed. For the first submission, in the [developer dashboard](https://chrome.google.com/webstore/devconsole), with the files of the published release:

1. First submission: **New item**, upload `ntfy-desk-<version>-chrome.zip`. Later versions: **Package → Upload new package**, the ZIP, or the `.crx` once verified uploads are on ([crx-signing.md](crx-signing.md)).
2. **Store listing**: `chrome-web-store/description.txt` into Description; category, language and images as listed in [`assets/store-listings/README.md`](../assets/store-listings/README.md).
3. **Privacy**: each block of `chrome-web-store/privacy-fields.txt` into its field, the data usage boxes, the certifications and the privacy policy URL.
4. **Submit for review**. A store submission can't be taken back once published: check the listing preview first.

## 6. Firefox Add-ons

From the second version on, submit with the **Publish to stores** workflow ([store-publishing.md](store-publishing.md)); it attaches the sources ZIP. For the first submission, on [addons.mozilla.org](https://addons.mozilla.org/developers/):

1. **Submit a New Add-on** (later: **Upload New Version**), distribution **On this site**, upload `ntfy-desk-<version>-firefox.zip`. Compatibility: Firefox for desktop.
2. Source code: answer **Yes** and upload `ntfy-desk-<version>-sources.zip`.
3. Listing: `firefox-add-ons/summary.txt` into Summary, `description.md` into Description, license Apache-2.0 (from 1.1.0; 1.0.0 was GPL-3.0-only), the text of `PRIVACY.md` into the privacy policy field.
4. **Notes to Reviewer**: `firefox-add-ons/reviewer-notes.txt` below its first lines.

Mozilla signs the add-on; the signed file is then installed from its Add-ons page. The ZIP on GitHub stays unsigned and is for temporary testing.

## 7. Afterwards

- Put the store addresses into the website's configuration of install targets and into README's **Install** section. Until then both point to GitHub Releases.
- Update the Roadmap in `AGENTS.md` if the release closed an item.
- The description and topics in `assets/store-listings/github/README.md`, if they aren't set on the repository yet.
