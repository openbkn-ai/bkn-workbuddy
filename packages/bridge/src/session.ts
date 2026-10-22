// The bridge's business logic, shared by the MCP server and the hook entry:
// network selection and the task binding, and the lazy per-turn OpenBKN Interaction
// (start on the first business call, finish from the Stop hook). Turns no hook
// reached fall back to the model opening and closing them (openbkn_begin_turn /
// openbkn_end_turn); the provenance itself is read in OpenBKN Studio.
// All platform traffic goes through the gateway; this module never sees a credential.
import { randomBytes } from 'node:crypto'
import {
  applyTurnEvent, bindTask, BindingConflictError, blockingTurn, buildNetworkSelection, classifyFailure, closeCommandFor,
  collectVisibleBusinessNetworks, projectBusinessGraph, projectLifecycleOutcome,
  type BusinessGraphView, type TaskBinding, type TurnAnswerResolution, type TurnSource, type TurnState,
} from '@bkn-workbuddy/core'
import { GatewayCallError, type GatewayStatus, type ManagedContext, type McpToolResult, type PlatformCapabilities } from './gateway-client.js'
import type { TaskRecord, TaskStore } from './task-store.js'

/** The gateway operations the bridge uses; `GatewayClient` implements it. */
export interface GatewayPort {
  status(): Promise<GatewayStatus>
  catalogPage(offset: number, limit: number): Promise<unknown>
  tools(): Promise<readonly unknown[]>
  callTool(tool: string, args: Readonly<Record<string, unknown>>, managed: ManagedContext): Promise<McpToolResult>
  operations(interactionId: string): Promise<unknown>
  businessGraph(interactionId: string): Promise<unknown>
  capabilities(): Promise<PlatformCapabilities>
}

export const AGENT_NAME = 'bkn-agent-workbuddy'
const SELECTION_TTL_MS = 60 * 60 * 1000

export type BridgeErrorCode =
  | 'NOT_BOUND' | 'BINDING_CONFLICT' | 'SCOPE_CHANGED' | 'SELECTION_UNKNOWN' | 'NETWORK_NOT_VISIBLE'
  | 'HOST_CONTEXT_MISSING' | 'TURN_NOT_STARTED' | 'TURN_CLOSED' | 'PREVIOUS_TURN_OPEN' | 'START_FAILED'
  | 'CONTRACT_MISMATCH' | 'BAD_ARGUMENTS' | 'CONFIRMATION_REQUIRED'

/** A refusal or failure decided by the bridge; `message` is user-facing Chinese. */
export class BridgeError extends Error {
  constructor(readonly code: BridgeErrorCode, message: string, readonly detail?: string) {
    super(message)
    this.name = 'BridgeError'
  }
}

export interface ActiveTurn {
  readonly binding: TaskBinding
  readonly conversationId: string
  readonly interactionId: string
  readonly source: TurnSource
}

export interface NetworkOption {
  readonly selection_key: string
  readonly name: string
  readonly description?: string
  readonly duplicate_name: boolean
}

/** Recording state of one turn, for `openbkn_status` diagnostics and links. */
export interface TurnRecording {
  readonly turn: 'current' | 'previous'
  readonly source: TurnSource
  readonly phase: TurnState['phase']
  readonly outcome?: string
  readonly conversationId?: string
  readonly interactionId: string
  readonly businessGraph?: BusinessGraphView
}

export type BeginResult = 'model-started' | 'hook-managed' | 'already-started'
export type EndResult = 'hook-managed' | CloseResult

export type CloseResult = 'no-task' | 'unknown-turn' | 'no-business' | 'closed' | 'close-failed' | 'platform-terminal' | 'unchanged'

export class BridgeSession {
  constructor(private readonly store: TaskStore, private readonly gateway: GatewayPort, private readonly now: () => number = Date.now) {}

  // ---- hook side -------------------------------------------------------------

  /** UserPromptSubmit: remember the turn and its question; no platform call. */
  async recordPrompt(hostTaskKey: string, hostTurnKey: string, question: string, promptCursor: number): Promise<boolean> {
    if (!question.trim()) return false
    return this.store.update(hostTaskKey, task => {
      // The same event may be delivered more than once; the first record wins.
      if (task.turns.some(t => t.hostTurnKey === hostTurnKey)) return { result: false }
      const turn = applyTurnEvent(undefined, { type: 'prompt', hostTaskKey, hostTurnKey, question, promptCursor })
      return { task: { ...task, turns: [...task.turns, turn] }, result: true }
    })
  }

