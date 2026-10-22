import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bindTask, BindingConflictError, normalizeOrigin, type TaskBinding } from '../src/binding.js'
import { buildNetworkSelection, CatalogPagingError, collectVisibleBusinessNetworks, parseVisibleBusinessNetworks } from '../src/catalog.js'
import { classifyFailure, projectLifecycleOutcome } from '../src/lifecycle-outcome.js'
import { projectBusinessGraph, projectOperations } from '../src/provenance-projection.js'

const text = (o: unknown) => ({ type: 'text', text: JSON.stringify(o) })

test('catalog: parses entries, drops malformed and duplicate rows, prefers description over comment', () => {
  const nets = parseVisibleBusinessNetworks({ entries: [
    { id: 'a', name: ' A ', comment: 'c' }, { id: 'a', name: 'dup' }, { id: '', name: 'x' }, { id: 'b', name: 'B', description: 'd', comment: 'c' }, 'junk',
  ] })
  assert.deepEqual(nets, [{ id: 'a', displayName: 'A', description: 'c' }, { id: 'b', displayName: 'B', description: 'd' }])
  assert.throws(() => parseVisibleBusinessNetworks({ nope: [] }))
})

test('catalog: reads every page until total_count', async () => {
  const all = Array.from({ length: 5 }, (_, i) => ({ id: `kn${i}`, name: `N${i}` }))
  const seen: number[] = []
  const nets = await collectVisibleBusinessNetworks(async (offset, limit) => { seen.push(offset); return { entries: all.slice(offset, offset + limit), total_count: 5 } }, { pageSize: 2 })
  assert.equal(nets.length, 5)
  assert.deepEqual(seen, [0, 2, 4])
})

test('catalog: changing totals, missing totals and runaway paging fail closed', async () => {
  let n = 0
  await assert.rejects(collectVisibleBusinessNetworks(async () => ({ entries: [{ id: `k${n}`, name: 'x' }], total_count: 10 + n++ }), { pageSize: 1 }), CatalogPagingError)
  await assert.rejects(collectVisibleBusinessNetworks(async () => ({ entries: [] })), CatalogPagingError)
  await assert.rejects(collectVisibleBusinessNetworks(async o => ({ entries: [{ id: `k${o}`, name: 'x' }], total_count: 1000 }), { pageSize: 1, maxPages: 3 }), CatalogPagingError)
})

test('selection: opaque unique keys, duplicate names flagged, ids never in options', () => {
  let i = 0
  const keys = ['k1', 'k1', 'k2', 'k3']
  const sel = buildNetworkSelection([{ id: 'x', displayName: 'Supply' }, { id: 'y', displayName: 'Supply', description: 'EU' }, { id: 'z', displayName: 'Cup' }], () => keys[i++]!)
  assert.deepEqual(sel.options.map(o => o.key), ['k1', 'k2', 'k3'])
  assert.deepEqual(sel.options.map(o => o.duplicateName), [true, true, false])
  assert.ok(!JSON.stringify(sel.options).includes('"x"'))
  assert.equal(sel.keyToNetworkId.get('k2'), 'y')
})

const binding: TaskBinding = { hostTaskKey: 's1', platformOrigin: 'https://h.example/', businessDomain: 'bd_public', knowledgeNetworkId: 'kn', displayName: 'Supply' }

test('binding: first bind, repeat and conflict', () => {
  const first = bindTask(undefined, binding)
  assert.equal(first.kind, 'bound')
  assert.equal(first.binding.platformOrigin, 'https://h.example')
  assert.equal(bindTask(first.binding, binding).kind, 'already-bound')
  assert.throws(() => bindTask(first.binding, { ...binding, knowledgeNetworkId: 'other' }), BindingConflictError)
  assert.throws(() => bindTask(first.binding, { ...binding, businessDomain: 'bd_x' }), BindingConflictError)
  assert.throws(() => bindTask({ ...first.binding, principal: 'u1' }, { ...binding, principal: 'u2' }), BindingConflictError)
})

test('origin: https only, http on loopback, no credentials', () => {
  assert.equal(normalizeOrigin('https://openbkn-ee.example.test/api/x'), 'https://openbkn-ee.example.test')
  assert.equal(normalizeOrigin('http://127.0.0.1:8080'), 'http://127.0.0.1:8080')
  assert.throws(() => normalizeOrigin('http://openbkn-ee.example.test'))
  assert.throws(() => normalizeOrigin('https://user:pw@h.example'))
})

test('lifecycle: projections of the payloads observed in R0a', () => {
  assert.deepEqual(projectLifecycleOutcome({ isError: false, content: [text({ interaction_id: 'int_1', conversation_id: 'conv_1', execution_status: 'active' })] }),
    { interactionId: 'int_1', conversationId: 'conv_1', executionStatus: 'active' })
  const invalid = projectLifecycleOutcome({ isError: true, content: [text({ error: { code: 'resource_not_disclosed', retryable: false } })] })
  assert.equal(classifyFailure(invalid), 'conversation-invalid')
  const inProgress = projectLifecycleOutcome({ isError: true, content: [text({ error: { code: 'interaction_in_progress', current_interaction_id: 'int_9', current_status: 'active' } })] })
  assert.deepEqual(inProgress, { errorCode: 'interaction_in_progress', currentInteractionId: 'int_9', currentStatus: 'active' })
  assert.equal(classifyFailure(inProgress), 'other')
  assert.deepEqual(projectLifecycleOutcome({ isError: true, error: { message: 'timeout' } }), {})
})

test('provenance: operations and business graph are bounded projections', () => {
  const ops = projectOperations({ entries: [{ operation_id: 'op1', tool_name: 'query_metric', status: 'completed', receipt_id: 'r1', secret_args: 'x' }, { tool_name: 'no id' }], total: 2 })
  assert.deepEqual(ops, { entries: [{ operationId: 'op1', toolName: 'query_metric', status: 'completed', receiptId: 'r1' }], total: 2 })
  const graph = projectBusinessGraph({
    interaction_id: 'int_1', evidence_status: 'complete',
    assembly: { business_refs: [{ technical_ref: { ref_id: 'ot', ref_type: 'object_type' }, display: { name: '销售订单', resolution_status: 'resolved' } }, { technical_ref: { ref_id: 'x' } }],
      operation_business_edges: [{ operation_id: 'op1', role: 'read', business_ref: { technical_ref: { ref_id: 'ot', ref_type: 'object_type' }, display: { name: '销售订单' } } }] },
  })
  assert.equal(graph.businessRefs.length, 1)
  assert.equal(graph.businessRefs[0]?.name, '销售订单')
  assert.equal(graph.edges[0]?.role, 'read')
  assert.deepEqual(projectBusinessGraph({}).businessRefs, [])
})
