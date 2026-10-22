// Shared evaluation pack (AGENT_INTEGRATION_BASELINE: one pack for all hosts).
// Keeps the original bkn-dsh fields (network, cases[].id/question/expectFacts/
// expectTools/forbidden) and adds schema_version, dataset_version, followups and
// machine assertions. Expected facts and assertions are for the test runner only:
// they must never reach the model, the scene pack or the Skill.
// JSON Schema twin: schemas/eval-pack.schema.json (keep both in sync).
import { isRecord } from './json.js'
import { READ_V1_TOOLS } from './tool-contract.js'

export type EvalAssertion =
  /** At least one of these platform tools ran in this turn (from platform operations). */
  | { readonly type: 'tool_called'; readonly any_of: readonly string[] }
  | { readonly type: 'tool_not_called'; readonly tools: readonly string[] }
  | { readonly type: 'answer_contains'; readonly all_of: readonly string[] }
  | { readonly type: 'answer_not_contains'; readonly any_of: readonly string[] }
  /** ECMAScript/Python-compatible pattern, e.g. `(?<!\\d)40(?!\\d)` for the standalone number 40. */
  | { readonly type: 'answer_matches'; readonly pattern: string }
  | { readonly type: 'interaction_count'; readonly equals: number }
  | { readonly type: 'outcome'; readonly equals: 'completed' | 'cancelled' | 'failed' | 'none' }
  /** The turn's business graph discloses a resolved reference of this type and display name. */
  | { readonly type: 'provenance_ref'; readonly ref_type: string; readonly name: string }
  /** The adapter showed this state to the user (e.g. AUTHENTICATION_REQUIRED). */
  | { readonly type: 'adapter_status'; readonly code: string }

export type Precondition = 'credential-invalid' | 'platform-unreachable' | 'network-unauthorized'

export interface EvalTurn {
  readonly id: string
  readonly question: string
  readonly expectFacts: readonly string[]
  readonly expectTools: readonly string[]
  readonly forbidden: readonly string[]
  readonly assertions?: readonly EvalAssertion[]
}

export interface EvalCase extends EvalTurn {
  readonly group: 'positive' | 'negative'
  readonly precondition?: Precondition
  /** Only meaningful against a real authorization service; blocked on the permissive local stub (D6). */
  readonly requires_real_authorization?: boolean
  readonly baseline?: { readonly verified: boolean; readonly method?: string; readonly verified_at?: string }
  /** Asked in order, in the same host task as the parent case. */
  readonly followups?: readonly EvalTurn[]
}

export interface EvalPack {
  readonly schema_version: 1
  /** Locked sample data, e.g. `bkn-samples@<commit>/supply_ontology_hand`. */
  readonly dataset_version: string
  /** Knowledge network id the runner binds; never shown to the model. */
  readonly network: string
  readonly source?: string
  readonly cases: readonly EvalCase[]
}

export const ASSERTION_TYPES = ['tool_called', 'tool_not_called', 'answer_contains', 'answer_not_contains', 'answer_matches', 'interaction_count', 'outcome', 'provenance_ref', 'adapter_status'] as const
const PRECONDITIONS: readonly string[] = ['credential-invalid', 'platform-unreachable', 'network-unauthorized']
const ID = /^[a-z0-9][a-z0-9-]{1,63}$/

/** Returns every problem found; an empty list means the pack is valid. */
export function validateEvalPack(value: unknown): readonly string[] {
  const errors: string[] = []
  const err = (path: string, msg: string) => errors.push(`${path}: ${msg}`)
  if (!isRecord(value)) return ['$: must be an object']
  if (value.schema_version !== 1) err('$.schema_version', 'must be 1')
  if (!nonEmpty(value.dataset_version)) err('$.dataset_version', 'must be a non-empty string')
  if (!nonEmpty(value.network)) err('$.network', 'must be a non-empty string')
  if (value.source !== undefined && typeof value.source !== 'string') err('$.source', 'must be a string')
  if (!Array.isArray(value.cases) || value.cases.length === 0) { err('$.cases', 'must be a non-empty array'); return errors }
  const ids = new Set<string>()
  value.cases.forEach((c, i) => {
    const path = `$.cases[${i}]`
    if (!isRecord(c)) { err(path, 'must be an object'); return }
    validateTurn(c, path, ids, err)
    if (c.group !== 'positive' && c.group !== 'negative') err(`${path}.group`, 'must be positive or negative')
    if (c.precondition !== undefined) {
      if (!PRECONDITIONS.includes(c.precondition as string)) err(`${path}.precondition`, `must be one of ${PRECONDITIONS.join(', ')}`)
      if (c.group !== 'negative') err(`${path}.precondition`, 'only negative cases may set a precondition')
    }
    if (c.requires_real_authorization !== undefined && typeof c.requires_real_authorization !== 'boolean') err(`${path}.requires_real_authorization`, 'must be boolean')
    if (c.baseline !== undefined) {
      if (!isRecord(c.baseline) || typeof c.baseline.verified !== 'boolean') err(`${path}.baseline`, 'must be { verified: boolean, method?, verified_at? }')
    }
    if (c.followups !== undefined) {
      if (!Array.isArray(c.followups)) err(`${path}.followups`, 'must be an array')
      else c.followups.forEach((f, j) => {
        if (!isRecord(f)) err(`${path}.followups[${j}]`, 'must be an object')
        else validateTurn(f, `${path}.followups[${j}]`, ids, err)
      })
    }
    for (const key of Object.keys(c)) {
      if (!CASE_KEYS.has(key)) err(`${path}.${key}`, 'unknown field')
    }
  })
  return errors
}

