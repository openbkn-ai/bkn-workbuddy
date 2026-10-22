// `read-v1` tool contract (decision D1, narrow read-only allowlist) against the
// OpenBKN Context Loader MCP catalogue captured in R0a (29 tools, no
// toolkit_version, empty annotations). The model sees the platform's own tool
// descriptions with managed fields removed; the adapter injects them per call.
import { createHash } from 'node:crypto'
import { canonicalJson, isRecord } from './json.js'

export const CONTRACT_VERSION = 'read-v1'

/** Business tools exposed to the model in P0 (D1). */
export const READ_V1_TOOLS = [
  'get_kn_detail',
  'search_schema',
  'get_object_types',
  'get_relation_types',
  'query_object_instance',
  'query_instance_subgraph',
  'query_metric',
  'get_logic_properties_values',
] as const

/** Managed by the adapter, never exposed to the model. */
export const LIFECYCLE_TOOLS = ['bkn_start_interaction', 'bkn_finish_interaction'] as const

export type ReadV1Tool = typeof READ_V1_TOOLS[number]

/** Top-level arguments the adapter owns; a model-supplied value is rejected, not overwritten. */
const MANAGED_ARGUMENTS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  READ_V1_TOOLS.map(name => [name, name === 'get_logic_properties_values' ? ['kn_id', 'bkn_context', 'llm_model'] : ['kn_id', 'bkn_context']]),
)

export interface PlatformTool {
  readonly name: string
  readonly title?: string
  readonly description?: string
  readonly inputSchema: Record<string, unknown>
}

export function isReadV1Tool(name: string): name is ReadV1Tool {
  return (READ_V1_TOOLS as readonly string[]).includes(name)
}

export function managedArgumentsOf(name: ReadV1Tool): readonly string[] {
  return MANAGED_ARGUMENTS[name] ?? []
}

/**
 * Fingerprint of the allowlisted tools' names and input schemas, independent of
 * key order. A deployment whose fingerprint differs from the reviewed one fails
 * closed until the change is reviewed (the platform exposes no toolkit version).
 */
export function catalogFingerprint(tools: readonly PlatformTool[]): string {
  const relevant = tools
    .filter(t => isReadV1Tool(t.name) || (LIFECYCLE_TOOLS as readonly string[]).includes(t.name))
    .map(t => ({ name: t.name, inputSchema: t.inputSchema }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return createHash('sha256').update(canonicalJson(relevant)).digest('hex')
}

export class CatalogContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CatalogContractError'
  }
}

/** Every read-v1 and lifecycle tool must exist, and every read-v1 tool must accept kn_id and bkn_context. */
export function assertCatalogSupportsReadV1(tools: readonly PlatformTool[]): void {
  const byName = new Map(tools.map(t => [t.name, t]))
  for (const name of [...READ_V1_TOOLS, ...LIFECYCLE_TOOLS]) {
    if (!byName.has(name)) throw new CatalogContractError(`OpenBKN deployment lacks required tool "${name}".`)
  }
  for (const name of READ_V1_TOOLS) {
    const props = propertiesOf(byName.get(name)!.inputSchema)
    for (const key of ['kn_id', 'bkn_context']) {
      if (!(key in props)) throw new CatalogContractError(`OpenBKN tool "${name}" no longer accepts "${key}".`)
    }
  }
}

/** The tool as the model sees it: platform schema and description, managed arguments removed. */
export function projectToolForModel(tool: PlatformTool): PlatformTool {
  if (!isReadV1Tool(tool.name)) throw new CatalogContractError(`tool "${tool.name}" is not in ${CONTRACT_VERSION}`)
  const hidden = new Set(managedArgumentsOf(tool.name))
  const props = propertiesOf(tool.inputSchema)
  const required = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required.filter((k): k is string => typeof k === 'string') : []
  const inputSchema: Record<string, unknown> = {
    ...tool.inputSchema,
    properties: Object.fromEntries(Object.entries(props).filter(([k]) => !hidden.has(k))),
    required: required.filter(k => !hidden.has(k)),
    additionalProperties: false,
  }
  return { ...tool, inputSchema }
}

export class ToolArgumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolArgumentError'
  }
}

/**
 * Validate model-supplied top-level arguments against the projected schema and add
 * the managed ones. Managed keys supplied by the model, and unknown keys, are
 * rejected; nested values are left to the platform's own validation.
 */
export function buildPlatformArguments(
  tool: PlatformTool,
  modelArgs: unknown,
  managed: { readonly knId: string; readonly bknContext: { readonly conversation_id: string; readonly interaction_id: string } },
): Record<string, unknown> {
  if (!isReadV1Tool(tool.name)) throw new ToolArgumentError(`tool "${tool.name}" is not in ${CONTRACT_VERSION}`)
  const args = modelArgs === undefined ? {} : modelArgs
  if (!isRecord(args)) throw new ToolArgumentError('tool arguments must be an object')
  const hidden = managedArgumentsOf(tool.name)
  const allowed = new Set(Object.keys(propertiesOf(tool.inputSchema)).filter(k => !hidden.includes(k)))
  for (const key of Object.keys(args)) {
    if (hidden.includes(key)) throw new ToolArgumentError(`"${key}" is managed by the adapter and must not be supplied`)
    if (!allowed.has(key)) throw new ToolArgumentError(`unknown argument "${key}" for ${tool.name}`)
  }
  const required = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required : []
  for (const key of required) {
    if (typeof key === 'string' && !hidden.includes(key) && !(key in args)) throw new ToolArgumentError(`missing required argument "${key}" for ${tool.name}`)
  }
  return { ...args, kn_id: managed.knId, bkn_context: { conversation_id: managed.bknContext.conversation_id, interaction_id: managed.bknContext.interaction_id } }
}

function propertiesOf(schema: Record<string, unknown>): Record<string, unknown> {
  return isRecord(schema.properties) ? schema.properties : {}
}
