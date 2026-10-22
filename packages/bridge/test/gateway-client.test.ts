import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { GatewayCallError, GatewayClient } from '../src/gateway-client.js'
import { userStateOf } from '../src/user-state.js'

// Compiled tests run from dist/test; the fixture stays in the source tree.
const fake = fileURLToPath(new URL('../../test/fixtures/fake-gateway.mjs', import.meta.url))
const client = (env: Record<string, string> = {}, requestTimeoutMs = 5000) =>
  new GatewayClient({ command: process.execPath, args: [fake], env, requestTimeoutMs })

const rejectsWith = async (p: Promise<unknown>, code: string) => {
  await assert.rejects(p, (e: unknown) => e instanceof GatewayCallError && e.code === code)
}

test('round trip and out-of-order responses are matched by id', async () => {
  const c = client()
  try {
    const status = await c.status()
    assert.equal(status.configured, true)
    const [slow, fast] = await Promise.all([c.request('slow', { ms: 150 }), c.request('echo', { n: 1 })])
    assert.equal(slow, 'slow-done')
    assert.deepEqual(fast, { n: 1 })
  } finally { await c.close() }
})

test('gateway errors keep code, HTTP status and platform code, and map to a user state', async () => {
  const c = client()
  try {
    const err = await c.request('error').catch((e: unknown) => e)
    assert.ok(err instanceof GatewayCallError)
    assert.equal(err.code, 'FORBIDDEN')
    assert.equal(err.httpStatus, 403)
    assert.equal(err.platformCode, 'permission_denied')
    assert.equal(userStateOf(err).nextStep, 'contact-admin')
  } finally { await c.close() }
})

test('non-JSON output lines are ignored', async () => {
  const c = client()
  try { assert.equal(await c.request('garbage'), 'after-garbage') } finally { await c.close() }
})

test('timeout rejects all pending requests, restarts the gateway, and later requests work', async () => {
  const c = client({}, 300)
  try {
    const before = await c.status() as unknown as { pid: number }
    const hung = c.request('hang')
    const queued = c.request('slow', { ms: 1000 })
    await rejectsWith(hung, 'GATEWAY_TIMEOUT')
    await rejectsWith(queued, 'GATEWAY_TIMEOUT')
    const after = await c.status() as unknown as { pid: number }
    assert.notEqual(after.pid, before.pid, 'a new gateway process serves later requests')
  } finally { await c.close() }
})

test('a crashing gateway fails pending requests and is restarted on the next request', async () => {
  const c = client()
  try {
    await rejectsWith(c.request('crash'), 'GATEWAY_EXITED')
    assert.equal((await c.status()).configured, true)
  } finally { await c.close() }
})

test('an unconfigured gateway is reported as NOT_CONFIGURED with a reconnect step', async () => {
  const c = client({ FAKE_NOT_CONFIGURED: '1' })
  try {
    const err = await c.status().catch((e: unknown) => e)
    assert.ok(err instanceof GatewayCallError && err.code === 'NOT_CONFIGURED')
    assert.equal(userStateOf(err).nextStep, 'reconnect')
    assert.match(c.diagnostics(), /not configured/)
  } finally { await c.close() }
})

test('a missing gateway executable is GATEWAY_UNAVAILABLE', async () => {
  const c = new GatewayClient({ command: '/nonexistent/bkn-gateway', requestTimeoutMs: 2000 })
  try { await rejectsWith(c.status(), 'GATEWAY_UNAVAILABLE') } finally { await c.close() }
})

test('a closed client refuses new requests', async () => {
  const c = client()
  await c.status()
  await c.close()
  await rejectsWith(c.status(), 'GATEWAY_UNAVAILABLE')
})

test('every documented code has a Chinese message; unknown codes fall back safely', () => {
  for (const code of ['AUTHENTICATION_REQUIRED', 'PLATFORM_UNAVAILABLE', 'FORBIDDEN', 'NOT_DISCLOSED', 'OUTPUT_OVERFLOW', 'POLICY_REFUSED', 'GATEWAY_TIMEOUT', 'GATEWAY_EXITED']) {
    const s = userStateOf(new GatewayCallError(code, 'x'))
    assert.ok(/[一-鿿]/.test(s.message), code)
  }
  assert.equal(userStateOf(new Error('boom')).code, 'INTERNAL')
  assert.equal(userStateOf(new GatewayCallError('SOMETHING_NEW', 'x')).nextStep, 'contact-admin')
})