  /** Stop: settle the turn. Turns that touched OpenBKN are finished with the real answer, or as cancelled/failed. */
  async closeTurn(hostTaskKey: string, hostTurnKey: string, resolution: TurnAnswerResolution, from: TurnSource = 'hook'): Promise<CloseResult> {
    if (!this.store.exists(hostTaskKey)) return 'no-task'
    return this.store.update<CloseResult>(hostTaskKey, async task => {
      const turn = task.turns.find(t => t.hostTurnKey === hostTurnKey)
      if (turn === undefined) return { result: 'unknown-turn' }
      if ((turn.source ?? 'hook') !== from) return { result: 'unchanged' }
      let next: TurnState
      if (turn.phase === 'observed' || turn.phase === 'active') next = applyTurnEvent(turn, { type: 'stop', resolution })
      else if (turn.phase === 'pending_close') next = turn
      else return { result: 'unchanged' }
      if (next.phase === 'no_business') return { task: replaceTurn(task, next), result: 'no-business' }
      const settled = await this.finish(task, next)
      const result: CloseResult = settled.phase === 'closed' ? 'closed' : settled.phase === 'unresolved' ? 'platform-terminal' : 'close-failed'
      return { task: replaceTurn(task, settled), result }
    })
  }

  promptCursorOf(hostTaskKey: string, hostTurnKey: string): number | undefined {
    return this.store.read(hostTaskKey)?.turns.find(t => t.hostTurnKey === hostTurnKey)?.promptCursor
  }

  // ---- MCP side --------------------------------------------------------------

  /**
   * Model fallback: open this turn with the model's statement of the question. A turn the
   * UserPromptSubmit hook already recorded stays hook-managed (verbatim question, Stop closes it).
   */
  async beginModelTurn(hostTaskKey: string, hostTurnKey: string, question: string): Promise<BeginResult> {
    const trimmed = question.trim()
    if (!trimmed) throw new BridgeError('BAD_ARGUMENTS', 'question 不能为空，请填写用户本轮的问题。')
    return this.store.update<BeginResult>(hostTaskKey, task => {
      const existing = task.turns.find(t => t.hostTurnKey === hostTurnKey)
      if (existing !== undefined) return { result: (existing.source ?? 'hook') === 'hook' ? 'hook-managed' : 'already-started' }
      const turn = applyTurnEvent(undefined, { type: 'prompt', hostTaskKey, hostTurnKey, question: trimmed.slice(0, 4000), promptCursor: -1, source: 'model' })
      return { task: { ...task, turns: [...task.turns, turn] }, result: 'model-started' }
    })
  }

  /** Model fallback: close a model-opened turn with the final answer, or as failed. */
  async endModelTurn(hostTaskKey: string, hostTurnKey: string, outcome: 'completed' | 'failed', answer: string): Promise<EndResult> {
    const turn = this.store.read(hostTaskKey)?.turns.find(t => t.hostTurnKey === hostTurnKey)
    if (turn === undefined) throw new BridgeError('TURN_NOT_STARTED', '本轮没有开始 OpenBKN 记录，不需要结束。')
    if ((turn.source ?? 'hook') === 'hook') return 'hook-managed'
    if (outcome === 'completed' && !answer.trim()) throw new BridgeError('BAD_ARGUMENTS', 'outcome 为 completed 时，answer 必须是给用户的最终回答全文。')
    const resolution: TurnAnswerResolution = outcome === 'completed'
      ? { kind: 'completed', answer: answer.trim() }
      : { kind: 'unresolved', reason: 'model-reported-failure' }
    return this.closeTurn(hostTaskKey, hostTurnKey, resolution, 'model')
  }

