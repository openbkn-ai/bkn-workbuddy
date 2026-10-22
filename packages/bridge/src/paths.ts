// Per-user locations of the bridge, shared with the gateway (gateway/config.go).
// Everything lives in ~/.bkn-workbuddy on every platform. WorkBuddy runs hook
// and MCP processes in a sandbox; on Windows that sandbox hides everything
// under %LOCALAPPDATA% (including AgentConnectors, despite its default
// extraAllowWrite entry) while dot-directories in the user's home stay visible
// (host acceptance run2, 2026-10-20). Nothing here ever holds a credential in clear.
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Root of the adapter's per-user data; `BKN_WORKBUDDY_HOME` overrides it (tests, portable installs). */
export function dataRoot(env: NodeJS.ProcessEnv = process.env, _platform: NodeJS.Platform = process.platform): string {
  if (env.BKN_WORKBUDDY_HOME) return env.BKN_WORKBUDDY_HOME
  return join(homedir(), '.bkn-workbuddy')
}

/** Locations used by earlier development bundles; removed on install/uninstall. */
export function legacyRoots(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  if (env.BKN_WORKBUDDY_HOME) return []
  if (platform === 'win32') {
    const roots = [env.LOCALAPPDATA, env.APPDATA].filter((b): b is string => !!b).map(b => join(b, 'bkn-workbuddy'))
    if (env.LOCALAPPDATA) roots.push(join(env.LOCALAPPDATA, 'AgentConnectors', 'bkn-workbuddy'))
    return roots
  }
  if (platform === 'darwin') {
    const support = join(homedir(), 'Library', 'Application Support')
    return [join(support, 'bkn-workbuddy'), join(support, 'AgentConnectors', 'bkn-workbuddy')]
  }
  return [join(homedir(), '.local', 'state', 'bkn-workbuddy'), join(homedir(), '.config', 'bkn-workbuddy'), join(homedir(), '.local', 'share', 'agent-connectors', 'bkn-workbuddy')]
}

/** Task state files (one per WorkBuddy task). */
export function stateDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return join(dataRoot(env, platform), 'state')
}

export function logDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return join(dataRoot(env, platform), 'logs')
}

/** Installed program files: bridge, core and the signed gateway. */
export function appDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return join(dataRoot(env, platform), 'app')
}

export function gatewayFileName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'bkn-gateway.exe' : 'bkn-gateway'
}
