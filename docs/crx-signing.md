# Signed Chrome Web Store uploads

The Chrome Web Store can require that every package uploaded for an item is a CRX signed with a key you registered ([verified CRX uploads](https://developer.chrome.com/docs/webstore/update#protect_your_package_updates)): someone who gets into the developer account still can't publish an update without that key. It is optional and concerns **updates**: the first submission is the ZIP.

Signing is **off** in this repository until its public key is committed. Nobody has created a key yet.

## How it works here

- `scripts/sign-chrome.ts` (`pnpm sign:chrome`) signs `.output/ntfy-desk-<version>-chrome.zip` as `.output/ntfy-desk-<version>-chrome.crx` with `scripts/crx3.ts`. It checks that the private key is the pair of the committed public key, verifies the signature and checks that the CRX carries exactly that ZIP. `pnpm verify:crx` repeats the checks without the private key.
- The public key is `assets/store-listings/chrome-web-store/crx-signing-public-key.pem` (PEM, SubjectPublicKeyInfo). It may be committed; it is what you register in the store.
- The private key (RSA, at least 2048 bits, PKCS#8 PEM) is read from the environment variable `NTFY_DESK_CRX_PRIVATE_KEY` and nowhere else. It is never written to a file or printed; key parser errors are replaced by a fixed message.
- In the **Prepare release** workflow the key is the environment secret `NTFY_DESK_CRX_PRIVATE_KEY` of the `release` environment, passed to the signing step only. That job checks out the commit afresh and installs nothing: the scripts import only Node built-ins, so dependency code can't reach the key.

| Public key committed | Secret | Result |
|---|---|---|
| no | any | Signing skipped, said in the run's summary. The draft gets the ZIPs. |
| yes | missing | The run fails before a release is created or changed. |
| yes | another key, or not an RSA key | The run fails. |
| yes | the matching key | The draft also gets the `.crx`, listed in `SHA256SUMS.txt`. |

Firefox packages and the sources ZIP are not signed with this key; Mozilla signs add-ons itself.

## Protecting the key (owner setup)

The workflow file can be edited on any branch, so its "part of `origin/main`" check only catches a wrong selection. The `release` environment is the boundary. Create it before the first run: a job that names a missing environment creates it without protection.

1. **Settings → Environments → New environment**, name `release`.
2. **Deployment branches and tags**: *Selected branches and tags*, one rule: `main`.
3. **Required reviewers**: add yourself. Leave **Prevent self-review** off while you are the only reviewer, or you couldn't approve your own release.
4. **Environment secrets**: add `NTFY_DESK_CRX_PRIVATE_KEY` (below). Paste or pipe it yourself, never through an agent.
5. Never add the key as a repository secret: any workflow on any branch can read those.

Each run then pauses at the signing job until you approve it, and a run started from another branch is refused the environment.

### What your GitHub plan allows

The repository is private at the moment. [GitHub's documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments) (read on 2026-11-17):

| | Public repository, any plan | Private, GitHub Free | Private, GitHub Pro or Team |
|---|---|---|---|
| Environment secrets | yes | no | yes |
| Deployment branch rule (`main` only) | yes | no | yes |
| Required reviewers | yes | no | no (Enterprise only) |

So the full protection (steps 2 to 4) exists only once the repository is public. Until then:

- **Recommended: keep signing off.** Don't commit the public key and don't create the secret. The workflow still builds, validates and creates the draft with the ZIPs, which is all a first store submission needs. Its write token can do no more than you can: only you can start the workflow.
- On GitHub Pro, the secret and the `main` rule work in the private repository, without the reviewer. That is acceptable while you are the only person who can push to `main`; add the reviewer when the repository becomes public.
- Don't work around a missing feature with a repository secret.

When the repository becomes public, open the environment's settings and check that the branch rule and the reviewer are active before committing the public key.

### Creating the key

Do this yourself, in your own terminal, when you decide to opt in. The key stays in a shell variable and is piped to where it is kept; no private key file is written.

```bash
key="$(openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096)"
# 1. Proton Pass first: it is the only copy you can read again
#    (pipe it into a new item with pass-cli, as for other secrets)
# 2. The public key, which is committed
printf '%s\n' "$key" | openssl pkey -pubout -out assets/store-listings/chrome-web-store/crx-signing-public-key.pem
# 3. The environment secret (gh reads the value from standard input)
printf '%s\n' "$key" | gh secret set NTFY_DESK_CRX_PRIVATE_KEY --env release --repo valentindimitrov/ntfy-desk
unset key
```

Commit the public key. From the next run on, the release carries the CRX, and the summary shows the key's SHA-256 fingerprint.

Then, in the Chrome Web Store dashboard: **Package → Verified CRX uploads → Opt in**, paste the contents of `crx-signing-public-key.pem`. From then on every update has to be the `.crx`, signed with this key. Keep the key for the life of the item: if it is lost, only Chrome Web Store support can replace it, which their documentation says can take up to a week. Google signs the published extension again with the store's own key, so the extension id doesn't change.

To sign on your own machine, run `pnpm zip && pnpm sign:chrome` with `NTFY_DESK_CRX_PRIVATE_KEY` injected into that command by Proton Pass (`pass-cli run`), never typed, exported in a shell profile or saved to a file.

## References

- [CRX3 wire format](https://chromium.googlesource.com/chromium/src/+/main/components/crx_file/crx3.proto) and [Chromium's signer](https://chromium.googlesource.com/chromium/src/+/main/components/crx_file/crx_creator.cc) (RSA PKCS#1 v1.5 with SHA-256).
- [Chrome Web Store: protect your package updates](https://developer.chrome.com/docs/webstore/update#protect_your_package_updates).