  async listNetworks(hostTaskKey: string, hostTurnKey?: string): Promise<readonly NetworkOption[]> {
    const networks = await collectVisibleBusinessNetworks((offset, limit) => this.gateway.catalogPage(offset, limit))
    const selection = buildNetworkSelection(networks, () => randomBytes(4).toString('hex'))
    const names = new Map(networks.map(n => [n.id, n.displayName]))
    const keys: Record<string, { networkId: string; displayName: string }> = {}
    for (const [key, networkId] of selection.keyToNetworkId) keys[key] = { networkId, displayName: names.get(networkId) ?? '' }
    await this.store.update(hostTaskKey, task => ({ task: { ...task, selection: { issuedAt: new Date(this.now()).toISOString(), ...(hostTurnKey ? { issuedTurnKey: hostTurnKey } : {}), keys } }, result: undefined }))
    return selection.options.map(o => ({
      selection_key: o.key,
      name: o.displayName,
      ...(o.description === undefined ? {} : { description: o.description }),
      duplicate_name: o.duplicateName,
    }))
  }

  /**
   * Bind this WorkBuddy task to one network, once. Visibility is re-checked against a fresh catalogue.
   * The user must have chosen it: either this turn's question names the network, or the list was
   * shown in an earlier turn (the user has answered since). A model that lists and selects within
   * the turn of a bare business question is refused, so it has to ask the user first.
   */
  async selectNetwork(hostTaskKey: string, selectionKey: string, hostTurnKey: string): Promise<{ readonly binding: TaskBinding; readonly alreadyBound: boolean }> {
    const status = await this.configuredStatus()
    const snapshot = this.store.read(hostTaskKey)
    const entry = snapshot?.selection?.keys[selectionKey]
    const issued = snapshot?.selection ? Date.parse(snapshot.selection.issuedAt) : NaN
    if (entry === undefined || !(this.now() - issued < SELECTION_TTL_MS)) {
      throw new BridgeError('SELECTION_UNKNOWN', '这个选择已失效。请先重新列出可访问的知识网络，再按名称选择。')
    }
    if (snapshot?.binding === undefined && !userChose(snapshot!, hostTurnKey, entry.displayName)) {
      throw new BridgeError('CONFIRMATION_REQUIRED', '请先把可访问的知识网络名称告诉用户，请用户确认要用哪一个；用户回复后再选择。本轮不要查询业务数据。')
    }
    const visible = await collectVisibleBusinessNetworks((offset, limit) => this.gateway.catalogPage(offset, limit))
    const network = visible.find(n => n.id === entry.networkId)
    if (network === undefined) throw new BridgeError('NETWORK_NOT_VISIBLE', `当前账号已无法访问“${entry.displayName}”。请重新列出可访问的知识网络。`)
    return this.store.update(hostTaskKey, task => {
      const requested: TaskBinding = {
        hostTaskKey, platformOrigin: status.origin, businessDomain: status.businessDomain,
        knowledgeNetworkId: network.id, displayName: network.displayName,
      }
      try {
        const bound = bindTask(task.binding, requested)
        const { selection: _cleared, ...rest } = task
        return { task: { ...rest, binding: bound.binding }, result: { binding: bound.binding, alreadyBound: bound.kind === 'already-bound' } }
      } catch (error) {
        if (error instanceof BindingConflictError) {
          throw new BridgeError('BINDING_CONFLICT', `本任务已使用“${error.existing.displayName}”。如需改用“${requested.displayName}”，请新建一个 WorkBuddy 任务。`)
        }
        throw error
      }
    })
  }

  /** The binding of this task, checked against the platform the gateway is connected to now. */
  async currentBinding(hostTaskKey: string): Promise<TaskBinding> {
    const binding = this.store.read(hostTaskKey)?.binding
    if (binding === undefined) throw notBound()
    const status = await this.configuredStatus()
    if (status.origin !== binding.platformOrigin || status.businessDomain !== binding.businessDomain) throw scopeChanged(binding)
    return binding
  }

