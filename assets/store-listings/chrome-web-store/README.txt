NTFY DESK: CHROME WEB STORE LISTING
What goes where in the developer dashboard (https://chrome.google.com/webstore/devconsole), as filled in for 1.0.0 on 2026-11-26.

Item: "ntfy Desk", ID hiackjkcdodfgcfnpgdehfekanlfbibh, publisher "minddevops.eu" of the account that owns it.

PACKAGE
ntfy-desk-<version>-chrome.zip from the published GitHub release (never a local build). The CRX file the dashboard shows is Google's; verified CRX uploads stay off until the signing key exists (docs/crx-signing.md).

STORE LISTING
Title and summary: from the package (the manifest's name and description).
Description: description.txt.
Category: Communication. Language: English.
Store icon: public/icon/128.png.
Screenshots: ../screenshots/overview-light.png and overview-dark.png (1280 x 800).
Small promo tile: small-promo-tile.png (440 x 280).
Marquee promo tile: marquee-promo-tile.png (1400 x 560).
Global promo video: none.
Official URL: empty (it lists only sites verified in Search Console for the owning account).
Homepage URL: https://ntfy-desk.minddevops.eu
Support URL: https://github.com/valentindimitrov/ntfy-desk/issues
Mature content: off.

PRIVACY
privacy-fields.txt, one block per field. Data types ticked: Authentication information, Personal communications, Web history, Website content. Location stays unticked (decided 2026-11-26: the time zone name sent with a typed delivery time is a setting of that message for the server). All three certifications. The dashboard keeps a certification only after its save has finished: wait for "Saving item..." to end before leaving the page.

DISTRIBUTION
Free of charge, Public, all regions.

TEST INSTRUCTIONS (Access > Test instructions)
Username and password: empty. Additional instructions: test-instructions.txt (at most 500 characters).

IMAGES
All images are 24-bit RGB PNGs without alpha, made by pnpm store:screenshots (scripts/store-screenshots.ts): the screenshots from the website's screenshots of the real extension, the promo tiles drawn from the extension's icon and claims from README.md. Regenerate them rather than editing them by hand.
