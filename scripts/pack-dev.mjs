// Build a prebuilt development bundle for host acceptance on other machines:
// compiled bridge + core, gateway binaries (macOS signed ad hoc with hardened
// runtime; Windows unsigned), scene pack, eval pack and the test platform's public CA.
// The layout mirrors the repository so the installer runs unchanged:
//   node packages/bridge/dist/src/installer.js install --gateway gateway/bin/<binary>
// Usage: node scripts/pack-dev.mjs   → build/bkn-workbuddy-dev.zip + SHA-256
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const build = join(repo, 'build')
const stage = join(build, 'bkn-workbuddy-dev')
rmSync(stage, { recursive: true, force: true })
rmSync(join(build, 'bkn-workbuddy-dev.zip'), { force: true })

execFileSync('npm', ['run', 'build'], { cwd: repo, stdio: 'inherit' })
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()

const copy = (from, to) => { mkdirSync(dirname(join(stage, to)), { recursive: true }); copyFileSync(join(repo, from), join(stage, to)) }
const copyJs = (fromDir, toDir) => { for (const f of readdirSync(join(repo, fromDir))) if (f.endsWith('.js')) copy(join(fromDir, f), join(toDir, f)) }

copyJs('packages/bridge/dist/src', 'packages/bridge/dist/src')
writeFileSync(join(stage, 'packages/bridge/package.json'), JSON.stringify({ name: '@bkn-workbuddy/bridge', type: 'module', private: true }) + '\n')
copyJs('packages/core/dist/src', 'node_modules/@bkn-workbuddy/core/dist/src')
writeFileSync(join(stage, 'node_modules/@bkn-workbuddy/core/package.json'), JSON.stringify({ name: '@bkn-workbuddy/core', type: 'module', exports: { '.': './dist/src/index.js' } }) + '\n')
copy('scenes/governed-business-analysis.v1.json', 'scenes/governed-business-analysis.v1.json')
copy('eval/packs/supply-ontology.v1.json', 'eval/packs/supply-ontology.v1.json')
// Private test-platform CAs are not in the public repository: pass their directory explicitly.
const caDir = process.env.BKN_DEV_CA_DIR
if (caDir) {
  mkdirSync(join(stage, 'ca'), { recursive: true })
  for (const f of readdirSync(caDir).filter(n => n.endsWith('.pem'))) copyFileSync(join(caDir, f), join(stage, 'ca', f))
}

const version = `0.1.0-dev+${commit}`
const gw = (goos, goarch, name, cgo) => {
  const out = join(stage, 'gateway/bin', name)
  execFileSync('go', ['build', '-trimpath', '-ldflags', `-s -w -X main.version=${version}`, '-o', out, '.'], {
    cwd: join(repo, 'gateway'), env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: cgo ? '1' : '0' }, stdio: 'inherit',
  })
  if (goos === 'darwin') execFileSync('codesign', ['-s', '-', '-f', '--options', 'runtime', out], { stdio: 'inherit' })
}
gw('darwin', 'arm64', 'bkn-gateway-darwin-arm64', true)
gw('darwin', 'amd64', 'bkn-gateway-darwin-amd64', true)
gw('windows', 'amd64', 'bkn-gateway-windows-amd64.exe', false)
gw('windows', 'arm64', 'bkn-gateway-windows-arm64.exe', false)
writeFileSync(join(stage, 'VERSION'), `${version}\n`)

execFileSync('zip', ['-qry', 'bkn-workbuddy-dev.zip', 'bkn-workbuddy-dev'], { cwd: build })
const sha = createHash('sha256').update(readFileSync(join(build, 'bkn-workbuddy-dev.zip'))).digest('hex')
console.log(`${join(build, 'bkn-workbuddy-dev.zip')}\nversion ${version}\nSHA-256 ${sha}`)
