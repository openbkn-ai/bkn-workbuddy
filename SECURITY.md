# Security policy

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/openbkn-ai/bkn-workbuddy/security/advisories/new)
rather than a public issue. Include the affected component (`gateway`, `packages/bridge`, `packages/core`),
version or commit, and reproduction steps. Do not include real credentials.

Scope of particular interest: credential handling in `gateway/`, the read-only tool allowlist and
task-to-network binding in `packages/bridge/`, and anything that could let a model-supplied argument
change the platform, knowledge network or interaction a call is attributed to.
