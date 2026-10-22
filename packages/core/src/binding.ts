// Adapted from bkn-dsh@3f99235508b20b2587f4a5f9cfa3badecf769ff5
// packages/openbkn-business-context/src/session-binding.ts.
// Changes: the scope is keyed by the WorkBuddy host task key instead of a DSH
// session event log, and additionally pins the business domain and (when the
// platform can confirm it) the principal. Persistence is the caller's concern.

/** Immutable business scope of one WorkBuddy task. */
export interface TaskBinding {
  /** WorkBuddy task key: Hook `session_id`, equal to MCP `_meta["workbuddy.ai/conversationId"]`. */
  readonly hostTaskKey: string
  /** Normalized platform origin, e.g. `https://openbkn.example.com`. */
  readonly platformOrigin: string
  readonly businessDomain: string
  readonly knowledgeNetworkId: string
  readonly displayName: string
  /** Platform principal id when the platform discloses one; absent means "not confirmed". */
  readonly principal?: string
}

export type BindResult =
  | { readonly kind: 'bound'; readonly binding: TaskBinding }
  | { readonly kind: 'already-bound'; readonly binding: TaskBinding }

/** A task already has a different scope; switching requires a new WorkBuddy task. */
export class BindingConflictError extends Error {
  constructor(readonly existing: TaskBinding, readonly requested: TaskBinding) {
    super(`This WorkBuddy task is already bound to "${existing.displayName}"; start a new task to use "${requested.displayName}".`)
    this.name = 'BindingConflictError'
  }
}

/** Decide whether a selection creates the task's one binding, repeats it, or conflicts. */
export function bindTask(existing: TaskBinding | undefined, requested: TaskBinding): BindResult {
  const next = normalizeBinding(requested)
  if (existing === undefined) return { kind: 'bound', binding: next }
  const current = normalizeBinding(existing)
  if (current.hostTaskKey !== next.hostTaskKey) throw new TypeError('binding belongs to another WorkBuddy task')
  if (!sameScope(current, next)) throw new BindingConflictError(current, next)
  return { kind: 'already-bound', binding: current }
}

export function sameScope(left: TaskBinding, right: TaskBinding): boolean {
  return left.platformOrigin === right.platformOrigin
    && left.businessDomain === right.businessDomain
    && left.knowledgeNetworkId === right.knowledgeNetworkId
    && (left.principal === undefined || right.principal === undefined || left.principal === right.principal)
}

export function normalizeBinding(binding: TaskBinding): TaskBinding {
  const hostTaskKey = binding.hostTaskKey.trim()
  const platformOrigin = normalizeOrigin(binding.platformOrigin)
  const businessDomain = binding.businessDomain.trim()
  const knowledgeNetworkId = binding.knowledgeNetworkId.trim()
  const displayName = binding.displayName.trim()
  const principal = binding.principal?.trim()
  if (!hostTaskKey || !businessDomain || !knowledgeNetworkId || !displayName) {
    throw new TypeError('task binding fields must not be empty')
  }
  return { hostTaskKey, platformOrigin, businessDomain, knowledgeNetworkId, displayName, ...(principal ? { principal } : {}) }
}

/** Reduce a configured platform URL to its origin; only https, or http on loopback, is accepted. */
export function normalizeOrigin(value: string): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new TypeError('platform address is not a valid URL') }
  if (url.username || url.password) throw new TypeError('platform address must not contain credentials')
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new TypeError('platform address must use https (http is allowed only on loopback)')
  }
  return url.origin
}
