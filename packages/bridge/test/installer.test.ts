import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dataRoot, legacyRoots } from '../src/paths.js'
import { formatSettings, HOOK_MARKER, hookCommand, ourHooks, parseSettings, withOurHooks, withoutOurHooks } from '../src/hook-settings.js'

const OTHER = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo theirs' }] }] }, theme: 'dark' }

test('hook commands: quoted forward-slash paths, never fail, carry the marker', () => {
  const c = hookCommand('C:\\Users\\A B\\node.exe', 'C:\\Users\\A B\\.bkn-workbuddy\\app\\bridge\\cli.js', 'Stop', 'C:\\Users\\A B\\.bkn-workbuddy\\logs\\hook-stderr.log')
  assert.equal(c, `"C:/Users/A B/node.exe" "C:/Users/A B/.bkn-workbuddy/app/bridge/cli.js" hook Stop 2>>"C:/Users/A B/.bkn-workbuddy/logs/hook-stderr.log" || true ${HOOK_MARKER}`)
  assert.throws(() => hookCommand('/a/$HOME/node', '/b/cli.js', 'Stop', '/l'))
  assert.throws(() => hookCommand('/a/"x"/node', '/b/cli.js', 'Stop', '/l'))
})

test('data root is ~/.bkn-workbuddy on every platform; earlier roots, including AgentConnectors, are legacy', () => {
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    assert.equal(dataRoot({ LOCALAPPDATA: 'C:\\L' }, platform), join(homedir(), '.bkn-workbuddy'))
  }
  assert.equal(dataRoot({ BKN_WORKBUDDY_HOME: '/x' }, 'win32'), '/x')
  assert.ok(legacyRoots({ LOCALAPPDATA: 'L', APPDATA: 'R' }, 'win32').includes(join('L', 'AgentConnectors', 'bkn-workbuddy')))
  assert.ok(legacyRoots({}, 'darwin').includes(join(homedir(), 'Library', 'Application Support', 'AgentConnectors', 'bkn-workbuddy')))
  assert.deepEqual(legacyRoots({ BKN_WORKBUDDY_HOME: '/x' }, 'win32'), [])
})

test('hooks: exactly one entry per event, other hooks and keys untouched, removal restores the original', () => {
  const once = withOurHooks(structuredClone(OTHER), '/n/node', '/a/cli.js', '/l/e.log')
  const twice = withOurHooks(once, '/n2/node', '/a/cli.js', '/l/e.log')
  assert.equal(ourHooks(twice).length, 2)
  assert.ok(ourHooks(twice).every(h => h.command.startsWith('"/n2/node"')))
  assert.deepEqual((twice.hooks as { Stop: unknown[] }).Stop[0], OTHER.hooks.Stop[0])
  assert.equal(twice.theme, 'dark')
  assert.deepEqual(withoutOurHooks(twice), OTHER)
  assert.deepEqual(withoutOurHooks(withOurHooks({ a: 1 }, '/n', '/c', '/l')), { a: 1 })
  assert.throws(() => withOurHooks({ hooks: [] }, '/n', '/c', '/l'))
})

test('settings formatting (BOM, CRLF, tabs) survives a round trip', () => {
  const raw = '\ufeff{\r\n\t"a": 1\r\n}\r\n'
  const { json, format } = parseSettings(raw)
  assert.equal(formatSettings(json, format), raw)
})

test('install → installed bridge runs → doctor (offline) → uninstall', { skip: process.platform === 'win32' }, () => {
  const home = mkdtempSync(join(tmpdir(), 'bkn-install-'))
  const settings = join(home, 'settings.json')
  writeFileSync(settings, JSON.stringify(OTHER, null, 2) + '\n')
  const fake = fileURLToPath(new URL('../../test/fixtures/fake-gateway.mjs', import.meta.url))
  const gateway = join(home, 'fake-gateway.sh')
  writeFileSync(gateway, `#!/bin/sh\nif [ "$1" = version ]; then echo "bkn-gateway fake"; exit 0; fi\nexec "${process.execPath}" "${fake}"\n`)
  chmodSync(gateway, 0o755)
  const installer = fileURLToPath(new URL('../src/installer.js', import.meta.url))
  const env = { ...process.env, BKN_WORKBUDDY_HOME: join(home, 'data') }
  const run = (...args: string[]) => spawnSync(process.execPath, [installer, ...args, '--settings', settings], { env, encoding: 'utf8', timeout: 30_000 })

  const inst = run('install', '--gateway', gateway)
  assert.equal(inst.status, 0, inst.stderr)
  assert.match(inst.stdout, /openbkn-business-context/)
  const app = join(home, 'data', 'app')
  assert.ok(existsSync(join(app, 'bridge', 'cli.js')) && existsSync(join(app, 'node_modules', '@bkn-workbuddy', 'core', 'dist', 'src', 'index.js')))
  assert.equal(ourHooks(parseSettings(readFileSync(settings, 'utf8')).json).length, 2)

  // The installed hook command is run the way WorkBuddy runs it: through sh.
  const hook = ourHooks(parseSettings(readFileSync(settings, 'utf8')).json).find(h => h.event === 'UserPromptSubmit')!
  const r = spawnSync('/bin/sh', ['-c', hook.command], { env, input: JSON.stringify({ session_id: 's1', generation_id: 'g1', prompt: '问题' }), encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(readdirSync(join(home, 'data', 'state')).filter(f => f.endsWith('.json')).length, 1, 'installed bridge resolved its modules and recorded the turn')
  const broken = spawnSync('/bin/sh', ['-c', hook.command.replace(process.execPath, '/nonexistent/node')], { env, input: '{}', encoding: 'utf8' })
  assert.equal(broken.status, 0, 'a missing node must not block the prompt')
  const stderrLog = join(home, 'data', 'logs', 'hook-stderr.log')
  assert.ok(readFileSync(stderrLog, 'utf8').length > 0, 'the failure is recorded for doctor')
  const doctorAfterFailure = run('status')
  assert.equal(doctorAfterFailure.status, 1, 'doctor reports the hook error')
  assert.match(doctorAfterFailure.stdout, /钩子报过错/)
  assert.match(doctorAfterFailure.stdout, /钩子最近一次在 WorkBuddy 中运行/)
  writeFileSync(stderrLog, '')

  // The installed MCP server answers initialize and tools/list.
  const mcp = spawnSync(process.execPath, [join(app, 'bridge', 'cli.js'), 'mcp'], {
    env, encoding: 'utf8', timeout: 20_000,
    input: [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }].map(m => JSON.stringify(m)).join('\n') + '\n',
  })
  const replies = mcp.stdout.trim().split('\n').map(l => JSON.parse(l) as { id: number; result: { tools?: unknown[] } })
  assert.equal(replies.find(x => x.id === 2)!.result.tools!.length, 6, 'fake gateway has no platform tools: bridge tools only')

  const status = run('status')
  assert.equal(status.status, 0, status.stdout + status.stderr)

  const un = run('uninstall')
  assert.equal(un.status, 0, un.stderr)
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), OTHER)
  assert.ok(!existsSync(app))
})
