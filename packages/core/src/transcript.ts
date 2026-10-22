// WorkBuddy transcript contract, from the R0b-2 observations on WorkBuddy 5.6.2
// (internal evidence): JSONL records with `id`/`parentId`;
// answers are `type: "message", role: "assistant"` with `status` `completed` or
// `incomplete` (cancelled); user records are host-wrapped (never the raw question);
// edits add `resend-fork-notice` and a new branch under an earlier parent.
import { isRecord } from './json.js'

export interface TranscriptRecord {
  /** Zero-based line index in the file. */
  readonly index: number
  readonly type?: string
  readonly role?: string
  readonly status?: string
  readonly id?: string
  readonly parentId?: string
  /** Concatenated text parts; only filled for `message` records. */
  readonly text?: string
}

export interface ParsedTranscript {
  readonly records: readonly TranscriptRecord[]
  /** The file did not end with a newline: the last line may still be being written and was skipped. */
  readonly trailingPartial: boolean
  readonly unparsedLines: number
}

/** Parse complete lines only; a trailing line without newline is treated as in-progress. */
export function parseTranscript(text: string): ParsedTranscript {
  const lines = text.split('\n')
  const trailingPartial = !text.endsWith('\n') && lines[lines.length - 1] !== ''
  const complete = trailingPartial ? lines.slice(0, -1) : lines
  const records: TranscriptRecord[] = []
  let unparsedLines = 0
  complete.forEach((line, index) => {
    if (!line.trim()) return
    let o: unknown
    try { o = JSON.parse(line) } catch { unparsedLines += 1; return }
    if (!isRecord(o)) { unparsedLines += 1; return }
    const message = isRecord(o.message) ? o.message : undefined
    const role = str(o.role) ?? str(message?.role)
    const content = o.content ?? message?.content
    const record: TranscriptRecord = {
      index,
      ...opt('type', str(o.type)),
      ...opt('role', role),
      ...opt('status', str(o.status)),
      ...opt('id', str(o.id)),
      ...opt('parentId', str(o.parentId)),
      ...(str(o.type) === 'message' ? { text: textOf(content) } : {}),
    }
    records.push(record)
  })
  return { records, trailingPartial, unparsedLines }
}

export type TurnAnswerResolution =
  | { readonly kind: 'completed'; readonly answer: string; readonly assistantRecordId?: string }
  | { readonly kind: 'cancelled'; readonly assistantRecordId?: string }
  | { readonly kind: 'unresolved'; readonly reason: UnresolvedReason }

export type UnresolvedReason =
  | 'no-assistant-record'
  | 'broken-parent-chain'
  | 'answer-precedes-turn'
  | 'stop-message-mismatch'
  | 'unknown-status'
  | 'empty-answer'
  /** The turn never reported an end (no Stop hook), e.g. WorkBuddy quit mid-answer. */
  | 'no-stop-event'
  /** Model-driven turn (no hook): the model closed the turn as failed. */
  | 'model-reported-failure'

export interface ResolveTurnInput {
  readonly transcript: ParsedTranscript
  /**
   * Number of lines in the transcript when `UserPromptSubmit` fired for this turn.
   * R0b-2: the turn's user record is written at exactly this index or later.
   */
  readonly promptCursor: number
  /** `Stop.last_assistant_message`, when the hook provided it. */
  readonly lastAssistantMessage?: string
}

/**
 * Decide how the current turn ended. Takes the last assistant message, walks its
 * parent chain to the user record that started its branch, and requires that user
 * record to belong to this turn (index ≥ prompt cursor). `completed` needs a
 * non-empty answer that matches `Stop.last_assistant_message` when provided;
 * `incomplete` means the user cancelled. Anything else stays unresolved —
 * never guessed as completed.
 */
export function resolveTurnAnswer(input: ResolveTurnInput): TurnAnswerResolution {
  const { records } = input.transcript
  const byId = new Map<string, TranscriptRecord>()
  for (const r of records) if (r.id !== undefined) byId.set(r.id, r)
  let assistant: TranscriptRecord | undefined
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    if (r?.type === 'message' && r.role === 'assistant') { assistant = r; break }
  }
  if (assistant === undefined) return { kind: 'unresolved', reason: 'no-assistant-record' }

  let cursor: TranscriptRecord | undefined = assistant
  const visited = new Set<string>()
  let user: TranscriptRecord | undefined
  while (cursor !== undefined) {
    if (cursor.type === 'message' && cursor.role === 'user') { user = cursor; break }
    if (cursor.parentId === undefined || visited.has(cursor.parentId)) break
    visited.add(cursor.parentId)
    cursor = byId.get(cursor.parentId)
  }
  if (user === undefined) return { kind: 'unresolved', reason: 'broken-parent-chain' }
  if (user.index < input.promptCursor) return { kind: 'unresolved', reason: 'answer-precedes-turn' }

  const idPart = assistant.id === undefined ? {} : { assistantRecordId: assistant.id }
  if (assistant.status === 'incomplete') return { kind: 'cancelled', ...idPart }
  if (assistant.status !== 'completed') return { kind: 'unresolved', reason: 'unknown-status' }
  const answer = assistant.text ?? ''
  if (answer.trim().length === 0) return { kind: 'unresolved', reason: 'empty-answer' }
  if (input.lastAssistantMessage !== undefined && input.lastAssistantMessage !== answer) {
    return { kind: 'unresolved', reason: 'stop-message-mismatch' }
  }
  return { kind: 'completed', answer, ...idPart }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).join('')
}
function str(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined }
function opt<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V }
}