  /**
   * The Interaction for this turn, started on first use. Earlier turns of the task
   * that are still open are finished first (the platform allows one at a time).
   */
  async ensureInteraction(hostTaskKey: string, hostTurnKey: string): Promise<ActiveTurn> {
    const status = await this.configuredStatus()
    return this.store.update<ActiveTurn>(hostTaskKey, async task => {
      const binding = task.binding
      if (binding === undefined) throw notBound()
      if (status.origin !== binding.platformOrigin || status.businessDomain !== binding.businessDomain) throw scopeChanged(binding)
      const turn = task.turns.find(t => t.hostTurnKey === hostTurnKey)
      if (turn === undefined) {
        throw new BridgeError('TURN_NOT_STARTED', '本轮还没有开始 OpenBKN 记录。先调用 openbkn_begin_turn（question 填用户本轮的问题），再重试这次查询。')
      }
      const source = turn.source ?? 'hook'
      if (turn.phase === 'active' && turn.interactionId && turn.conversationId) {
        return { result: { binding, conversationId: turn.conversationId, interactionId: turn.interactionId, source } }
      }
      if (turn.phase !== 'observed') throw new BridgeError('TURN_CLOSED', '本轮已经结束，请在新的一轮提问中查询。')

      let current = task
      for (let blocker = blockingTurn(current.turns, hostTaskKey, hostTurnKey); blocker; blocker = blockingTurn(current.turns, hostTaskKey, hostTurnKey)) {
        const pending = blocker.phase === 'active'
          ? applyTurnEvent(blocker, { type: 'stop', resolution: { kind: 'unresolved', reason: 'no-stop-event' } })
          : blocker
        const settled = await this.finish(current, pending)
        current = replaceTurn(current, settled)
        if (settled.phase === 'pending_close') {
          return { task: current, error: new BridgeError('PREVIOUS_TURN_OPEN', '上一轮在 OpenBKN 上的记录还没有收尾，暂时不能开始新的查询。请稍后重试。', settled.lastError) }
        }
      }

      const started = await this.start(current, binding, turn.question, hostTaskKey)
      const active = applyTurnEvent(turn, { type: 'interaction-started', interactionId: started.interactionId, conversationId: started.conversationId })
      current = { ...replaceTurn(current, active), platformConversationId: started.conversationId }
      return { task: current, result: { binding, conversationId: started.conversationId, interactionId: started.interactionId, source } }
    })
  }

  /** The current turn's and the previous recorded turn's state; platform status when reachable. */
  async recordings(hostTaskKey: string, hostTurnKey: string | undefined): Promise<readonly TurnRecording[]> {
    const turns = (this.store.read(hostTaskKey)?.turns ?? []).filter(t => t.interactionId !== undefined)
    const current = turns.find(t => t.hostTurnKey === hostTurnKey)
    const previous = [...turns].reverse().find(t => t.hostTurnKey !== hostTurnKey)
    const picked = [current && { which: 'current' as const, t: current }, previous && { which: 'previous' as const, t: previous }]
      .filter((p): p is { which: 'current' | 'previous'; t: TurnState } => !!p)
    return Promise.all(picked.map(async ({ which, t }) => {
      const graph = await this.gateway.businessGraph(t.interactionId!).then(projectBusinessGraph, () => undefined)
      return {
        turn: which, source: t.source ?? 'hook', phase: t.phase, interactionId: t.interactionId!,
        ...(t.conversationId ? { conversationId: t.conversationId } : {}),
        ...(t.outcome ? { outcome: t.outcome } : {}),
        ...(graph ? { businessGraph: graph } : {}),
      }
    }))
  }

  // ---- platform lifecycle ----------------------------------------------------

  private async start(task: TaskRecord, binding: TaskBinding, question: string, hostTaskKey: string): Promise<{ interactionId: string; conversationId: string }> {
    const managed: ManagedContext = { knowledgeNetworkId: binding.knowledgeNetworkId, hostTaskKey }
    const attempt = (conversationId: string | undefined) => this.gateway.callTool('bkn_start_interaction', {
      conversation_mode: conversationId ? 'continue' : 'new',
      ...(conversationId ? { conversation_id: conversationId } : {}),
      question, agent_name: AGENT_NAME,
    }, managed)
    let result = await attempt(task.platformConversationId)
    let outcome = projectLifecycleOutcome(toOutcome(result))
    // The platform no longer lets this identity continue the conversation: one controlled `new` per turn.
    if (result.isError && task.platformConversationId && classifyFailure(outcome) === 'conversation-invalid') {
      result = await attempt(undefined)
      outcome = projectLifecycleOutcome(toOutcome(result))
    }
    if (!result.isError && outcome.interactionId && outcome.conversationId) {
      return { interactionId: outcome.interactionId, conversationId: outcome.conversationId }
    }
    // A previous start of this turn may have succeeded although its reply was lost (timeout):
    // the host conversation key maps us back and the platform names the open Interaction (R0a §4).
    if (result.isError && outcome.errorCode === 'interaction_in_progress' && outcome.currentInteractionId && task.platformConversationId) {
      return { interactionId: outcome.currentInteractionId, conversationId: task.platformConversationId }
    }
    throw new BridgeError('START_FAILED', 'OpenBKN 未能开始本轮记录，查询没有执行。请稍后重试。', outcome.errorCode ?? 'missing ids')
  }

