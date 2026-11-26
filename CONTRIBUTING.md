# Contributing to ntfy Desk

Report reproducible bugs and propose features on the [issues page](https://github.com/valentindimitrov/ntfy-desk/issues).
For a bug, give the ntfy Desk version, the browser and its version, whether the server is ntfy.sh or self-hosted
(and its ntfy version), the steps and what you expected. Leave out access tokens, passwords, private topic names and
message content. Discuss substantial changes in an issue before implementing them. Follow [SECURITY.md](SECURITY.md)
for private vulnerability reports.

## Make a change

1. Fork the repository and create a focused branch from `main`.
2. Use Node.js 24 and the pnpm version in `package.json` (`packageManager`), then run `pnpm install --frozen-lockfile`.
3. Read [AGENTS.md](AGENTS.md) for the conventions and the behaviour that is easy to break (storage, credentials,
   receiving, the security model), and [ARCHITECTURE.md](ARCHITECTURE.md) for how the extension works and why.
   Keep each change focused; reproduce a bug in a test before fixing it.
4. Verify the change. Every change runs `pnpm check` (format, lint with type checking, unit tests). Extension changes
   also run `pnpm test:e2e`, and changes to the manifest, permissions or commands run `pnpm lint:firefox`. For a
   visible change, look at it in the real extension (`pnpm browse`, or load the build as in the
   [README](README.md#load-a-local-build)), in Chromium and, where the browsers differ, in Firefox. Website changes
   follow [website/AGENTS.md](website/AGENTS.md). Documentation changes need a read of the diff and its links.
5. Open a pull request against `main` with the template: the problem, the resulting behaviour and how you verified it,
   including checks that don't apply. CI must pass; it doesn't replace looking at a visible change.

The [README](README.md#development) lists the build and test commands. Generated builds, dependencies, credentials
and personal data don't belong in commits. Keep discussion respectful and focused on the work.

## Contribution licensing

Only submit work you have the right to contribute. By submitting code or documentation for inclusion, you agree to
license it under the [Apache License 2.0](LICENSE). Identify third-party material, its source and its license in the
pull request, and keep its attribution ([NOTICE.md](NOTICE.md)).
