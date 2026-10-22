// Protocol compatibility with the real Go gateway. Runs only when BKN_GATEWAY_BIN
// points at a built `bkn-gateway`. Uses a throwaway config dir and an unreachable
// origin: no credential is written and nothing reaches the network.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { GatewayCallError, GatewayClient } from '../src/gateway-client.js'

const bin = process.env.BKN_GATEWAY_BIN

test('real gateway: status, local policy refusal and missing credential', { skip: bin === undefined && 'BKN_GATEWAY_BIN not set' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bkn-gw-it-'))
  writeFileSync(join(dir, 'gateway.json'), JSON.stringify({ origin: 'https://gateway-protocol-test.invalid', businessDomain: 'bd_public', hostKeySalt: 'x' }))
  const c = new GatewayClient({ command: bin!, env: { BKN_GATEWAY_CONFIG_DIR: dir }, requestTimeoutMs: 20_000 })
  try {
    const status = await c.status()
    assert.equal(status.configured, true)
    assert.equal(status.origin, 'https://gateway-protocol-test.invalid')
    assert.equal(status.credential, false)
    const refused = await c.callTool('run_sql', { sql: 'select 1' }, { knowledgeNetworkId: 'k' }).catch((e: unknown) => e)
    assert.ok(refused instanceof GatewayCallError && refused.code === 'POLICY_REFUSED', String(refused))
    const noCredential = await c.catalogPage(0, 1).catch((e: unknown) => e)
    assert.ok(noCredential instanceof GatewayCallError && noCredential.code === 'AUTHENTICATION_REQUIRED', String(noCredential))
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('real gateway without configuration reports NOT_CONFIGURED', { skip: bin === undefined && 'BKN_GATEWAY_BIN not set' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bkn-gw-it-'))
  const c = new GatewayClient({ command: bin!, env: { BKN_GATEWAY_CONFIG_DIR: dir }, requestTimeoutMs: 20_000 })
  try {
    const err = await c.status().catch((e: unknown) => e)
    assert.ok(err instanceof GatewayCallError && err.code === 'NOT_CONFIGURED', String(err))
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