  /** Try to finish a pending turn; returns it closed, terminal, or still pending with the error. */
  private async finish(task: TaskRecord, turn: TurnState): Promise<TurnState> {
    if (turn.phase !== 'pending_close' || turn.interactionId === undefined) return turn
    const command = closeCommandFor(turn)
    const reason = turn.resolution?.kind !== 'unresolved' ? ''
      : turn.resolution.reason === 'model-reported-failure' ? 'The model reported that this turn failed.'
        : `WorkBuddy did not confirm the final answer (${turn.resolution.reason}).`
    const args: Record<string, unknown> = command === undefined
      ? { interaction_id: turn.interactionId, outcome: 'failed', reason }
      : command.outcome === 'completed'
        ? { interaction_id: command.interactionId, outcome: 'completed', answer: command.answer }
        : { interaction_id: command.interactionId, outcome: 'cancelled', reason: command.reason }
    const knowledgeNetworkId = task.binding?.knowledgeNetworkId ?? ''
    try {
      const result = await this.gateway.callTool('bkn_finish_interaction', args, { knowledgeNetworkId, hostTaskKey: turn.hostTaskKey })
      if (!result.isError) return applyTurnEvent(turn, { type: 'close-confirmed', outcome: (args.outcome as 'completed' | 'cancelled' | 'failed') })
      const outcome = projectLifecycleOutcome(toOutcome(result))
      if (outcome.errorCode === 'terminal_conflict') return applyTurnEvent(turn, { type: 'platform-terminal', status: outcome.currentStatus ?? 'terminal' })
      return applyTurnEvent(turn, { type: 'close-failed', error: outcome.errorCode ?? 'finish failed' })
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'finish failed'
      return applyTurnEvent(turn, { type: 'close-failed', error: code })
    }
  }

  private async configuredStatus(): Promise<GatewayStatus & { origin: string; businessDomain: string }> {
    const status = await this.gateway.status()
    if (!status.configured || status.credential === false || !status.origin || !status.businessDomain) {
      throw new GatewayCallError(status.configured ? 'AUTHENTICATION_REQUIRED' : 'NOT_CONFIGURED', 'OpenBKN is not connected yet')
    }
    return status as GatewayStatus & { origin: string; businessDomain: string }
  }
}

function replaceTurn(task: TaskRecord, turn: TurnState): TaskRecord {
  return { ...task, turns: task.turns.map(t => (t.hostTurnKey === turn.hostTurnKey ? turn : t)) }
}

function toOutcome(result: McpToolResult) {
  return { isError: result.isError === true, ...(result.content === undefined ? {} : { content: result.content }) }
}

function notBound(): BridgeError {
  return new BridgeError('NOT_BOUND', '本任务还没有选择知识网络。请先列出可访问的知识网络，并按名称选择一个。')
}

function scopeChanged(binding: TaskBinding): BridgeError {
  return new BridgeError('SCOPE_CHANGED', `本任务绑定的“${binding.displayName}”属于另一个 OpenBKN 平台或业务域，与当前登录不一致。请新建一个 WorkBuddy 任务。`)
}

function userChose(task: TaskRecord, hostTurnKey: string, displayName: string): boolean {
  const issuedIn = task.selection?.issuedTurnKey
  if (issuedIn !== undefined && issuedIn !== hostTurnKey) return true
  const question = task.turns.find(t => t.hostTurnKey === hostTurnKey)?.question ?? ''
  const squash = (v: string) => v.replace(/\s+/g, '')
  return displayName.trim().length > 0 && squash(question).includes(squash(displayName))
}
