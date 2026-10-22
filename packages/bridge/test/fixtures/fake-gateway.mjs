// Test double for `bkn-gateway serve`: same line protocol, scripted behaviours.
import { createInterface } from 'node:readline'

if (process.env.FAKE_NOT_CONFIGURED === '1') {
  process.stderr.write('bkn-gateway: not configured; run login first (open gateway.json: no such file)\n')
  process.exit(1)
}

const send = obj => process.stdout.write(JSON.stringify(obj) + '\n')
createInterface({ input: process.stdin }).on('line', line => {
  const { id, op, params } = JSON.parse(line)
  switch (op) {
    case 'status': return send({ id, ok: true, result: { version: 'fake', configured: true, credential: true, pid: process.pid } })
    case 'echo': return send({ id, ok: true, result: params })
    case 'slow': return setTimeout(() => send({ id, ok: true, result: 'slow-done' }), params.ms)
    case 'hang': return undefined
    case 'crash': return process.exit(3)
    case 'garbage':
      process.stdout.write('this is not json\n')
      return send({ id, ok: true, result: 'after-garbage' })
    case 'error': return send({ id, ok: false, error: { code: 'FORBIDDEN', message: 'denied', httpStatus: 403, platformCode: 'permission_denied' } })
    default: return send({ id, ok: false, error: { code: 'BAD_REQUEST', message: 'unknown op' } })
  }
})
