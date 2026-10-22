// Product scene pack: declarative domain wording and starter-question templates.
// It may carry no tokens, SQL, URLs, internal KN ids, scripts, per-question query
// plans, expected answers or grading rules (TECHNICAL_PLAN §4.2). Starter questions
// are rendered only from names the bound network actually discloses.
// JSON Schema twin: schemas/scene-pack.schema.json (keep both in sync).
import { isRecord } from './json.js'

export const CAPABILITIES = ['schema_search', 'object_query', 'relation_query', 'metric_query', 'logic_property'] as const
export type Capability = typeof CAPABILITIES[number]

export interface StarterTemplate {
  /** Placeholders: {network_name}, {object_type_name}, {relation_name}, {metric_name}. */
  readonly text: string
  readonly requires: readonly Capability[]
}

export interface ScenePack {
  readonly schema_version: 1
  readonly scene_id: string
  readonly contract_version: 'read-v1'
  readonly title: string
  readonly domain_notes?: readonly string[]
  readonly required_capabilities: readonly Capability[]
  readonly starter_templates: readonly StarterTemplate[]
}

const PLACEHOLDER_NEEDS: Readonly<Record<string, Capability | undefined>> = {
  network_name: undefined,
  object_type_name: 'object_query',
  relation_name: 'relation_query',
  metric_name: 'metric_query',
}
// Content that must never appear in a scene pack.
const FORBIDDEN = [
  { re: /https?:\/\//i, why: 'URL' },
  { re: /\b(select|insert|update|delete)\b[\s\S]*\b(from|into|set)\b/i, why: 'SQL' },
  { re: /\bbak_[A-Za-z0-9]/, why: 'AppKey' },
  { re: /\bbearer\s+\S/i, why: 'credential' },
  { re: /\b(kn_id|bkn_context|interaction_id|conversation_id)\b/i, why: 'managed identifier' },
]
const MAX_TEXT = 300

export function validateScenePack(value: unknown): readonly string[] {
  const errors: string[] = []
  const err = (path: string, msg: string) => errors.push(`${path}: ${msg}`)
  if (!isRecord(value)) return ['$: must be an object']
  const allowed = new Set(['schema_version', 'scene_id', 'contract_version', 'title', 'domain_notes', 'required_capabilities', 'starter_templates'])
  for (const key of Object.keys(value)) if (!allowed.has(key)) err(`$.${key}`, 'unknown field')
  if (value.schema_version !== 1) err('$.schema_version', 'must be 1')
  if (typeof value.scene_id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(value.scene_id)) err('$.scene_id', 'must match ^[a-z0-9][a-z0-9-]{1,63}$')
  if (value.contract_version !== 'read-v1') err('$.contract_version', 'must be read-v1')
  checkText(value.title, '$.title', err)
  if (value.domain_notes !== undefined) {
    if (!Array.isArray(value.domain_notes) || value.domain_notes.length > 10) err('$.domain_notes', 'must be an array of at most 10 notes')
    else value.domain_notes.forEach((n, i) => checkText(n, `$.domain_notes[${i}]`, err))
  }
  const caps = capabilityList(value.required_capabilities, '$.required_capabilities', err)
  if (!Array.isArray(value.starter_templates) || value.starter_templates.length === 0 || value.starter_templates.length > 10) {
    err('$.starter_templates', 'must be an array of 1..10 templates')
    return errors
  }
  value.starter_templates.forEach((t, i) => {
    const path = `$.starter_templates[${i}]`
    if (!isRecord(t)) { err(path, 'must be an object'); return }
    checkText(t.text, `${path}.text`, err)
    const requires = capabilityList(t.requires, `${path}.requires`, err)
    for (const r of requires) if (!caps.includes(r)) err(`${path}.requires`, `"${r}" is not in required_capabilities`)
    for (const name of placeholdersOf(typeof t.text === 'string' ? t.text : '')) {
      if (!(name in PLACEHOLDER_NEEDS)) err(`${path}.text`, `unknown placeholder {${name}}`)
      const need = PLACEHOLDER_NEEDS[name]
      if (need !== undefined && !requires.includes(need)) err(`${path}.requires`, `{${name}} needs "${need}"`)
    }
  })
  return errors
}

/** What the bound network discloses (from get_kn_detail / get_object_types), names only. */
export interface NetworkNames {
  readonly networkName: string
  readonly objectTypeNames: readonly string[]
  readonly relationNames: readonly string[]
  readonly metricNames: readonly string[]
}

/**
 * Render at most `limit` starter questions. A template is used only when every
 * capability it needs is available and every placeholder can be filled from
 * disclosed names; a network without metrics never gets a metric starter.
 */
export function renderStarters(pack: ScenePack, names: NetworkNames, available: readonly Capability[], limit = 3): readonly string[] {
  const pools: Record<string, readonly string[]> = {
    network_name: [names.networkName],
    object_type_name: names.objectTypeNames,
    relation_name: names.relationNames,
    metric_name: names.metricNames,
  }
  const used: Record<string, number> = {}
  const out: string[] = []
  for (const t of pack.starter_templates) {
    if (out.length >= limit) break
    if (!t.requires.every(c => available.includes(c))) continue
    const placeholders = placeholdersOf(t.text)
    if (placeholders.some(p => (pools[p] ?? []).length === 0)) continue
    // Rotate through names so different templates mention different objects.
    const text = t.text.replace(/\{([a-z_]+)\}/g, (_m, p: string) => {
      const pool = pools[p] ?? []
      const value = pool[(used[p] ?? 0) % pool.length] ?? ''
      used[p] = (used[p] ?? 0) + 1
      return sanitizeName(value)
    })
    out.push(text)
  }
  return out
}

function placeholdersOf(text: string): string[] {
  return [...text.matchAll(/\{([a-z_]+)\}/g)].map(m => m[1] as string)
}

/** Platform names are data: bound their length and drop braces/newlines before they enter a prompt. */
function sanitizeName(name: string): string {
  return name.replace(/[\r\n{}]/g, ' ').trim().slice(0, 60)
}

function checkText(v: unknown, path: string, err: (p: string, m: string) => void): void {
  if (typeof v !== 'string' || v.trim().length === 0 || v.length > MAX_TEXT) { err(path, `must be a non-empty string of at most ${MAX_TEXT} characters`); return }
  for (const f of FORBIDDEN) if (f.re.test(v)) err(path, `must not contain ${f.why}`)
}

function capabilityList(v: unknown, path: string, err: (p: string, m: string) => void): Capability[] {
  if (!Array.isArray(v) || v.length === 0) { err(path, 'must be a non-empty array'); return [] }
  const out: Capability[] = []
  for (const c of v) {
    if ((CAPABILITIES as readonly unknown[]).includes(c)) out.push(c as Capability)
    else err(path, `unknown capability ${JSON.stringify(c)}`)
  }
  return out
}
