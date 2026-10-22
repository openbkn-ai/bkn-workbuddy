// WorkBuddy user-level command hook entry (R0b-2, R0b-W). The hook must never
// block the user: it prints nothing, swallows every error and exits 0 — on
// Windows the hook runs under Git Bash and exit code 2 rejects the prompt.
// The installed command also ends in `|| true` for failures before this code runs.
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseTranscript, resolveTurnAnswer, isRecord, type TurnAnswerResolution } from '@bkn-workbuddy/core'
import type { BridgeSession } from './session.js'

export type HookEvent = 'UserPromptSubmit' | 'Stop'

/** Unresolved reasons that may clear up once WorkBuddy finishes writing the transcript. */
const RETRYABLE = new Set(['no-assistant-record', 'stop-message-mismatch', 'unknown-status', 'broken-parent-chain'])

export interface HookDeps {
  readonly session: BridgeSession
  /** Whether this task has bridge state; the Stop fast path skips everything else. */
  readonly hasTask: (hostTaskKey: string) => boolean
  readonly logDir?: string
  readonly retryDelayMs?: number
  readonly retries?: number
}

export async function handleHook(event: string, stdinText: string, deps: HookDeps): Promise<string> {
  let input: unknown
  try { input = JSON.parse(stdinText) } catch { return 'bad-input' }
  if (!isRecord(input)) return 'bad-input'
  const taskKey = str(input.session_id)
  const turnKey = str(input.generation_id)
  if (!taskKey || !turnKey) return 'no-keys'
  const transcriptPath = str(input.transcript_path)

  if (event === 'UserPromptSubmit') {
    const prompt = typeof input.prompt === 'string' ? input.prompt : ''
    const cursor = transcriptPath ? lineCount(transcriptPath) : 0
    return (await deps.session.recordPrompt(taskKey, turnKey, prompt, cursor)) ? 'recorded' : 'skipped'
  }
  if (event === 'Stop') {
    if (!deps.hasTask(taskKey)) return 'no-task'
    const last = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : undefined
    const resolution = await resolveWithRetry(transcriptPath, last, deps.session, taskKey, turnKey, deps.retries ?? 3, deps.retryDelayMs ?? 300)
    return deps.session.closeTurn(taskKey, turnKey, resolution)
  }
  return 'ignored'
}

async function resolveWithRetry(
  transcriptPath: string | undefined, last: string | undefined, session: BridgeSession,
  taskKey: string, turnKey: string, retries: number, delayMs: number,
): Promise<TurnAnswerResolution> {
  const cursor = session.promptCursorOf(taskKey, turnKey)
  if (!transcriptPath || cursor === undefined) return { kind: 'unresolved', reason: 'no-assistant-record' }
  let resolution: TurnAnswerResolution = { kind: 'unresolved', reason: 'no-assistant-record' }
  for (let attempt = 0; attempt <= retries; attempt++) {
    let text = ''
    try { text = readFileSync(transcriptPath, 'utf8') } catch { /* not written yet */ }
    resolution = resolveTurnAnswer({ transcript: parseTranscript(text), promptCursor: cursor, ...(last === undefined ? {} : { lastAssistantMessage: last }) })
    if (resolution.kind !== 'unresolved' || !RETRYABLE.has(resolution.reason)) return resolution
    if (attempt < retries) await new Promise(r => setTimeout(r, delayMs))
  }
  return resolution
}

/** Complete lines in the transcript; this turn's records are written at this index or later (R0b-2). */
function lineCount(path: string): number {
  try {
    let count = 0
    for (const byte of readFileSync(path)) if (byte === 0x0a) count++
    return count
  } catch {
    return 0
  }
}

/** One line per hook run with codes only — never prompts, answers or ids in clear. */
export function logHook(logDir: string | undefined, event: string, outcome: string): void {
  if (!logDir) return
  try {
    mkdirSync(logDir, { recursive: true, mode: 0o700 })
    const file = join(logDir, 'hook.log')
    try { if (statSync(file).size > 512 * 1024) return } catch { /* new file */ }
    appendFileSync(file, `${new Date().toISOString()} ${event} ${outcome.slice(0, 80)}\n`, { mode: 0o600 })
  } catch { /* logging must not fail the hook */ }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
