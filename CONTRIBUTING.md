# Contributing

## Workflow

1. Branch from `main`; open a pull request. `main` only changes through reviewed pull requests with green CI.
2. Commit messages, pull request titles and descriptions, and review comments are written in **English**.
   Design documents may be in Chinese.
3. Keep changes scoped; update `docs/STATUS.md` or `TECHNICAL_PLAN.md` when a decision or status changes.

## Before you push

```bash
npm ci && npm run build && npm test
(cd gateway && go vet ./... && go test ./...)
node scripts/check-public.mjs
```

Enable the same public-content check as a pre-commit hook once per clone:

```bash
git config core.hooksPath .githooks
```

## This repository is public

Never commit:

- credentials of any kind (tokens, AppKeys, passwords, device codes), real or "expired";
- internal test-platform addresses, private CAs, or local machine paths and user names;
- raw acceptance logs, host screenshots, transcripts, or notes on the internals of host products.

Such material belongs in the internal repository. Refer to it by an identifier
(for example "internal evidence R3-macOS") instead of a link or path.
Use `*.example.test` or `192.0.2.x` for example addresses. Local test-platform settings go in
`*.local.json` or `.env.local`, which are ignored by git.

Live end-to-end runs against internal test platforms happen outside public CI; report them in the
pull request as a short sanitized summary (result, platform edition, internal record identifier).

## Credentials in development

- The OpenBKN token is only ever held by the gateway (system credential store) or, for the live
  end-to-end check, in the gateway process environment. Never write it to a file, argument or log.
- Tests use fake values only.
