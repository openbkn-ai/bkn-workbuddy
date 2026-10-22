// Adapted from bkn-dsh@3f99235508b20b2587f4a5f9cfa3badecf769ff5
// packages/openbkn-business-context/src/interaction-lifecycle.ts.
// Kept: the no-payload projection of lifecycle results and the classification of
// platform conversation-invalidation codes. Dropped: DSH session-event typing,
// hard-coded `mcp__openbkn__` tool names and the model-facing denial messages —
// in WorkBuddy the bridge drives start/finish itself instead of guiding the model.
import { isRecord } from './json.js'

/**
 * Platform error codes meaning "this conversation_id cannot be continued by the
 * current identity"; they justify one controlled `new` start per turn. Verified
 * against OpenBKN EE 0.1.4 (bkn-dsh evidence) and re-observed in R0a on 2026-09-28
 * (`continue` with an unknown conversation → `resource_not_disclosed`).
 * Timeouts, authentication failures, 5xx and parameter errors are excluded on
 * purpose: those must keep the held conversation_id.
 */
export const CONVERSATION_INVALID_ERROR_CODES = ['resource_not_disclosed', 'conversation_owner_mismatch'] as const

/** The no-payload projection of one settled lifecycle tool result. */
export interface LifecycleToolResultProjection {
  readonly interactionId?: string
  readonly conversationId?: string
  readonly executionStatus?: string
  readonly errorCode?: string
  /** `interaction_in_progress` / `terminal_conflict` disclose the current interaction or status. */
  readonly currentInteractionId?: string
  readonly currentStatus?: string
}

/** Settled MCP tool result as returned through the gateway. */
export interface LifecycleOutcomeLike {
  readonly isError: boolean
  readonly content?: readonly { readonly type?: string; readonly text?: string }[]
  readonly error?: { readonly message: string }
}

export function classifyFailure(payload: LifecycleToolResultProjection): 'conversation-invalid' | 'other' {
  return payload.errorCode !== undefined
    && (CONVERSATION_INVALID_ERROR_CODES as readonly string[]).includes(payload.errorCode)
    ? 'conversation-invalid'
    : 'other'
}

/**
 * Success: the first JSON text block disclosing ids. Failure: the error code (and
 * any disclosed current interaction/status), read from either the error message or
 * an `isError` text block — OpenBKN tool errors arrive as HTTP 200 with
 * `isError: true` and `{"error":{"code":...}}` (R0a §3).
 */
export function projectLifecycleOutcome(result: LifecycleOutcomeLike): LifecycleToolResultProjection {
  const texts = [
    ...(result.error?.message ? [result.error.message] : []),
    ...(result.content ?? []).filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text as string),
  ]
  for (const text of texts) {
    const parsed = parseJsonRecord(text.slice(0, 16_384))
    if (parsed === undefined) continue
    if (result.isError) {
      const nested = isRecord(parsed.error) ? parsed.error : undefined
      const errorCode = identifier(parsed.code) ?? identifier(nested?.code) ?? identifier(parsed.error_code) ?? identifier(nested?.error_code)
      if (errorCode === undefined) continue
      const currentInteractionId = identifier(nested?.current_interaction_id ?? parsed.current_interaction_id)
      const currentStatus = identifier(nested?.current_status ?? parsed.current_status)
      return {
        errorCode,
        ...(currentInteractionId === undefined ? {} : { currentInteractionId }),
        ...(currentStatus === undefined ? {} : { currentStatus }),
      }
    }
    const interactionId = identifier(parsed.interaction_id)
    const conversationId = identifier(parsed.conversation_id)
    const executionStatus = identifier(parsed.execution_status)
    if (interactionId !== undefined || conversationId !== undefined) {
      return {
        ...(interactionId === undefined ? {} : { interactionId }),
        ...(conversationId === undefined ? {} : { conversationId }),
        ...(executionStatus === undefined ? {} : { executionStatus }),
      }
    }
  }
  return {}
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function identifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length <= 256 ? normalized : undefined
}
