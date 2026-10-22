#!/usr/bin/env node
// Public-content check: this repository is public, so internal test-platform details,
// local machine paths, host-product internals and credentials must never be committed.
// Runs in CI on every pull request and locally as the pre-commit hook (.githooks/pre-commit).
//
//   node scripts/check-public.mjs            check all tracked files
//   node scripts/check-public.mjs --staged   check the staged version of staged files
//
// A line may opt out with the marker `public-check: allow <reason>` when the match is a
// deliberate example (for instance a fake value in a test).
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const RULES = [
  { id: 'private-ipv4', re: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/, why: 'private network address (use *.example.test or 192.0.2.x)' },
  { id: 'local-user-path', re: /(?:\/Users\/[A-Za-z][\w.-]+|\/home\/[a-z][\w.-]+|[A-Za-z]:\\Users\\(?!A B\\)[^\\\s"]+)/, why: 'local user path' },
  { id: 'host-internals', re: /\bapp\.asar\b|module\.app-server\.js|codebuddy-lite-wb/, why: 'host product internals (keep in the internal repository)' },
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/, why: 'private key' },
  { id: 'certificate', re: /-----BEGIN CERTIFICATE-----/, why: 'certificate (test CAs stay in the internal repository)' },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, why: 'JWT' },
  { id: 'openbkn-appkey', re: /\bbak_[A-Za-z0-9]{16,}/, why: 'OpenBKN AppKey' },
  { id: 'oauth-token', re: /\bory_(?:at|rt|ac)_[A-Za-z0-9_-]{16,}/, why: 'OAuth token' },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/, why: 'GitHub token' },
  { id: 'bearer-value', re: /Bearer\s+[A-Za-z0-9._~+/-]{24,}=*/, why: 'bearer credential value' },
]
const SKIP = [/^package-lock\.json$/, /\.(png|jpg|jpeg|gif|ico|pdf|zip|tgz)$/i, /^scripts\/check-public\.mjs$/]

const staged = process.argv.includes('--staged')
const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 << 20 })
const files = (staged ? git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']) : git(['ls-files'])).split('\n').filter(f => f && !SKIP.some(re => re.test(f)))

const findings = []
for (const file of files) {
  let text
  try { text = staged ? git(['show', `:${file}`]) : readFileSync(file, 'utf8') } catch { continue }
  text.split('\n').forEach((line, i) => {
    if (line.includes('public-check: allow')) return
    for (const rule of RULES) if (rule.re.test(line)) findings.push(`${file}:${i + 1}  [${rule.id}] ${rule.why}`)
  })
}
if (findings.length) {
  console.error(`public-content check failed (${findings.length}):\n` + findings.map(f => `  ${f}`).join('\n'))
  console.error('\nMove internal material to the internal repository, or mark a deliberate example with `public-check: allow <reason>`.')
  process.exit(1)
}
console.log(`public-content check passed (${files.length} files)`)
