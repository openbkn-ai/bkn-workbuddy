// Merge and remove this adapter's entries in WorkBuddy's user settings
// (`~/.workbuddy/settings.json` → `hooks`), leaving everything else untouched.
//
// Command form (R0b-W): WorkBuddy runs hook commands with sh on macOS and Git Bash
// on Windows, and a hook exiting with code 2 rejects the user's prompt. So every
// command is "quoted forward-slash paths" (valid in both shells, safe with spaces)
// and ends in `|| true`, which keeps the exit code 0 even if node is missing.
// stderr is appended to a log so failures before the bridge's own logging runs
// (missing node, module not found) are still visible to doctor.
import { isRecord } from '@bkn-workbuddy/core'

export const HOOK_MARKER = '# bkn-workbuddy-hook'
export const HOOK_EVENTS = [
  { event: 'UserPromptSubmit', timeout: 10 },
  { event: 'Stop', timeout: 30 },
] as const

export function hookCommand(nodePath: string, cliPath: string, event: string, stderrLog: string): string {
  for (const p of [nodePath, cliPath, stderrLog]) {
    if (/["$`\\]/.test(p.replace(/\\/g, '/')) || /[\r\n]/.test(p)) throw new Error(`path cannot be used in a hook command: ${p}`)
  }
  const slash = (p: string) => p.replace(/\\/g, '/')
  return `"${slash(nodePath)}" "${slash(cliPath)}" hook ${event} 2>>"${slash(stderrLog)}" || true ${HOOK_MARKER}`
}

export function isOurHook(hook: unknown): boolean {
  return isRecord(hook) && typeof hook.command === 'string' && hook.command.includes(HOOK_MARKER)
}

export interface OurHook { readonly event: string; readonly command: string }

export function ourHooks(settings: Record<string, unknown>): OurHook[] {
  const found: OurHook[] = []
  const hooks = isRecord(settings.hooks) ? settings.hooks : {}
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue
    for (const g of groups) {
      if (!isRecord(g) || !Array.isArray(g.hooks)) continue
      for (const h of g.hooks) if (isOurHook(h)) found.push({ event, command: (h as { command: string }).command })
    }
  }
  return found
}

/** Settings with exactly one entry of ours per event (replacing older ones). */
export function withOurHooks(settings: Record<string, unknown>, nodePath: string, cliPath: string, stderrLog: string): Record<string, unknown> {
  if (settings.hooks !== undefined && !isRecord(settings.hooks)) throw new Error('existing "hooks" in WorkBuddy settings is not an object; nothing written')
  const base = withoutOurHooks(settings)
  const hooks: Record<string, unknown> = isRecord(base.hooks) ? { ...base.hooks } : {}
  for (const { event, timeout } of HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? [...hooks[event] as unknown[]] : []
    groups.push({ hooks: [{ type: 'command', command: hookCommand(nodePath, cliPath, event, stderrLog), timeout }] })
    hooks[event] = groups
  }
  return { ...base, hooks }
}

export function withoutOurHooks(settings: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(settings.hooks)) return { ...settings }
  const hooks: Record<string, unknown> = {}
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) { hooks[event] = groups; continue }
    const kept = groups
      .map(g => (isRecord(g) && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter(h => !isOurHook(h)) } : g))
      .filter(g => !(isRecord(g) && Array.isArray(g.hooks) && g.hooks.length === 0))
    if (kept.length > 0) hooks[event] = kept
  }
  const { hooks: _old, ...rest } = settings
  return Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest
}

/** Parse settings text keeping its formatting (BOM, indentation, line ends) for the write back. */
export function parseSettings(raw: string): { json: Record<string, unknown>; format: { bom: boolean; indent: string | number; eol: string } } {
  const bom = raw.charCodeAt(0) === 0xfeff
  const text = bom ? raw.slice(1) : raw
  const json: unknown = JSON.parse(text)
  if (!isRecord(json)) throw new Error('WorkBuddy settings root is not an object')
  const indent = /\n\t"/.test(text) ? '\t' : (/\n {4}"/.test(text) && !/\n {2}"/.test(text) ? 4 : 2)
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  return { json, format: { bom, indent, eol } }
}

export function formatSettings(json: Record<string, unknown>, format: { bom: boolean; indent: string | number; eol: string }): string {
  return (format.bom ? '﻿' : '') + JSON.stringify(json, null, format.indent).replace(/\n/g, format.eol) + format.eol
}
