// Adapted from bkn-dsh@3f99235508b20b2587f4a5f9cfa3badecf769ff5
// packages/openbkn-business-context/src/business-network-catalog.ts.
// Changes: the summary no longer carries a DSH workspace path; added complete
// offset/limit paging (the source read only the first page of 100) and
// user-facing selection options that never expose internal network ids.
import { isRecord } from './json.js'

/** The only platform-network fields the adapter keeps. */
export interface BusinessNetworkSummary {
  readonly id: string
  readonly displayName: string
  readonly description?: string
}

/**
 * Convert one platform response into bounded summaries. The platform remains the
 * authorization authority; this only removes unneeded fields and rejects malformed rows.
 */
export function parseVisibleBusinessNetworks(value: unknown): readonly BusinessNetworkSummary[] {
  const entries = entriesOf(value)
  if (entries === undefined) throw new Error('OpenBKN returned an invalid network list.')
  const seen = new Set<string>()
  const networks: BusinessNetworkSummary[] = []
  for (const entry of entries) {
    const network = networkOf(entry)
    if (network === undefined || seen.has(network.id)) continue
    seen.add(network.id)
    networks.push(network)
  }
  return networks
}

/** One page request against `GET /api/bkn-backend/v1/knowledge-networks`. */
export type NetworkPageFetcher = (offset: number, limit: number) => Promise<unknown>

export interface CollectOptions {
  /** Platform accepts 1..1000 (R0a); keep pages small enough to bound one response. */
  readonly pageSize?: number
  /** Hard stop so a misbehaving platform cannot make the adapter loop forever. */
  readonly maxPages?: number
}

export class CatalogPagingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CatalogPagingError'
  }
}

/**
 * Read every page of the caller's visible networks. Paging follows `offset/limit`
 * until `total_count` entries were seen or a page comes back empty; a total that
 * changes mid-read, or a page cap hit before completion, fails closed instead of
 * returning a silently truncated list.
 */
export async function collectVisibleBusinessNetworks(fetchPage: NetworkPageFetcher, options: CollectOptions = {}): Promise<readonly BusinessNetworkSummary[]> {
  const pageSize = options.pageSize ?? 100
  const maxPages = options.maxPages ?? 50
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw new RangeError('pageSize must be 1..1000')
  const seen = new Set<string>()
  const networks: BusinessNetworkSummary[] = []
  let total: number | undefined
  let offset = 0
  for (let page = 0; page < maxPages; page++) {
    const value = await fetchPage(offset, pageSize)
    const pageTotal = totalOf(value)
    if (pageTotal === undefined) throw new CatalogPagingError('OpenBKN network list did not report total_count.')
    if (total === undefined) total = pageTotal
    else if (total !== pageTotal) throw new CatalogPagingError('OpenBKN network list changed while it was being read; retry.')
    const entries = entriesOf(value) ?? []
    for (const network of parseVisibleBusinessNetworks(value)) {
      if (seen.has(network.id)) continue
      seen.add(network.id)
      networks.push(network)
    }
    offset += entries.length
    if (entries.length === 0 || offset >= total) return networks
  }
  throw new CatalogPagingError(`OpenBKN network list exceeded ${maxPages} pages.`)
}

/** A choice shown to the user: business name and description only, plus an opaque key. */
export interface NetworkSelectionOption {
  readonly key: string
  readonly displayName: string
  readonly description?: string
  /** Another visible network has the same display name; the description must disambiguate. */
  readonly duplicateName: boolean
}

export interface NetworkSelection {
  readonly options: readonly NetworkSelectionOption[]
  /** Opaque key → internal network id. Kept by the caller, never shown to the model or user. */
  readonly keyToNetworkId: ReadonlyMap<string, string>
}

/** Build user-facing options; `newKey` must return unguessable, unique keys. */
export function buildNetworkSelection(networks: readonly BusinessNetworkSummary[], newKey: () => string): NetworkSelection {
  const nameCounts = new Map<string, number>()
  for (const n of networks) nameCounts.set(n.displayName, (nameCounts.get(n.displayName) ?? 0) + 1)
  const keyToNetworkId = new Map<string, string>()
  const options = networks.map(n => {
    let key = newKey()
    while (keyToNetworkId.has(key)) key = newKey()
    keyToNetworkId.set(key, n.id)
    return {
      key,
      displayName: n.displayName,
      ...(n.description === undefined ? {} : { description: n.description }),
      duplicateName: (nameCounts.get(n.displayName) ?? 0) > 1,
    }
  })
  return { options, keyToNetworkId }
}

function entriesOf(value: unknown): readonly unknown[] | undefined {
  if (!isRecord(value)) return undefined
  if (Array.isArray(value.entries)) return value.entries
  if (isRecord(value.result) && Array.isArray(value.result.entries)) return value.result.entries
  return undefined
}

function totalOf(value: unknown): number | undefined {
  const source = isRecord(value) && isRecord(value.result) ? value.result : value
  if (!isRecord(source)) return undefined
  const total = source.total_count
  return typeof total === 'number' && Number.isSafeInteger(total) && total >= 0 ? total : undefined
}

function networkOf(value: unknown): BusinessNetworkSummary | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string') return undefined
  const id = value.id.trim()
  const displayName = value.name.trim()
  if (id.length === 0 || displayName.length === 0) return undefined
  const description = stringOrUndefined(value.description) ?? stringOrUndefined(value.comment)
  return { id, displayName, ...(description === undefined ? {} : { description }) }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}
