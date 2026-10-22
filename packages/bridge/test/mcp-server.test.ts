import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runMcpServer } from '../src/mcp-server.js'
import { BridgeSession } from '../src/session.js'
import { TaskStore } from '../src/task-store.js'
import { ToolRouter } from '../src/tools.js'
import { FakePlatform } from './fake-platform.js'

async function exchange(messages: unknown[]): Promise<Record<string, unknown>[]> {
  const platform = new FakePlatform()
  const store = new TaskStore(join(mkdtempSync(join(tmpdir(), 'bkn-mcp-')), 'state'))
  const router = new ToolRouter(new BridgeSession(store, platform), platform, undefined)
  const input = new PassThrough()
  const output = new PassThrough()
  let text = ''
  output.on('data', chunk => { text += chunk })
  const done = runMcpServer(router, input, output)
  for (const m of messages) input.write(JSON.stringify(m) + '\n')
  input.write('garbage\n')
  input.end()
  await done
  return text.trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
}

test('MCP stdio: initialize, tools/list, tools/call with WorkBuddy _meta, unknown method, parse error', async () => {
  const replies = await exchange([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'workbuddy' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'openbkn_list_networks', arguments: {}, _meta: { 'workbuddy.ai/conversationId': 'c1', 'workbuddy.ai/requestId': 'r1' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'openbkn_list_networks', arguments: {} } },
    { jsonrpc: '2.0', id: 5, method: 'resources/list' },
  ])
  const byId = new Map(replies.map(r => [r.id, r]))
  const init = byId.get(1)!.result as Record<string, unknown>
  assert.equal(init.protocolVersion, '2025-03-26')
  assert.equal((init.serverInfo as { name: string }).name, 'openbkn-business-context')
  assert.equal(((byId.get(2)!.result as { tools: unknown[] }).tools).length, 14)
  const listed = JSON.parse(((byId.get(3)!.result as { content: { text: string }[] }).content[0]!.text)) as { networks: unknown[] }
  assert.equal(listed.networks.length, 2)
  const noMeta = byId.get(4)!.result as { isError: boolean; content: { text: string }[] }
  assert.equal(noMeta.isError, true)
  assert.match(noMeta.content[0]!.text, /HOST_CONTEXT_MISSING/)
  assert.equal((byId.get(5)!.error as { code: number }).code, -32601)
  assert.ok(replies.some(r => r.id === null && (r.error as { code: number }).code === -32700))
  assert.equal(replies.length, 6, 'notifications get no reply')
})

test('hook CLI exits 0 and prints nothing, even without a gateway or with bad input', () => {
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url))
  const home = mkdtempSync(join(tmpdir(), 'bkn-hook-'))
  for (const [event, input] of [
    ['UserPromptSubmit', JSON.stringify({ session_id: 's', generation_id: 'g', prompt: 'q' })],
    ['Stop', JSON.stringify({ session_id: 's', generation_id: 'g', last_assistant_message: 'a' })],
    ['Stop', 'not json'],
    ['Unknown', ''],
  ] as const) {
    const r = spawnSync(process.execPath, [cli, 'hook', event, '--gateway', join(home, 'missing-gateway')], {
      input, env: { ...process.env, BKN_WORKBUDDY_HOME: home }, encoding: 'utf8', timeout: 20_000,
    })
    assert.equal(r.status, 0, `${event}: ${r.stderr}`)
    assert.equal(r.stdout, '')
  }
})
