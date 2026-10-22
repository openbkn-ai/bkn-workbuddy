// Live end-to-end check of bridge + gateway against a real OpenBKN, simulating
// WorkBuddy: the MCP server is driven over stdio with WorkBuddy `_meta`, and the
// UserPromptSubmit / Stop hooks are run as separate processes with a transcript file.
//
// The gateway is built with `-tags devstore`: the token comes from `openbkn auth token`,
// is passed only through the gateway process environment and is never written.
//
// Usage: node probes/e2e/bridge-live.mjs --origin https://<platform> [--ca <pem>] [--kn supply_ontology_hand]
// (or OPENBKN_E2E_ORIGIN / OPENBKN_E2E_CA; test-platform details are kept outside the public repository)
// The openbkn CLI must have an active session for the same platform (`openbkn auth use <origin>`).
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const opt = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback }
const ORIGIN = opt('--origin', process.env.OPENBKN_E2E_ORIGIN)
if (!ORIGIN) throw new Error('pass --origin https://<platform> (or set OPENBKN_E2E_ORIGIN)')
const caArg = opt('--ca', process.env.OPENBKN_E2E_CA)
const CA = caArg ? resolve(caArg) : undefined
const KN = opt('--kn', 'supply_ontology_hand')
const CLI = join(repo, 'packages/bridge/dist/src/cli.js')

const work = mkdtempSync(join(tmpdir(), 'bkn-e2e-'))
const gatewayBin = join(work, 'bkn-gateway-dev')
execFileSync('go', ['build', '-tags', 'devstore', '-o', gatewayBin, '.'], { cwd: join(repo, 'gateway'), stdio: 'inherit' })
const configDir = join(work, 'gateway-config')
execFileSync('mkdir', ['-p', configDir])
writeFileSync(join(configDir, 'gateway.json'), JSON.stringify({ origin: ORIGIN, businessDomain: 'bd_public', ...(CA ? { caFile: CA } : {}), hostKeySalt: randomBytes(16).toString('hex') }))

const token = execFileSync('openbkn', ['auth', 'token'], { encoding: 'utf8', env: { ...process.env, ...(CA ? { NODE_EXTRA_CA_CERTS: CA } : {}) } }).trim()
if (!token) throw new Error('openbkn auth token returned nothing; log in first')
const env = { ...process.env, BKN_WORKBUDDY_HOME: join(work, 'home'), BKN_GATEWAY_CONFIG_DIR: configDir, BKN_GATEWAY_DEV_TOKEN: token, BKN_GATEWAY_BIN: gatewayBin }

