import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { handleHook } from '../src/hook.js'
import { BridgeSession } from '../src/session.js'
import { TaskStore } from '../src/task-store.js'
import { BRIDGE_TOOLS, ToolRouter } from '../src/tools.js'
import { FakePlatform } from './fake-platform.js'

const TASK = 'task-1'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'bkn-bridge-'))
  const platform = new FakePlatform()
  const store = new TaskStore(join(dir, 'state'))
  const session = new BridgeSession(store, platform)
  const router = new ToolRouter(session, platform, undefined)
  const transcript = join(dir, 'transcript.jsonl')
  writeFileSync(transcript, '')
  return { dir, platform, store, session, router, transcript }
}

type Env = ReturnType<typeof setup>

/** Simulate WorkBuddy: UserPromptSubmit hook, then the answer written to the transcript, then Stop. */
async function prompt(env: Env, turn: string, question: string) {
  appendLines(env.transcript, [{ type: 'message', role: 'user', id: `u-${turn}`, content: [{ type: 'input_text', text: `<wrapped>${question}</wrapped>` }] }].slice(0, 0))
  return handleHook('UserPromptSubmit', JSON.stringify({ session_id: TASK, generation_id: turn, prompt: question, transcript_path: env.transcript }), hookDeps(env))
}
async function stop(env: Env, turn: string, answer: string, status: 'completed' | 'incomplete' = 'completed') {
  appendLines(env.transcript, [
    { type: 'message', role: 'user', id: `u-${turn}`, content: [{ type: 'input_text', text: 'wrapped' }] },
    { type: 'message', role: 'assistant', id: `a-${turn}`, parentId: `u-${turn}`, status, content: [{ type: 'output_text', text: answer }] },
  ])
  return handleHook('Stop', JSON.stringify({ session_id: TASK, generation_id: turn, transcript_path: env.transcript, last_assistant_message: answer }), hookDeps(env))
}
function hookDeps(env: Env) {
  return { session: env.session, hasTask: (k: string) => env.store.exists(k), retries: 1, retryDelayMs: 5 }
}
function appendLines(file: string, records: unknown[]) {
  writeFileSync(file, readFileSync(file, 'utf8') + records.map(r => JSON.stringify(r) + '\n').join(''))
}
function payload(result: { content?: readonly { text?: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content?.[0]?.text ?? '{}') as Record<string, unknown>
}
const host = (turn: string) => ({ taskKey: TASK, turnKey: turn })

/** The list is shown in an earlier turn, so the user has had the chance to choose. */
async function bind(env: Env, name = '供应链') {
  const listed = payload(await env.router.call('openbkn_list_networks', {}, host('t-list')))
  const networks = listed.networks as { selection_key: string; name: string }[]
  const key = networks.find(n => n.name === name)!.selection_key
  return payload(await env.router.call('openbkn_select_network', { selection_key: key }, host('t0')))
}

test('tools/list: bridge tools plus read-v1 tools without managed arguments', async () => {
  const env = setup()
  const tools = await env.router.list()
  assert.equal(tools.length, BRIDGE_TOOLS.length + 8)
  const q = tools.find(t => t.name === 'query_object_instance')!
  const props = Object.keys(q.inputSchema.properties as object)
  assert.ok(!props.includes('kn_id') && !props.includes('bkn_context'))
  assert.ok(!tools.some(t => t.name.startsWith('bkn_') || t.name === 'run_sql'))
})

test('tools/list withholds business tools when the platform contract changed', async () => {
  const env = setup()
  const tool = env.platform.toolCatalog.find(t => (t as { name: string }).name === 'query_object_instance') as { inputSchema: { properties: Record<string, unknown> } }
  tool.inputSchema.properties.extra = { type: 'string' }
  assert.equal((await env.router.list()).length, BRIDGE_TOOLS.length)
  await env.session.recordPrompt(TASK, 't1', 'q', 0)
  const r = await env.router.call('query_object_instance', { ot_id: 'x' }, host('t1'))
  assert.equal(payload(r).error, 'CONTRACT_MISMATCH')
  assert.equal(env.platform.started().length, 0)
})

test('a business turn: lazy start with the user question, injected scope, finish with the real answer', async () => {
  const env = setup()
  assert.equal(await prompt(env, 't1', '有多少销售订单？'), 'recorded')
  assert.equal((await bind(env)).network, '供应链')
  assert.equal(env.platform.started().length, 0, 'binding alone must not start an Interaction')

  const r1 = await env.router.call('query_object_instance', { ot_id: 'sales_order', limit: 5 }, host('t1'))
  assert.ok(!r1.isError, JSON.stringify(r1))
  await env.router.call('query_object_instance', { ot_id: 'sales_order' }, host('t1'))
  const [start] = env.platform.started()
  assert.equal(env.platform.started().length, 1, 'one Interaction per turn')
  assert.deepEqual(start!.args, { conversation_mode: 'new', question: '有多少销售订单？', agent_name: 'bkn-agent-workbuddy' })
  const business = env.platform.calls.filter(c => c.tool === 'query_object_instance')
  assert.equal(business[0]!.args.kn_id, 'kn_supply')
  assert.deepEqual(business[0]!.args.bkn_context, { conversation_id: 'conv_1', interaction_id: 'int_2' })
  assert.equal(business[0]!.managed.hostTaskKey, TASK)

  assert.equal(await stop(env, 't1', '共有 3 个销售订单。'), 'closed')
  const [finish] = env.platform.finished()
  assert.deepEqual(finish!.args, { interaction_id: 'int_2', outcome: 'completed', answer: '共有 3 个销售订单。' })
  const saved = readFileSync(env.store.fileOf(TASK), 'utf8')
  assert.ok(!saved.includes('销售订单') && !saved.includes('共有 3'), 'question and answer are dropped once closed')

  const turns = payload(await env.router.call('openbkn_status', {}, host('t2'))).recent_turns as Record<string, any>[]
  assert.equal(turns.length, 1)
  assert.equal(turns[0]!.turn, '上一轮')
  assert.equal(turns[0]!.recorded_by, 'automatic')
  assert.deepEqual(turns[0]!.diagnostics, { interaction_id: 'int_2', local_phase: 'closed', execution_status: 'completed', evidence_status: 'complete', business_refs: 1 })
  assert.match(String(turns[0]!.provenance_url), /\/studio\/observability\/business-provenance\?conversation_id=conv_1&interaction_id=int_2$/)
})

test('turns without OpenBKN calls create no Interaction; cancelled turns finish as cancelled', async () => {
  const env = setup()
  await prompt(env, 't1', '你好')
  await bind(env)
  assert.equal(await stop(env, 't1', '你好！'), 'no-business')
  await prompt(env, 't2', '查订单')
  await env.router.call('query_object_instance', { ot_id: 'sales_order' }, host('t2'))
  assert.equal(await stop(env, 't2', '已取消', 'incomplete'), 'closed')
  assert.equal(env.platform.started().length, 1)
  assert.equal(env.platform.finished()[0]!.args.outcome, 'cancelled')
})

test('a turn that never stopped is finished as failed before the next turn starts with continue', async () => {
  const env = setup()
  await prompt(env, 't1', '查订单')
  await bind(env)
  await env.router.call('query_object_instance', { ot_id: 'sales_order' }, host('t1'))
  await prompt(env, 't2', '再查一次') // WorkBuddy quit before Stop of t1
  const r = await env.router.call('query_object_instance', { ot_id: 'sales_order' }, host('t2'))
  assert.ok(!r.isError, JSON.stringify(r))
  const [first, second] = env.platform.started()
  assert.equal(env.platform.finished()[0]!.args.outcome, 'failed')
  assert.equal(second!.args.conversation_mode, 'continue')
  assert.equal(second!.args.conversation_id, first && 'conv_1')
})

test('finish failure keeps the turn pending, blocks the next start, and is retried', async () => {
  const env = setup()
  await prompt(env, 't1', '查订单')
  await bind(env)
  await env.router.call('query_object_instance', { ot_id: 'sales_order' }, host('t1'))
  env.platform.failFinish = 2
  assert.equal(await stop(env, 't1', '答案'), 'close-failed')
  await prompt(env, 't2', '继续')
  const blocked = await env.router.call('query_object_instance', { ot_id: 'sales_order' }, host('t2'))
  assert.equal(payload(blocked).error, 'PREVIOUS_TURN_OPEN')
  const ok = await env.router.call('query_object_instance', { ot_id: 'sales_order' }, host('t2'))
  assert.ok(!ok.isError, JSON.stringify(ok))
  const finishes = env.platform.finished()
  assert.equal(finishes.at(-1)!.args.outcome, 'completed', 'the retried close still carries the real answer')
  assert.equal(finishes.at(-1)!.args.answer, '答案')
})

test('an invalidated conversation is replaced by one new conversation', async () => {
  const env = setup()
  await prompt(env, 't1', 'q1')
  await bind(env)
  await env.router.call('query_object_instance', { ot_id: 'a' }, host('t1'))
  await stop(env, 't1', 'a1')
  env.platform.invalidConversations.add('conv_1')
  await prompt(env, 't2', 'q2')
  const r = await env.router.call('query_object_instance', { ot_id: 'a' }, host('t2'))
  assert.ok(!r.isError, JSON.stringify(r))
  const starts = env.platform.started().map(c => c.args.conversation_mode)
  assert.deepEqual(starts, ['new', 'continue', 'new'])
})

test('refusals: unbound task, unknown turn, managed or unknown arguments, missing host context', async () => {
  const env = setup()
  await prompt(env, 't1', 'q')
  assert.equal(payload(await env.router.call('query_object_instance', { ot_id: 'a' }, host('t1'))).error, 'NOT_BOUND')
  await bind(env)
  const notStarted = payload(await env.router.call('query_object_instance', { ot_id: 'a' }, host('t-unknown')))
  assert.equal(notStarted.error, 'TURN_NOT_STARTED')
  assert.equal(notStarted.answer_rule, undefined, 'a step request, not a failure to report')
  assert.equal(payload(await env.router.call('query_object_instance', { ot_id: 'a', kn_id: 'kn_world' }, host('t1'))).error, 'BAD_ARGUMENTS')
  assert.equal(payload(await env.router.call('query_object_instance', { ot_id: 'a', sql: 'x' }, host('t1'))).error, 'BAD_ARGUMENTS')
  assert.equal(payload(await env.router.call('run_sql', { sql: 'select 1' }, host('t1'))).error, 'BAD_ARGUMENTS')
  assert.equal(payload(await env.router.call('query_object_instance', { ot_id: 'a' }, { turnKey: 't1' })).error, 'HOST_CONTEXT_MISSING')
  assert.equal(env.platform.started().length, 0, 'no refusal may create platform records')
})

test('binding is once per task; switching networks needs a new task; stale keys are refused', async () => {
  const env = setup()
  await bind(env, '供应链')
  const again = payload(await env.router.call('openbkn_list_networks', {}, host('t0'))).networks as { selection_key: string; name: string }[]
  const other = again.find(n => n.name === '世界杯')!.selection_key
  assert.equal(payload(await env.router.call('openbkn_select_network', { selection_key: other }, host('t0'))).error, 'BINDING_CONFLICT')
  assert.equal(payload(await env.router.call('openbkn_select_network', { selection_key: 'nope' }, host('t0'))).error, 'SELECTION_UNKNOWN')
  const status = payload(await env.router.call('openbkn_status', {}, host('t0')))
  assert.equal(status.network, '供应链')
  assert.equal(status.connected, true)
})

test('a network that disappeared from the catalogue cannot be selected', async () => {
  const env = setup()
  const listed = payload(await env.router.call('openbkn_list_networks', {}, host('t-list'))).networks as { selection_key: string; name: string }[]
  env.platform.networks = env.platform.networks.filter(n => n.id !== 'kn_supply')
  const key = listed.find(n => n.name === '供应链')!.selection_key
  assert.equal(payload(await env.router.call('openbkn_select_network', { selection_key: key }, host('t0'))).error, 'NETWORK_NOT_VISIBLE')
})

test('the user chooses the network: same-turn selection needs the name in the question', async () => {
  const env = setup()
  await prompt(env, 'q1', '382-000005 有多少张销售订单？')
  const keyOf = async (turn: string) => (payload(await env.router.call('openbkn_list_networks', {}, host(turn))).networks as { selection_key: string; name: string }[]).find(n => n.name === '供应链')!.selection_key
  const refused = payload(await env.router.call('openbkn_select_network', { selection_key: await keyOf('q1') }, host('q1')))
  assert.equal(refused.error, 'CONFIRMATION_REQUIRED')
  assert.equal(payload(await env.router.call('openbkn_status', {}, host('q1'))).network, undefined)
  // The user's reply in the next turn confirms it.
  await prompt(env, 'q2', '用第一个')
  assert.equal(payload(await env.router.call('openbkn_select_network', { selection_key: await keyOf('q1') }, host('q2'))).network, '供应链')
  // A question that names the network may select within its own turn.
  const other = setup()
  await prompt(other, 'n1', '用 供应链 网络，382-000005 有多少张销售订单？')
  const k = (payload(await other.router.call('openbkn_list_networks', {}, host('n1'))).networks as { selection_key: string; name: string }[]).find(n => n.name === '供应链')!.selection_key
  assert.equal(payload(await other.router.call('openbkn_select_network', { selection_key: k }, host('n1'))).network, '供应链')
})

test('business results link the Studio provenance page where the platform offers it; failures forbid earlier data', async () => {
  const env = setup()
  await bind(env)
  await prompt(env, 't1', '382-000005 有多少张销售订单？')
  const ok = await env.router.call('query_object_instance', { ot_id: 'sales_order' }, host('t1'))
  const note = ok.content!.at(-1)!.text!
  assert.match(note, /business-provenance\?conversation_id=conv_1&interaction_id=int_2/)
  assert.doesNotMatch(note, /openbkn_end_turn/, 'hook-recorded turns need no model close')
  const community = setup()
  community.platform.businessProvenance = false
  await bind(community)
  await prompt(community, 't1', 'q')
  const plain = await community.router.call('query_object_instance', { ot_id: 'sales_order' }, host('t1'))
  assert.equal(plain.content!.some(c => /business-provenance/.test(c.text ?? '')), false, 'no link without the page')
  env.platform.configured = false
  const failed = payload(await env.router.call('query_object_instance', { ot_id: 'sales_order' }, host('t1')))
  assert.equal(failed.error, 'NOT_CONFIGURED')
  assert.match(String(failed.answer_rule), /不要用之前对话/)
})

test('without hooks the model opens and closes the turn (fallback tier)', async () => {
  const env = setup()
  await bind(env)
  // No UserPromptSubmit reached turn m1: the query asks the model to open the turn first.
  assert.equal(payload(await env.router.call('query_object_instance', { ot_id: 'sales_order' }, host('m1'))).error, 'TURN_NOT_STARTED')
  assert.equal(env.platform.started().length, 0)
  assert.equal(payload(await env.router.call('openbkn_begin_turn', { question: '有多少销售订单？' }, host('m1'))).recording, 'model')
  const r = await env.router.call('query_object_instance', { ot_id: 'sales_order' }, host('m1'))
  assert.ok(!r.isError, JSON.stringify(r))
  assert.match(r.content!.at(-1)!.text!, /openbkn_end_turn/)
  assert.equal(env.platform.started()[0]!.args.question, '有多少销售订单？')
  // A Stop hook does not settle a model-opened turn.
  assert.equal(await stop(env, 'm1', 'ignored'), 'unchanged')
  assert.equal(payload(await env.router.call('openbkn_end_turn', { outcome: 'completed' }, host('m1'))).error, 'BAD_ARGUMENTS')
  assert.equal(payload(await env.router.call('openbkn_end_turn', { outcome: 'completed', answer: '共有 3 个。' }, host('m1'))).recorded, true)
  assert.deepEqual(env.platform.finished()[0]!.args, { interaction_id: 'int_2', outcome: 'completed', answer: '共有 3 个。' })

  // A model that forgets to close: the next turn finishes it as failed before starting.
  await env.router.call('openbkn_begin_turn', { question: '再查一次' }, host('m2'))
  await env.router.call('query_object_instance', { ot_id: 'sales_order' }, host('m2'))
  await env.router.call('openbkn_begin_turn', { question: '第三次' }, host('m3'))
  await env.router.call('query_object_instance', { ot_id: 'sales_order' }, host('m3'))
  assert.equal(env.platform.finished()[1]!.args.outcome, 'failed')
  assert.equal(env.platform.started().length, 3)

  // Explicit failure, and hook-recorded turns stay hook-managed.
  assert.equal(payload(await env.router.call('openbkn_end_turn', { outcome: 'failed' }, host('m3'))).recorded, true)
  assert.equal(env.platform.finished()[2]!.args.outcome, 'failed')
  await prompt(env, 'h1', '钩子记录的一轮')
  assert.equal(payload(await env.router.call('openbkn_begin_turn', { question: 'x' }, host('h1'))).recording, 'automatic')
})

test('not connected: status explains it and business calls do not reach the platform', async () => {
  const env = setup()
  env.platform.configured = false
  const s = payload(await env.router.call('openbkn_status', {}, host('t0')))
  assert.equal(s.connected, false)
  assert.match(String(s.message), /还没有连接/)
  const r = payload(await env.router.call('openbkn_list_networks', {}, host('t0')))
  assert.ok(r.error)
})

test('Stop for tasks the bridge never saw does nothing; duplicate prompts are recorded once', async () => {
  const env = setup()
  const out = await handleHook('Stop', JSON.stringify({ session_id: 'other', generation_id: 'g', transcript_path: env.transcript }), hookDeps(env))
  assert.equal(out, 'no-task')
  assert.equal(readdirSync(env.dir).includes('state'), false)
  assert.equal(await prompt(env, 't1', 'q'), 'recorded')
  assert.equal(await prompt(env, 't1', 'q'), 'skipped')
  assert.equal(await handleHook('UserPromptSubmit', 'not json', hookDeps(env)), 'bad-input')
})

test('concurrent processes updating one task do not lose writes', async () => {
  const env = setup()
  await Promise.all(Array.from({ length: 15 }, (_, i) => env.session.recordPrompt(TASK, `t${i}`, `q${i}`, 0)))
  assert.equal(env.store.read(TASK)!.turns.length, 15)
})
