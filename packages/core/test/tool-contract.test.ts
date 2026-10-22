import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assertCatalogSupportsReadV1, buildPlatformArguments, catalogFingerprint, CatalogContractError,
  projectToolForModel, READ_V1_TOOLS, ToolArgumentError, type PlatformTool,
} from '../src/tool-contract.js'

// Real catalogue captured from the local deployment in R0a (internal evidence).
const snapshotPath = fileURLToPath(new URL('../../test/fixtures/mcp-tools-r0a.json', import.meta.url))
const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as { tools: PlatformTool[] }
const tools = snapshot.tools
const byName = (name: string) => tools.find(t => t.name === name)!
const ctx = { knId: 'kn_bound', bknContext: { conversation_id: 'conv_1', interaction_id: 'int_1' } }

test('the captured deployment satisfies read-v1', () => {
  assert.doesNotThrow(() => assertCatalogSupportsReadV1(tools))
  assert.equal(tools.length, 29)
})

test('missing tools and dropped managed arguments fail closed', () => {
  assert.throws(() => assertCatalogSupportsReadV1(tools.filter(t => t.name !== 'query_metric')), CatalogContractError)
  const broken = tools.map(t => t.name === 'search_schema'
    ? { ...t, inputSchema: { ...t.inputSchema, properties: { query: {} } } }
    : t)
  assert.throws(() => assertCatalogSupportsReadV1(broken), CatalogContractError)
})

test('fingerprint ignores key order and non-contract tools, but tracks schema changes', () => {
  const base = catalogFingerprint(tools)
  const reordered = [...tools].reverse().map(t => ({ ...t, inputSchema: Object.fromEntries(Object.entries(t.inputSchema).reverse()) }))
  assert.equal(catalogFingerprint(reordered), base)
  assert.equal(catalogFingerprint(tools.filter(t => t.name !== 'run_shell')), base)
  const changed = tools.map(t => t.name === 'query_metric' ? { ...t, inputSchema: { ...t.inputSchema, required: [] } } : t)
  assert.notEqual(catalogFingerprint(changed), base)
})

test('model-facing schemas hide kn_id, bkn_context and llm_model', () => {
  for (const name of READ_V1_TOOLS) {
    const projected = projectToolForModel(byName(name))
    const props = projected.inputSchema.properties as Record<string, unknown>
    assert.ok(!('kn_id' in props) && !('bkn_context' in props), name)
    assert.ok(!(projected.inputSchema.required as string[]).includes('kn_id'), name)
    assert.equal(projected.inputSchema.additionalProperties, false)
    assert.equal(projected.description, byName(name).description, 'platform description is kept')
  }
  assert.ok(!('llm_model' in (projectToolForModel(byName('get_logic_properties_values')).inputSchema.properties as object)))
  assert.throws(() => projectToolForModel(byName('run_code')), CatalogContractError)
})

test('arguments: managed fields are injected; model-supplied managed or unknown fields are rejected', () => {
  const tool = byName('query_object_instance')
  const args = buildPlatformArguments(tool, { ot_id: 'ot', limit: 5 }, ctx)
  assert.deepEqual(args, { ot_id: 'ot', limit: 5, kn_id: 'kn_bound', bkn_context: { conversation_id: 'conv_1', interaction_id: 'int_1' } })
  assert.throws(() => buildPlatformArguments(tool, { ot_id: 'ot', kn_id: 'other_kn' }, ctx), ToolArgumentError)
  assert.throws(() => buildPlatformArguments(tool, { ot_id: 'ot', bkn_context: {} }, ctx), ToolArgumentError)
  assert.throws(() => buildPlatformArguments(tool, { ot_id: 'ot', sql: 'select 1' }, ctx), ToolArgumentError)
  assert.throws(() => buildPlatformArguments(tool, {}, ctx), ToolArgumentError, 'ot_id is required')
  assert.throws(() => buildPlatformArguments(byName('run_sql'), { sql: 'x' }, ctx), ToolArgumentError)
  assert.throws(() => buildPlatformArguments(byName('get_logic_properties_values'), { llm_model: 'x' }, ctx), ToolArgumentError)
})