// ---- MCP client over stdio --------------------------------------------------
const bridge = spawn(process.execPath, [CLI, 'mcp', '--scene', join(repo, 'scenes/governed-business-analysis.v1.json')], { env, stdio: ['pipe', 'pipe', 'inherit'] })
const pending = new Map()
let nextId = 1
createInterface({ input: bridge.stdout }).on('line', line => {
  const msg = JSON.parse(line)
  pending.get(msg.id)?.(msg)
  pending.delete(msg.id)
})
const rpc = (method, params) => new Promise(res => { const id = nextId++; pending.set(id, res); bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
const TASK = randomUUID()
const call = async (turn, name, args = {}) => {
  const r = (await rpc('tools/call', { name, arguments: args, _meta: { 'workbuddy.ai/conversationId': TASK, 'workbuddy.ai/requestId': turn, 'workbuddy.ai/messageId': randomUUID() } })).result
  const text = r.content?.[0]?.text ?? ''
  let json; try { json = JSON.parse(text) } catch { json = text }
  return { isError: r.isError === true, json, size: text.length, last: r.content?.at(-1)?.text ?? '' }
}

// ---- hooks + transcript -----------------------------------------------------
const transcript = join(work, 'transcript.jsonl')
writeFileSync(transcript, JSON.stringify({ type: 'session-meta', id: 'm' }) + '\n')
const hook = (event, input) => {
  const r = spawnSync(process.execPath, [CLI, 'hook', event], { env, input: JSON.stringify({ session_id: TASK, generation_id: input.turn, transcript_path: transcript, ...input.extra }), encoding: 'utf8', timeout: 60_000 })
  if (r.status !== 0 || r.stdout) throw new Error(`hook ${event} exit ${r.status} stdout=${r.stdout}`)
}
const ask = (turn, question) => hook('UserPromptSubmit', { turn, extra: { prompt: question } })
const finish = (turn, answer, status = 'completed') => {
  appendFileSync(transcript, JSON.stringify({ type: 'message', role: 'user', id: `u-${turn}`, content: [{ type: 'input_text', text: 'wrapped' }] }) + '\n'
    + JSON.stringify({ type: 'message', role: 'assistant', id: `a-${turn}`, parentId: `u-${turn}`, status, content: [{ type: 'output_text', text: answer }] }) + '\n')
  hook('Stop', { turn, extra: { last_assistant_message: answer } })
}

/** The previous recorded turn as `openbkn_status` reports it (asked from turn `turn`). */
const previousTurn = async turn => (await call(turn, 'openbkn_status')).json.recent_turns?.find(t => t.turn === '上一轮')

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`) }

try {
  const init = (await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e' } })).result
  check('initialize', init.serverInfo?.name === 'openbkn-business-context')
  const tools = (await rpc('tools/list', {})).result.tools
  check('tools/list exposes 6 bridge + 8 read-v1 tools', tools.length === 14, tools.map(t => t.name).join(','))
  check('no managed arguments exposed', !tools.some(t => 'kn_id' in (t.inputSchema.properties ?? {}) || 'bkn_context' in (t.inputSchema.properties ?? {})))

  const status = await call('t0', 'openbkn_status')
  check('status connected', status.json.connected === true, JSON.stringify(status.json))

  // Turn 0: list the networks; selecting in the same turn without the user's confirmation is refused.
  ask('t0', '我能访问哪些知识网络？')
  const list = await call('t0', 'openbkn_list_networks')
  const target = list.json.networks?.find(n => n.name === KN || n.name.includes('供应链')) ?? list.json.networks?.[0]
  check('list networks', !list.isError && list.json.networks.length > 0, `${list.json.networks?.length} networks; target=${target?.name}`)
  const early = await call('t0', 'openbkn_select_network', { selection_key: target.selection_key })
  check('same-turn selection without confirmation refused', early.isError && early.json.error === 'CONFIRMATION_REQUIRED', JSON.stringify(early.json))
  finish('t0', '可以访问这些网络，请确认要用哪一个。')

  // Turn 1: the user confirms; select, ask, answer.
  ask('t1', '用供应链那个。有哪些业务对象？请说明销售订单相关的信息。')
  const sel = await call('t1', 'openbkn_select_network', { selection_key: target.selection_key })
  check('select network', !sel.isError, JSON.stringify(sel.json))
  const starters = await call('t1', 'openbkn_starters')
  check('starters', !starters.isError && starters.json.starters?.length > 0, JSON.stringify(starters.json.starters))
  const search = await call('t1', 'search_schema', { query: '销售订单' })
  check('search_schema through gateway', !search.isError, `${search.size} chars`)
  const injected = await call('t1', 'search_schema', { query: 'x', kn_id: 'other' })
  check('model-supplied kn_id refused', injected.isError && injected.json.error === 'BAD_ARGUMENTS')
  finish('t1', '供应链知识网络包含销售订单等业务对象。（E2E 自动回答）')
  const ev1 = await previousTurn('t2')
  check('turn 1 closed as completed on the platform', ev1?.diagnostics?.execution_status === 'completed' && ev1?.recorded_by === 'automatic', JSON.stringify(ev1))
  console.log(`INFO provenance link for turn 1: ${ev1?.provenance_url ?? 'none (platform offers no business provenance page)'}`)

  // Turn 2: no OpenBKN call.
  ask('t2b', '谢谢')
  finish('t2b', '不客气。')

  // Turn 3: cancelled.
  ask('t3', '查询销售订单')
  await call('t3', 'search_schema', { query: '订单' })
  finish('t3', '已取消', 'incomplete')
  const ev3 = await previousTurn('t4')
  check('turn 3 closed as cancelled', /cancel/.test(String(ev3?.diagnostics?.execution_status)), JSON.stringify(ev3?.diagnostics))

  // Turn 4 never stops; turn 5 must finish it (failed) and continue the conversation.
  ask('t4', '查询物料')
  await call('t4', 'search_schema', { query: '物料' })
  ask('t5', '再查一次物料')
  const t5 = await call('t5', 'query_object_instance', { ot_id: 'supply_ontology_hand_product', limit: 3 })
  check('turn after a missing Stop proceeds (instance query)', !t5.isError && t5.size > 0, t5.isError ? JSON.stringify(t5.json) : `${t5.size} chars`)
  console.log(`INFO note after a business result: ${t5.last.startsWith('【OpenBKN】') ? t5.last : 'none'}`)
  check('business result links the Studio provenance page (Enterprise)', /\/studio\/observability\/business-provenance\?conversation_id=/.test(t5.last), t5.last.slice(0, 200))
  finish('t5', '产品查询完成。（E2E）')
  await new Promise(r => setTimeout(r, 3000)) // business graph assembly is asynchronous
  const ev5 = await previousTurn('t6')
  check('turn 5 completed', ev5?.diagnostics?.execution_status === 'completed', JSON.stringify(ev5?.diagnostics))
  if ((ev5?.diagnostics?.business_refs ?? 0) === 0) {
    // Platform-side: the community test platform stays `assembling`; the enterprise one completes with 0 business refs (2026-10-19).
    console.log(`BLOCKED instance query yields business refs — platform evidence_status=${ev5?.diagnostics?.evidence_status} with 0 business refs`)
  } else {
    check('instance query yields business refs', ev5.diagnostics.business_refs > 0, JSON.stringify(ev5.diagnostics))
  }

  // Fallback tier: no hook reached turns m1/m2; the model opens and closes them.
  const m1 = await call('m1', 'search_schema', { query: '物料' })
  check('without a hook record the query asks to open the turn', m1.isError && m1.json.error === 'TURN_NOT_STARTED', JSON.stringify(m1.json))
  const begin = await call('m1', 'openbkn_begin_turn', { question: '有哪些物料相关的业务对象？' })
  check('model opens the turn', !begin.isError && begin.json.recording === 'model', JSON.stringify(begin.json))
  const m1b = await call('m1', 'search_schema', { query: '物料' })
  check('query proceeds in the model-opened turn', !m1b.isError, `${m1b.size} chars`)
  const end = await call('m1', 'openbkn_end_turn', { outcome: 'completed', answer: '物料相关的业务对象包括物料与库存。（E2E 模型档）' })
  check('model closes the turn with its answer', !end.isError && end.json.recorded === true, JSON.stringify(end.json))
  const evm = await previousTurn('m2')
  check('model-closed turn completed on the platform', evm?.diagnostics?.execution_status === 'completed' && evm?.recorded_by === 'model', JSON.stringify(evm))
} finally {
  bridge.stdin.end()
  await new Promise(r => bridge.once('exit', r))
}
const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed; work dir ${work}`)
process.exitCode = failed.length ? 1 : 0
