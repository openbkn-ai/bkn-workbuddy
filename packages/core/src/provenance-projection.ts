// Adapted from bkn-dsh@3f99235508b20b2587f4a5f9cfa3badecf769ff5
// packages/openbkn-business-context/src/platform-reader.ts (projectOperations,
// projectBusinessGraph). Changes: pure functions only — the authenticated fetch
// moved to the credential gateway; typed results instead of DSH's JsonValue.
import { isRecord } from './json.js'

export interface OperationView {
  readonly operationId: string
  readonly toolName?: string
  readonly sourceModule?: string
  readonly protocol?: string
  readonly status?: string
  readonly startedAt?: string
  readonly finishedAt?: string
  readonly requestId?: string
  readonly traceId?: string
  readonly receiptId?: string
}

export interface OperationsView {
  readonly entries: readonly OperationView[]
  readonly total: number
}

export interface BusinessRefView {
  readonly refId: string
  readonly refType: string
  readonly visibility?: string
  readonly versionStatus?: string
  readonly name: string
  readonly resolutionStatus?: string
  readonly sourceVersion?: string
}

export interface BusinessGraphView {
  readonly interactionId?: string
  readonly conversationId?: string
  readonly executionStatus?: string
  readonly evidenceStatus?: string
  readonly businessRefs: readonly BusinessRefView[]
  readonly edges: readonly { readonly operationId: string; readonly role?: string; readonly observedAt?: string; readonly ref: BusinessRefView }[]
  readonly events: readonly { readonly eventId: string; readonly eventType: string; readonly layer?: string; readonly operationId?: string }[]
}

/** `GET /api/agent-observability/v1/interactions/{id}/operations` → bounded view. */
export function projectOperations(value: unknown): OperationsView {
  const source = isRecord(value) ? value : undefined
  const entries = array(source?.entries ?? source?.operations).flatMap(entry => {
    const e = isRecord(entry) ? entry : undefined
    const operationId = str(e?.operation_id)
    if (operationId === undefined) return []
    return [compact({
      operationId,
      toolName: str(e?.tool_name), sourceModule: str(e?.source_module), protocol: str(e?.protocol),
      status: str(e?.status), startedAt: str(e?.started_at), finishedAt: str(e?.finished_at),
      requestId: str(e?.request_id), traceId: str(e?.trace_id), receiptId: str(e?.receipt_id),
    }) as unknown as OperationView]
  })
  return { entries, total: num(source?.total) ?? entries.length }
}

/** `GET /api/agent-observability/v1/interactions/{id}/business-graph` → bounded view. */
export function projectBusinessGraph(value: unknown): BusinessGraphView {
  const source = isRecord(value) ? value : undefined
  const assembly = isRecord(source?.assembly) ? source.assembly : undefined
  const refs = array(assembly?.business_refs).flatMap(c => { const r = projectRef(c); return r ? [r] : [] })
  const edges = array(assembly?.operation_business_edges).flatMap(c => {
    const e = isRecord(c) ? c : undefined
    const operationId = str(e?.operation_id)
    const ref = projectRef(e?.business_ref)
    return operationId === undefined || ref === undefined ? [] : [compact({ operationId, role: str(e?.role), observedAt: str(e?.observed_at), ref }) as unknown as BusinessGraphView['edges'][number]]
  })
  const events = array(source?.events).flatMap(c => {
    const e = isRecord(c) ? c : undefined
    const eventId = str(e?.event_id)
    const eventType = str(e?.event_type)
    return eventId === undefined || eventType === undefined ? [] : [compact({ eventId, eventType, layer: str(e?.layer), operationId: str(e?.operation_id) }) as unknown as BusinessGraphView['events'][number]]
  })
  return compact({
    interactionId: str(source?.interaction_id), conversationId: str(source?.conversation_id),
    executionStatus: str(source?.execution_status), evidenceStatus: str(source?.evidence_status),
    businessRefs: refs, edges, events,
  }) as unknown as BusinessGraphView
}

function projectRef(candidate: unknown): BusinessRefView | undefined {
  const ref = isRecord(candidate) ? candidate : undefined
  const technical = isRecord(ref?.technical_ref) ? ref.technical_ref : undefined
  const display = isRecord(ref?.display) ? ref.display : undefined
  const refId = str(technical?.ref_id)
  const refType = str(technical?.ref_type)
  const name = str(display?.name)
  if (refId === undefined || refType === undefined || name === undefined) return undefined
  return compact({
    refId, refType, visibility: str(technical?.visibility), versionStatus: str(technical?.version_status),
    name, resolutionStatus: str(display?.resolution_status), sourceVersion: str(display?.source_version),
  }) as unknown as BusinessRefView
}

/** Drop undefined fields so results satisfy exactOptionalPropertyTypes and serialize compactly. */
function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined))
}
function array(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : [] }
function str(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim().slice(0, 512) : undefined }
function num(value: unknown): number | undefined { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined }
