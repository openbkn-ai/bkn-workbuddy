## What and why

<!-- One or two sentences. Link the issue or design section. -->

## Tests

- [ ] `npm run build && npm test`
- [ ] `go vet ./... && go test ./...` in `gateway/`
- [ ] Live end-to-end (if behaviour against the platform changed): result and internal record id:

## Public-content checklist

- [ ] No credentials, internal addresses, private CAs, local paths or user names
- [ ] No raw host logs, screenshots or host-product internals; internal evidence referenced by id only
- [ ] `node scripts/check-public.mjs` passes