const TURN_KEYS = new Set(['id', 'question', 'expectFacts', 'expectTools', 'forbidden', 'assertions'])
const CASE_KEYS = new Set([...TURN_KEYS, 'group', 'precondition', 'requires_real_authorization', 'baseline', 'followups'])
const TOOLS: readonly string[] = READ_V1_TOOLS

function validateTurn(t: Record<string, unknown>, path: string, ids: Set<string>, err: (p: string, m: string) => void): void {
  if (typeof t.id !== 'string' || !ID.test(t.id)) err(`${path}.id`, 'must match ^[a-z0-9][a-z0-9-]{1,63}$')
  else if (ids.has(t.id)) err(`${path}.id`, `duplicate id "${t.id}"`)
  else ids.add(t.id)
  if (!nonEmpty(t.question)) err(`${path}.question`, 'must be a non-empty string')
  for (const key of ['expectFacts', 'forbidden'] as const) {
    if (!stringArray(t[key])) err(`${path}.${key}`, 'must be an array of non-empty strings')
  }
  if (!stringArray(t.expectTools)) err(`${path}.expectTools`, 'must be an array of tool names')
  else for (const tool of t.expectTools as string[]) if (!TOOLS.includes(tool)) err(`${path}.expectTools`, `"${tool}" is not a read-v1 tool`)
  if (t.assertions !== undefined) {
    if (!Array.isArray(t.assertions)) err(`${path}.assertions`, 'must be an array')
    else t.assertions.forEach((a, k) => validateAssertion(a, `${path}.assertions[${k}]`, err))
  }
  if (path.includes('followups')) for (const key of Object.keys(t)) if (!TURN_KEYS.has(key)) err(`${path}.${key}`, 'unknown field')
}

function validateAssertion(a: unknown, path: string, err: (p: string, m: string) => void): void {
  if (!isRecord(a) || !(ASSERTION_TYPES as readonly string[]).includes(a.type as string)) { err(path, `type must be one of ${ASSERTION_TYPES.join(', ')}`); return }
  const toolList = (v: unknown, field: string) => {
    if (!stringArray(v) || (v as string[]).length === 0) err(`${path}.${field}`, 'must be a non-empty array')
    else for (const tool of v as string[]) if (!TOOLS.includes(tool)) err(`${path}.${field}`, `"${tool}" is not a read-v1 tool`)
  }
  switch (a.type) {
    case 'tool_called': toolList(a.any_of, 'any_of'); break
    case 'tool_not_called': toolList(a.tools, 'tools'); break
    case 'answer_contains': if (!stringArray(a.all_of) || (a.all_of as string[]).length === 0) err(`${path}.all_of`, 'must be a non-empty string array'); break
    case 'answer_not_contains': if (!stringArray(a.any_of) || (a.any_of as string[]).length === 0) err(`${path}.any_of`, 'must be a non-empty string array'); break
    case 'answer_matches':
      if (!nonEmpty(a.pattern)) { err(`${path}.pattern`, 'must be a non-empty string'); break }
      try { new RegExp(a.pattern as string, 'u') } catch { err(`${path}.pattern`, 'is not a valid regular expression') }
      break
    case 'interaction_count': if (!Number.isSafeInteger(a.equals) || (a.equals as number) < 0) err(`${path}.equals`, 'must be a non-negative integer'); break
    case 'outcome': if (!['completed', 'cancelled', 'failed', 'none'].includes(a.equals as string)) err(`${path}.equals`, 'must be completed, cancelled, failed or none'); break
    case 'provenance_ref': if (!nonEmpty(a.ref_type) || !nonEmpty(a.name)) err(path, 'needs ref_type and name'); break
    case 'adapter_status': if (!nonEmpty(a.code)) err(`${path}.code`, 'must be a non-empty string'); break
  }
}

function nonEmpty(v: unknown): boolean { return typeof v === 'string' && v.trim().length > 0 }
function stringArray(v: unknown): boolean { return Array.isArray(v) && v.every(nonEmpty) }
