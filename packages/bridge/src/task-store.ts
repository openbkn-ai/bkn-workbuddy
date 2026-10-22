// Per-task state shared by the MCP bridge (one process per WorkBuddy task) and the
// hook processes (one per event). Every read-modify-write runs under a lock
// directory and replaces the file atomically, so concurrent processes never see
// or produce a half-written record.
//
// What is stored: the task's binding, the platform conversation id, the selection
// keys of the last network list, and recent turns. A turn's question and answer
// are kept only while the turn still needs them (start / finish) and are removed
// once it is closed. Never stored: credentials, tool payloads.
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, mkdir } from 'node:fs'
import { join } from 'node:path'
import type { TaskBinding, TurnState } from '@bkn-workbuddy/core'

export interface SelectionEntry {
  readonly networkId: string
  readonly displayName: string
}

export interface TaskRecord {
  readonly schemaVersion: 1
  readonly hostTaskKey: string
  readonly binding?: TaskBinding
  /** Conversation id returned by the platform; reused with `continue`. */
  readonly platformConversationId?: string
  readonly selection?: { readonly issuedAt: string; readonly issuedTurnKey?: string; readonly keys: Readonly<Record<string, SelectionEntry>> }
  readonly turns: readonly TurnState[]
}

export type UpdateOutcome<T> = { readonly task?: TaskRecord } & ({ readonly result: T } | { readonly error: unknown })

export const MAX_TURNS = 20
const LOCK_WAIT_MS = 30_000
/** A lock older than this is from a crashed process (no operation holds it this long). */
const LOCK_STALE_MS = 180_000

export class TaskLockTimeoutError extends Error {
  constructor() {
    super('task state is busy')
    this.name = 'TaskLockTimeoutError'
  }
}

export function emptyTask(hostTaskKey: string): TaskRecord {
  return { schemaVersion: 1, hostTaskKey, turns: [] }
}

export class TaskStore {
  constructor(readonly dir: string) {}

  fileOf(hostTaskKey: string): string {
    const name = createHash('sha256').update(hostTaskKey).digest('hex').slice(0, 32)
    return join(this.dir, `${name}.json`)
  }

  /** Read without locking; for display only. */
  read(hostTaskKey: string): TaskRecord | undefined {
    return this.load(this.fileOf(hostTaskKey), hostTaskKey)
  }

  exists(hostTaskKey: string): boolean {
    try { statSync(this.fileOf(hostTaskKey)); return true } catch { return false }
  }

  /**
   * Run `fn` with exclusive access to the task. `fn` returns the new record (or
   * undefined to leave it unchanged) and either a result or an error; the record
   * is saved before the error is thrown. An exception from `fn` saves nothing.
   * The lock is held across `fn`, including any platform call it awaits.
   */
  async update<T>(hostTaskKey: string, fn: (task: TaskRecord) => Promise<UpdateOutcome<T>> | UpdateOutcome<T>): Promise<T> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const file = this.fileOf(hostTaskKey)
    const lock = `${file}.lock`
    await acquire(lock)
    try {
      const current = this.load(file, hostTaskKey) ?? emptyTask(hostTaskKey)
      const outcome = await fn(current)
      if (outcome.task !== undefined) writeAtomic(file, prune(outcome.task))
      if ('error' in outcome) throw outcome.error
      return outcome.result
    } finally {
      rmSync(lock, { recursive: true, force: true })
    }
  }

  private load(file: string, hostTaskKey: string): TaskRecord | undefined {
    let text: string
    try { text = readFileSync(file, 'utf8') } catch { return undefined }
    try {
      const value = JSON.parse(text) as TaskRecord
      // A hash collision or a foreign file must never hand one task another task's scope.
      if (value?.schemaVersion !== 1 || value.hostTaskKey !== hostTaskKey || !Array.isArray(value.turns)) return undefined
      return value
    } catch {
      return undefined
    }
  }
}

/** Keep the newest turns; drop question/answer text from turns that no longer need it. */
export function prune(task: TaskRecord): TaskRecord {
  const turns = task.turns.slice(-MAX_TURNS).map(t => {
    if (t.phase === 'observed' || t.phase === 'active') return t
    if (t.phase === 'pending_close') return { ...t, question: '' }
    const { resolution, ...rest } = t
    return { ...rest, question: '', ...(resolution === undefined ? {} : { resolution: resolution.kind === 'completed' ? { ...resolution, answer: '' } : resolution }) }
  })
  return { ...task, turns }
}

function writeAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 })
  try {
    renameSync(tmp, file)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

async function acquire(lock: string): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MS
  let delay = 10
  for (;;) {
    const created = await new Promise<boolean>((resolve, reject) => {
      mkdir(lock, { mode: 0o700 }, error => {
        if (!error) resolve(true)
        else if (error.code === 'EEXIST') resolve(false)
        else reject(error)
      })
    })
    if (created) return
    try {
      if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { rmSync(lock, { recursive: true, force: true }); continue }
    } catch { continue }
    if (Date.now() > deadline) throw new TaskLockTimeoutError()
    await new Promise(r => setTimeout(r, delay))
    delay = Math.min(delay * 2, 200)
  }
}
