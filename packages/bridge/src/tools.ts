// The tool surface the WorkBuddy model sees: six bridge tools plus the read-v1
// platform tools, passed through with their platform descriptions and with the
// managed arguments (kn_id, bkn_context, …) removed (TECHNICAL_PLAN §4 item 5).
import {
  assertCatalogSupportsReadV1, buildPlatformArguments, catalogFingerprint, isReadV1Tool, isRecord, projectToolForModel,
  renderStarters, type Capability, type PlatformTool, type ScenePack,
} from '@bkn-workbuddy/core'
import { GatewayCallError, type McpToolResult } from './gateway-client.js'
import { BridgeError, type ActiveTurn, type BridgeSession, type GatewayPort } from './session.js'
import { userStateOf } from './user-state.js'

export interface McpTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly annotations?: Record<string, unknown>
}

/** WorkBuddy identifiers from `tools/call` `_meta` (R0b): task and turn. */
export interface HostContext {
  readonly taskKey?: string
  readonly turnKey?: string
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: false }
/** Records the turn on OpenBKN; touches no business data. */
const LIFECYCLE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }

export const BRIDGE_TOOLS: readonly McpTool[] = [
  {
    name: 'openbkn_status',
    description: '检查 OpenBKN 连接状态，以及本任务当前使用的知识网络。连接或查询出错时先调用它。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: 'openbkn_list_networks',
    description: '列出当前账号在 OpenBKN 中可访问的企业业务知识网络（名称与简介）及每项的 selection_key。用户问到企业业务数据（例如订单、库存、采购、物料、交期、BOM、客户、供应商、经营指标），或提到 OpenBKN、知识网络，而本任务还没有选择网络时，先调用它，不要先问用户数据在哪里。不要向用户展示 selection_key。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: 'openbkn_select_network',
    description: '按 openbkn_list_networks 返回的 selection_key 为本任务选定一个知识网络。一个任务只能使用一个网络。必须由用户确认：用户本轮已经说出网络名称，或者你已把网络列表告诉用户、用户回复之后才能调用；即使只有一个网络也要先问。名称重复时先按简介向用户确认。',
    inputSchema: {
      type: 'object',
      properties: { selection_key: { type: 'string', description: 'openbkn_list_networks 返回的 selection_key。' } },
      required: ['selection_key'],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: 'openbkn_starters',
    description: '为本任务选定的知识网络生成 2–3 个可以直接提问的示例问题。刚选定网络、或用户不知道从何问起时调用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: 'openbkn_begin_turn',
    description: '开始本轮的 OpenBKN 记录。只在 OpenBKN 查询工具返回 TURN_NOT_STARTED 时调用，然后重试那次查询。question 填用户本轮的问题，尽量用用户原话。',
    inputSchema: {
      type: 'object',
      properties: { question: { type: 'string', description: '用户本轮的问题，尽量用原话。' } },
      required: ['question'],
      additionalProperties: false,
    },
    annotations: LIFECYCLE,
  },
  {
    name: 'openbkn_end_turn',
    description: '结束本轮由 openbkn_begin_turn 开始的 OpenBKN 记录。在给出最终回答之前调用：回答完成时 outcome=completed，answer 填给用户的最终回答全文；查询失败或放弃时 outcome=failed。没有调用过 openbkn_begin_turn 的轮次不需要调用。',
    inputSchema: {
      type: 'object',
      properties: {
        outcome: { type: 'string', enum: ['completed', 'failed'] },
        answer: { type: 'string', description: 'outcome=completed 时必填：给用户的最终回答全文。' },
      },
      required: ['outcome'],
      additionalProperties: false,
    },
    annotations: LIFECYCLE,
  },
]

/** Fingerprints of read-v1 + lifecycle schemas that were reviewed (tool-contract.ts). */
export const REVIEWED_FINGERPRINTS: readonly string[] = [
  // OpenBKN EE 0.1.4, agent-retrieval 0.1.4-hotfix-supply-sample-p1 (R0a snapshot 2026-09-28).
  'c4ed19490ab543a83bcbc8f4a2cfb3bcb3a332d1812bd8e647b904f46666f63b',
  // Newer agent-retrieval on the community-edition test platform, reviewed 2026-10-19
  // (internal evidence): wording, simplified bkn_context,
  // read-only paging/params added; no new capability.
  '230d4addacee1c5900a1b4817ba8d898e8109be34f87e7730b7860259d87f53a',
  // Enterprise-edition test platform after its upgrade, reviewed 2026-10-19 (internal evidence):
  // same as the community platform except bkn_context wording and bkn_context no longer required (the bridge always sends it).
  '47ea622971fe5d8056814fcb91fcbaa811d8d95e152131dee488c3fc4949eb30',
]

export interface CatalogState {
  readonly tools: readonly PlatformTool[]
  readonly fingerprint: string
  /** Set when the deployment's tools differ from the reviewed contract; business tools are then withheld. */
  readonly contractProblem?: string
}

/** Checks run inside the WorkBuddy host (sandboxed), unlike the installer's doctor. */
export type SelfCheck = () => Record<string, unknown>

export class ToolRouter {
  private catalog: CatalogState | undefined
  /** Per platform origin: whether its Studio offers the business provenance page. */
  private readonly provenancePages = new Map<string, Promise<boolean>>()

  constructor(
    private readonly session: BridgeSession,
    private readonly gateway: GatewayPort,
    private readonly scene: ScenePack | undefined,
    private readonly reviewed: readonly string[] = REVIEWED_FINGERPRINTS,
    private readonly selfCheck?: SelfCheck,
  ) {}

  /** Bridge tools always; platform tools only when the gateway is connected and the contract matches. */
  async list(): Promise<readonly McpTool[]> {
    const catalog = await this.loadCatalog().catch(() => undefined)
    if (catalog === undefined || catalog.contractProblem) return BRIDGE_TOOLS
    const business = catalog.tools.filter(t => isReadV1Tool(t.name)).map(t => {
      const projected = projectToolForModel(t)
      return {
        name: projected.name,
        description: projected.description ?? projected.title ?? projected.name,
        inputSchema: projected.inputSchema,
        annotations: READ_ONLY,
      }
    })
    return [...BRIDGE_TOOLS, ...business]
  }

  async call(name: string, args: unknown, host: HostContext): Promise<McpToolResult> {
    try {
      return await this.dispatch(name, args ?? {}, host)
    } catch (error) {
      return failure(error)
    }
  }

  private async dispatch(name: string, args: unknown, host: HostContext): Promise<McpToolResult> {
    if (!isRecord(args)) throw new BridgeError('BAD_ARGUMENTS', '工具参数必须是对象。')
    switch (name) {
      case 'openbkn_status': return text(await this.status(host))
      case 'openbkn_list_networks': {
        const taskKey = requireTask(host)
        const networks = await this.session.listNetworks(taskKey, host.turnKey)
        return text({
          networks,
          note: networks.length === 0 ? '当前账号没有可访问的知识网络，请联系 OpenBKN 管理员授权。' : '把网络名称和简介告诉用户，请用户确认要用哪一个（只有一个也要确认），等用户回复后再调用 openbkn_select_network。用户本轮已经说出网络名称时可以直接选择。不要展示 selection_key。',
        })
      }
      case 'openbkn_select_network': {
        const taskKey = requireTask(host)
        const key = typeof args.selection_key === 'string' ? args.selection_key.trim() : ''
        if (!key) throw new BridgeError('BAD_ARGUMENTS', '缺少 selection_key。')
        if (!host.turnKey) throw hostContextMissing()
        const { binding, alreadyBound } = await this.session.selectNetwork(taskKey, key, host.turnKey)
        return text({ network: binding.displayName, already_selected: alreadyBound, next: '可调用 openbkn_starters 获取示例问题，或直接按用户的问题查询。' })
      }
      case 'openbkn_starters': return text(await this.starters(host))
      case 'openbkn_begin_turn': {
        const taskKey = requireTask(host)
        if (!host.turnKey) throw hostContextMissing()
        const question = typeof args.question === 'string' ? args.question : ''
        const result = await this.session.beginModelTurn(taskKey, host.turnKey, question)
        return text(result === 'hook-managed'
          ? { recording: 'automatic', next: '本轮已自动记录，直接重试查询；不需要调用 openbkn_end_turn。' }
          : { recording: 'model', next: '重试刚才的查询。给出最终回答之前调用 openbkn_end_turn。' })
      }
      case 'openbkn_end_turn': {
        const taskKey = requireTask(host)
        if (!host.turnKey) throw hostContextMissing()
        const outcome = args.outcome === 'completed' || args.outcome === 'failed' ? args.outcome : undefined
        if (outcome === undefined) throw new BridgeError('BAD_ARGUMENTS', 'outcome 必须是 completed 或 failed。')
        const result = await this.session.endModelTurn(taskKey, host.turnKey, outcome, typeof args.answer === 'string' ? args.answer : '')
        if (result === 'close-failed') throw new BridgeError('PREVIOUS_TURN_OPEN', 'OpenBKN 暂时没有确认本轮记录的收尾，下一次查询前会自动重试。照常给出回答。')
        return text({ recorded: result !== 'unknown-turn', next: '给出最终回答。' })
      }
      default:
        if (isReadV1Tool(name)) return this.business(name, args, host, true)
        throw new BridgeError('BAD_ARGUMENTS', `工具 ${name} 不可用。`)
    }
  }

  private async business(name: string, args: Record<string, unknown>, host: HostContext, forModel = false): Promise<McpToolResult> {
    const taskKey = requireTask(host)
    if (!host.turnKey) throw hostContextMissing()
    const catalog = await this.loadCatalog()
    if (catalog.contractProblem) throw new BridgeError('CONTRACT_MISMATCH', 'OpenBKN 平台的查询工具与本插件审核过的版本不一致，已暂停查询。请联系插件维护者。', catalog.contractProblem)
    const tool = catalog.tools.find(t => t.name === name)
    if (tool === undefined) throw new BridgeError('BAD_ARGUMENTS', `OpenBKN 平台没有提供 ${name}。`)
    // Validate before opening the turn's Interaction: a malformed call must not create platform records.
    buildPlatformArguments(tool, args, { knId: 'check', bknContext: { conversation_id: 'check', interaction_id: 'check' } })
    const active = await this.session.ensureInteraction(taskKey, host.turnKey)
    const platformArgs = buildPlatformArguments(tool, args, {
      knId: active.binding.knowledgeNetworkId,
      bknContext: { conversation_id: active.conversationId, interaction_id: active.interactionId },
    })
    const result = await this.gateway.callTool(name, platformArgs, { knowledgeNetworkId: active.binding.knowledgeNetworkId, hostTaskKey: taskKey })
    const content = [...(result.content ?? [])]
    if (forModel && !result.isError) {
      const note = await this.turnNote(active)
      if (note) content.push({ type: 'text', text: note })
    }
    return { content, ...(result.isError ? { isError: true } : {}) }
  }

  /** What the model must still do for this turn: close a model-opened turn; where to read the provenance. */
  private async turnNote(active: ActiveTurn): Promise<string | undefined> {
    const parts: string[] = []
    if (active.source === 'model') parts.push('给出最终回答之前调用 openbkn_end_turn（outcome=completed，answer=最终回答全文；查询失败或放弃时 outcome=failed）。')
    const url = await this.provenanceUrl(active.conversationId, active.interactionId)
    if (url) parts.push(`本轮业务溯源可在 OpenBKN 查看，可在回答末尾附上：${url}`)
    return parts.length === 0 ? undefined : `【OpenBKN】${parts.join('')}`
  }

  /** Studio's business provenance page for one turn; only where the platform offers it (Enterprise). */
  private async provenanceUrl(conversationId: string | undefined, interactionId: string): Promise<string | undefined> {
    if (!conversationId) return undefined
    const origin = (await this.gateway.status().catch(() => undefined))?.origin?.replace(/\/+$/, '')
    if (!origin) return undefined
    // Keyed by origin: a later login to another platform must not reuse this answer.
    let offered = this.provenancePages.get(origin)
    if (offered === undefined) {
      offered = this.gateway.capabilities().then(c => c.businessProvenance, () => { this.provenancePages.delete(origin); return false })
      this.provenancePages.set(origin, offered)
    }
    if (!(await offered)) return undefined
    const query = new URLSearchParams({ conversation_id: conversationId, interaction_id: interactionId })
    return `${origin}/studio/observability/business-provenance?${query.toString()}`
  }

  private async status(host: HostContext): Promise<Record<string, unknown>> {
    const local = this.selfCheck ? { self_check: { ...this.selfCheck(), scene_loaded: this.scene !== undefined } } : {}
    let status
    try {
      status = await this.gateway.status()
    } catch (error) {
      return { connected: false, message: userStateOf(error).message, ...local }
    }
    const out: Record<string, unknown> = {
      connected: status.configured && status.credential === true,
      ...(status.origin ? { platform: status.origin } : {}),
      ...local,
    }
    if (!status.configured || status.credential !== true) {
      return { ...out, message: userStateOf(new GatewayCallError('NOT_CONFIGURED', '')).message }
    }
    try {
      const catalog = await this.loadCatalog(true)
      if (catalog.contractProblem) out.compatibility = 'OpenBKN 查询工具与本插件审核过的版本不一致，查询已暂停，请联系插件维护者。'
    } catch (error) {
      out.connected = false
      out.message = userStateOf(error).message
    }
    if (host.taskKey) {
      try {
        out.network = (await this.session.currentBinding(host.taskKey)).displayName
      } catch (error) {
        out.network_note = error instanceof BridgeError ? error.message : userStateOf(error).message
      }
      const recorded = await this.session.recordings(host.taskKey, host.turnKey).catch(() => [])
      if (recorded.length > 0) {
        out.recent_turns = await Promise.all(recorded.map(async r => {
          const url = r.phase === 'closed' || r.phase === 'unresolved' ? await this.provenanceUrl(r.conversationId, r.interactionId) : undefined
          return {
            turn: r.turn === 'current' ? '本轮' : '上一轮',
            recorded_by: r.source === 'hook' ? 'automatic' : 'model',
            ...(r.outcome ? { outcome: r.outcome } : {}),
            ...(url ? { provenance_url: url } : {}),
            diagnostics: {
              interaction_id: r.interactionId, local_phase: r.phase,
              ...(r.businessGraph ? { execution_status: r.businessGraph.executionStatus, evidence_status: r.businessGraph.evidenceStatus, business_refs: r.businessGraph.businessRefs.length } : {}),
            },
          }
        }))
      }
    }
    return out
  }

  private async starters(host: HostContext): Promise<Record<string, unknown>> {
    const taskKey = requireTask(host)
    if (!host.turnKey) throw hostContextMissing()
    const binding = await this.session.currentBinding(taskKey)
    const catalog = await this.loadCatalog()
    const detail = await this.business('get_kn_detail', { response_format: 'json' }, host)
    const names = namesFromDetail(detail)
    const available = capabilitiesOf(catalog.tools)
    const starters = this.scene ? renderStarters(this.scene, { networkName: binding.displayName, ...names }, available) : []
    return { network: binding.displayName, starters, note: starters.length === 0 ? '暂时无法生成示例问题，可直接描述想了解的业务问题。' : '可以把这些问题提供给用户选择，也可以直接回答用户自己的问题。' }
  }

  private async loadCatalog(refresh = false): Promise<CatalogState> {
    if (this.catalog && !refresh) return this.catalog
    const raw = await this.gateway.tools()
    const tools = raw.filter(isPlatformTool)
    const fingerprint = catalogFingerprint(tools)
    let contractProblem: string | undefined
    try {
      assertCatalogSupportsReadV1(tools)
      if (!this.reviewed.includes(fingerprint)) contractProblem = `unreviewed tool contract ${fingerprint.slice(0, 12)}`
    } catch (error) {
      contractProblem = error instanceof Error ? error.message : 'tool contract check failed'
    }
    this.catalog = { tools, fingerprint, ...(contractProblem ? { contractProblem } : {}) }
    return this.catalog
  }
}

function isPlatformTool(value: unknown): value is PlatformTool {
  return isRecord(value) && typeof value.name === 'string' && isRecord(value.inputSchema)
}

function capabilitiesOf(tools: readonly PlatformTool[]): Capability[] {
  const has = (n: string) => tools.some(t => t.name === n)
  const out: Capability[] = []
  if (has('search_schema')) out.push('schema_search')
  if (has('query_object_instance')) out.push('object_query')
  if (has('query_instance_subgraph')) out.push('relation_query')
  if (has('query_metric')) out.push('metric_query')
  if (has('get_logic_properties_values')) out.push('logic_property')
  return out
}

/**
 * Names of object types, relations and metrics from a `get_kn_detail` JSON summary
 * (top-level `object_types[]` / `relation_types[]` / `metrics[]` items with `name`).
 * Object types without a data source (platform system types) are skipped.
 */
export function namesFromDetail(result: McpToolResult): { objectTypeNames: string[]; relationNames: string[]; metricNames: string[] } {
  const out = { objectTypeNames: [] as string[], relationNames: [] as string[], metricNames: [] as string[] }
  if (result.isError) return out
  let detail: Record<string, unknown> | undefined
  for (const block of result.content ?? []) {
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    try {
      const parsed: unknown = JSON.parse(block.text)
      if (isRecord(parsed)) detail = isRecord(parsed.data) && !Array.isArray(parsed.object_types) ? parsed.data : parsed
    } catch { /* not JSON */ }
    if (detail) break
  }
  if (!detail) return out
  const names = (key: string, keep: (item: Record<string, unknown>) => boolean = () => true) =>
    (Array.isArray(detail![key]) ? detail![key] as unknown[] : [])
      .filter(isRecord).filter(keep)
      .map(item => (typeof item.name === 'string' ? item.name.trim() : ''))
      .filter((n, i, all) => n.length > 0 && all.indexOf(n) === i)
      .slice(0, 20)
  out.objectTypeNames = names('object_types', item => item.data_source !== null && item.data_source !== undefined)
  out.relationNames = names('relation_types')
  out.metricNames = names('metrics')
  return out
}

function requireTask(host: HostContext): string {
  if (!host.taskKey) throw hostContextMissing()
  return host.taskKey
}

function hostContextMissing(): BridgeError {
  return new BridgeError('HOST_CONTEXT_MISSING', '没有收到 WorkBuddy 的任务标识，无法确定业务范围。请在 WorkBuddy 任务中使用本连接器。')
}

function text(value: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}

// Host acceptance N1: with an expired login the model still answered with numbers from earlier turns.
const FAILURE_RULE = '本次 OpenBKN 调用没有成功，本轮没有拿到新的业务数据。把上面的 message 告诉用户；不要用之前对话、记忆或本地文件里的业务数字代替本轮结果作答，也不要给出数字。'

function failure(error: unknown): McpToolResult {
  const name = error instanceof Error ? error.name : ''
  const state = error instanceof BridgeError
    ? { code: error.code, message: error.message }
    : name === 'ToolArgumentError'
      ? { code: 'BAD_ARGUMENTS', message: `参数有误：${(error as Error).message}` }
      : name === 'CatalogPagingError'
        ? { code: 'CATALOG_UNSTABLE', message: '读取知识网络列表时出错，请稍后重试。' }
        : (() => { const s = userStateOf(error); return { code: s.code, message: s.message } })()
  // Codes that only ask the model for a step (open the turn, ask the user) carry no answer rule.
  const rule = state.code === 'TURN_NOT_STARTED' || state.code === 'CONFIRMATION_REQUIRED' ? {} : { answer_rule: FAILURE_RULE }
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: state.code, message: state.message, ...rule }) }] }
}
