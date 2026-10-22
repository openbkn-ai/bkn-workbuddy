# bkn-workbuddy

OpenBKN business context for [WorkBuddy](https://www.workbuddy.cn/): lets WorkBuddy users query the
OpenBKN business knowledge networks they are authorised for, read-only, and leaves an auditable
business provenance record for every turn on the OpenBKN platform (viewed in OpenBKN Studio).

中文说明见 [README.zh.md](README.zh.md).

## Components

| Path | What it is |
| --- | --- |
| `packages/core` | Pure logic: tool contract and fingerprints, network catalogue and selection, task binding, turn state machine, lifecycle outcomes, provenance projection, scene and eval packs |
| `packages/bridge` | Local stdio MCP server that WorkBuddy starts: binds a task to one network, passes through the reviewed read-only OpenBKN tools, opens and closes the per-turn record |
| `gateway` | Credential gateway (Go, no third-party dependencies): keeps the OpenBKN credential in the system store (macOS Keychain / Windows DPAPI) and is the only component that talks to the platform |
| `scenes`, `schemas`, `eval` | Declarative scene pack, JSON schemas, and the evaluation pack for the sample network |
| `probes/e2e` | Live end-to-end check against an OpenBKN platform you supply |

Design and decisions: [TECHNICAL_PLAN.md](TECHNICAL_PLAN.md). Current status: [docs/STATUS.md](docs/STATUS.md).
Planned distribution as a WorkBuddy marketplace connector: [docs/plans/2026-10-20-marketplace-connector.md](docs/plans/2026-10-20-marketplace-connector.md).

## Build and test

Requirements: Node.js 20+ and Go 1.25+ (macOS builds of the gateway need cgo).

```bash
npm ci
npm run build
npm test                       # core and bridge unit tests
(cd gateway && go vet ./... && go test ./...)
node scripts/check-public.mjs  # public-content check, also run in CI
```

Live end-to-end check (needs the `openbkn` CLI logged in to the same platform; the token only lives in
the gateway process environment):

```bash
node probes/e2e/bridge-live.mjs --origin https://<your-openbkn> [--ca <private-ca.pem>]
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: see [SECURITY.md](SECURITY.md).
