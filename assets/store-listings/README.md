# Store listings

Text for the extension stores and the GitHub repository page, kept here so a submission is copy and paste, and so the text is reviewed with the code it describes. Nothing in this folder is part of the extension packages (`pnpm verify:packages` refuses unexpected files in them); the sources ZIP includes it (it leaves out only the website, hidden files and test output).

Every statement has to stay true to the code, [PRIVACY.md](../../PRIVACY.md), [README.md](../../README.md) and [ARCHITECTURE.md](../../ARCHITECTURE.md). ntfy is a separate project: the listings say that ntfy Desk is independent and unofficial. When a permission in `wxt.config.ts` changes, change `EXTENSION` in `scripts/validate-packages.ts` and the justifications here in the same commit; a unit test (`tests/unit/store-listings.test.ts`) checks that every permission has one.

The steps of a submission are in [docs/releasing.md](../../docs/releasing.md).

## Chrome Web Store (`chrome-web-store/`)

| File | Dashboard field |
|---|---|
| `description.txt` | **Store listing → Description** (plain text). The short summary under the title is the manifest's `description` from `wxt.config.ts`, at most 132 characters. |
| `privacy-fields.txt` | **Privacy**: single purpose, one justification per permission, remote code, data usage, certifications, privacy policy URL. Each block is one field. |
| `test-instructions.txt` | **Access → Test instructions → Additional instructions** (at most 500 characters). |
| `small-promo-tile.png`, `marquee-promo-tile.png` | **Store listing → Small promo tile** (440 × 280) and **Marquee promo tile** (1400 × 560). |
| `README.txt` | Every dashboard field as filled in for 1.0.0: the item, category, URLs, privacy choices, distribution. |
| `crx-signing-public-key.pem` | Not there yet. Once committed, releases carry a signed CRX: [docs/crx-signing.md](../../docs/crx-signing.md). |

Other fields: category **Communication** (or **Tools**; the dashboard's list decides), language English. Homepage and support URL: the website (`https://ntfy-desk.minddevops.eu`) and the GitHub issues page (`https://github.com/valentindimitrov/ntfy-desk/issues`), both public.

## Firefox Add-ons (`firefox-add-ons/`)

| File | Field on addons.mozilla.org |
|---|---|
| `summary.txt` | **Summary** (at most 250 characters). |
| `description.md` | **Description**. AMO accepts this subset of Markdown (bold, links, lists). |
| `reviewer-notes.txt` | **Notes to Reviewer**, below its first lines: how to build from the sources ZIP and how to test with a ntfy server. |
| `README.txt` | Every Developer Hub field as filled in for 1.0.0: distribution, compatibility, categories, license, support site. |

Other fields: license GPL-3.0-only; the privacy policy field takes the text of `PRIVACY.md`; platforms: desktop only (the add-on isn't tested on Firefox for Android); categories Alerts & Updates and Social & Communication (`README.txt`). The add-on id and the data collection declaration come from the manifest.

## GitHub (`github/`)

`README.md` has the repository description, website and topics.

## Images

Screenshots come from the real extension: `pnpm website:screenshots` captures the website's screenshots and then writes the store's from them (`scripts/store-screenshots.ts`, also `pnpm store:screenshots`) into `screenshots/`: `overview-light.png` and `overview-dark.png`, 1280 × 800 px PNG without alpha, for the Chrome Web Store and Firefox Add-ons. The same script draws the Chrome Web Store promo tiles into `chrome-web-store/` from the extension's icon and README claims (`--tiles` or `--screenshots` makes only those). None of the images are part of the sources ZIP. The GitHub social preview is still to make. Each store needs:

| Store | Image | Size | Count |
|---|---|---|---|
| Chrome Web Store | Store icon | 128 × 128 px PNG: `public/icon/128.png`, already in the package | 1, required |
| Chrome Web Store | Screenshots | 1280 × 800 px (or 640 × 400), full bleed, no rounded corners or padding; PNG without alpha or JPEG | 1 required, up to 5 |
| Chrome Web Store | Small promo tile | 440 × 280 px, PNG or JPEG | 1, optional (listings without it rank after those with one) |
| Chrome Web Store | Marquee promo tile | 1400 × 560 px, PNG or JPEG | 1, optional (only used if the store features the extension) |
| Firefox Add-ons | Icon | Taken from the package (`icon/`) | none to upload |
| Firefox Add-ons | Screenshots | 1280 × 800 px recommended (1.6:1), PNG or JPEG | optional, no fixed count; the Chrome screenshots fit |
| GitHub | Social preview | 1280 × 640 px, under 1 MB | 1, optional |

Sizes are from [Chrome's image guidelines](https://developer.chrome.com/docs/webstore/images) and Mozilla's [listing guide](https://extensionworkshop.com/documentation/develop/create-an-appealing-listing/), read on 2026-11-17; the dashboards have the last word.
