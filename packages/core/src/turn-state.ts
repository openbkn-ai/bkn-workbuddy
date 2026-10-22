// Per-turn lifecycle state for the WorkBuddy adapter. Pure transitions only; the
// bridge persists the state and performs the platform calls the state asks for.
//
//   observed ──business call──▶ active ──Stop──▶ pending_close ──platform ack──▶ closed
//      │                                            │
//      └──Stop, no business call──▶ no_business      └──unresolvable──▶ unresolved
//
// One Interaction per turn that touches OpenBKN, none for turns that do not.
// A completed close always carries the answer its source reported; nothing here fabricates one.
//
// Two sources drive a turn. `hook` (preferred): UserPromptSubmit records the user's
// verbatim question and Stop reports the final answer. `model` (fallback when no hook
// reached this turn): the model opens the turn with its own statement of the question
// and closes it with its answer, the way the bkn-dsh plugin's managed sessions do.
import type { TurnAnswerResolution } from './transcript.js'

export type TurnPhase = 'observed' | 'active' | 'pending_close' | 'closed' | 'no_business' | 'unresolved'
export type CloseOutcome = 'completed' | 'cancelled' | 'failed'
export type TurnSource = 'hook' | 'model'

export interface TurnState {
  readonly schemaVersion: 1
  /** Hook `session_id` = MCP `workbuddy.ai/conversationId`. */
  readonly hostTaskKey: string
  /** Hook `generation_id` = MCP `workbuddy.ai/requestId`. */
  readonly hostTurnKey: string
  readonly phase: TurnPhase
  /** `hook` when absent (state written before the model fallback existed). */
  readonly source?: TurnSource
  /** Raw user question from `UserPromptSubmit.prompt`, or the model's statement of it. */
  readonly question: string
  readonly promptCursor: number
  readonly interactionId?: string
  readonly conversationId?: string
  readonly resolution?: TurnAnswerResolution
  readonly outcome?: CloseOutcome
  readonly resolveAttempts: number
  readonly closeAttempts: number
  readonly lastError?: string
}

export type TurnEvent =
  | { readonly type: 'prompt'; readonly hostTaskKey: string; readonly hostTurnKey: string; readonly question: string; readonly promptCursor: number; readonly source?: TurnSource }
  | { readonly type: 'interaction-started'; readonly interactionId: string; readonly conversationId: string }
  | { readonly type: 'stop'; readonly resolution: TurnAnswerResolution }
  | { readonly type: 'resolution-retried'; readonly resolution: TurnAnswerResolution }
  | { readonly type: 'close-confirmed'; readonly outcome: CloseOutcome }
  | { readonly type: 'close-failed'; readonly error: string }
  | { readonly type: 'platform-terminal'; readonly status: string }
  | { readonly type: 'give-up'; readonly reason: string }

export class TurnTransitionError extends Error {
  constructor(readonly phase: TurnPhase | 'none', readonly event: TurnEvent['type']) {
    super(`turn event "${event}" is not valid in phase "${phase}"`)
    this.name = 'TurnTransitionError'
  }
}

export function applyTurnEvent(state: TurnState | undefined, event: TurnEvent): TurnState {
  if (event.type === 'prompt') {
    if (state !== undefined) throw new TurnTransitionError(state.phase, event.type)
    if (!event.hostTaskKey || !event.hostTurnKey) throw new TypeError('turn keys must not be empty')
    return {
      schemaVersion: 1, hostTaskKey: event.hostTaskKey, hostTurnKey: event.hostTurnKey, phase: 'observed',
      ...(event.source === 'model' ? { source: 'model' as const } : {}),
      question: event.question, promptCursor: event.promptCursor, resolveAttempts: 0, closeAttempts: 0,
    }
  }
  if (state === undefined) throw new TurnTransitionError('none', event.type)
  switch (event.type) {
    case 'interaction-started':
      if (state.phase !== 'observed') throw new TurnTransitionError(state.phase, event.type)
      return { ...state, phase: 'active', interactionId: event.interactionId, conversationId: event.conversationId }
    case 'stop':
      if (state.phase === 'observed') return { ...state, phase: 'no_business', resolution: event.resolution }
      if (state.phase !== 'active') throw new TurnTransitionError(state.phase, event.type)
      return { ...state, phase: 'pending_close', resolution: event.resolution, resolveAttempts: 1 }
    case 'resolution-retried':
      if (state.phase !== 'pending_close' || state.resolution?.kind !== 'unresolved') throw new TurnTransitionError(state.phase, event.type)
      return { ...state, resolution: event.resolution, resolveAttempts: state.resolveAttempts + 1 }
    case 'close-confirmed':
      if (state.phase !== 'pending_close') throw new TurnTransitionError(state.phase, event.type)
      return withoutError({ ...state, phase: 'closed', outcome: event.outcome })
    case 'close-failed':
      if (state.phase !== 'pending_close') throw new TurnTransitionError(state.phase, event.type)
      return { ...state, closeAttempts: state.closeAttempts + 1, lastError: event.error.slice(0, 200) }
    case 'platform-terminal':
      // The platform already ended the Interaction (e.g. `abandoned` after a timeout, R0a).
      if (state.phase !== 'active' && state.phase !== 'pending_close') throw new TurnTransitionError(state.phase, event.type)
      return { ...state, phase: 'unresolved', lastError: `platform status ${event.status}` }
    case 'give-up':
      if (state.phase !== 'pending_close' && state.phase !== 'active') throw new TurnTransitionError(state.phase, event.type)
      return { ...state, phase: 'unresolved', lastError: event.reason.slice(0, 200) }
  }
}

/** The finish request this turn needs now, if any. Unresolved answers produce no request. */
export type CloseCommand =
  | { readonly interactionId: string; readonly outcome: 'completed'; readonly answer: string }
  | { readonly interactionId: string; readonly outcome: 'cancelled'; readonly reason: string }

export function closeCommandFor(state: TurnState): CloseCommand | undefined {
  if (state.phase !== 'pending_close' || state.interactionId === undefined) return undefined
  const r = state.resolution
  if (r?.kind === 'completed') return { interactionId: state.interactionId, outcome: 'completed', answer: r.answer }
  if (r?.kind === 'cancelled') return { interactionId: state.interactionId, outcome: 'cancelled', reason: 'The WorkBuddy user stopped this turn.' }
  return undefined
}

/**
 * The platform allows one active Interaction per conversation (R0a). A new turn of
 * the same task may start its Interaction only when no earlier turn is still open.
 */
export function blockingTurn(turns: readonly TurnState[], hostTaskKey: string, hostTurnKey: string): TurnState | undefined {
  return turns.find(t => t.hostTaskKey === hostTaskKey && t.hostTurnKey !== hostTurnKey && (t.phase === 'active' || t.phase === 'pending_close'))
}

function withoutError(state: TurnState): TurnState {
  const { lastError: _dropped, ...rest } = state
  return rest
}
