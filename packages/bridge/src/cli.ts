#!/usr/bin/env node
// Entry points started by WorkBuddy:
//   bridge mcp                 MCP server (custom MCP config)
//   bridge hook <Event>        user-level command hook (UserPromptSubmit, Stop)
// Options: --gateway <path to bkn-gateway>, --scene <scene pack json>.
// Defaults come from the installed layout (paths.ts); BKN_GATEWAY_BIN overrides the gateway.
import { existsSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { validateScenePack, type ScenePack } from '@bkn-workbuddy/core'
import { GatewayClient } from './gateway-client.js'
import { handleHook, logHook } from './hook.js'
import { runMcpServer } from './mcp-server.js'
import { appDir, dataRoot, gatewayFileName, logDir, stateDir } from './paths.js'
import { BridgeSession } from './session.js'
import { TaskStore } from './task-store.js'
import { ToolRouter, type SelfCheck } from './tools.js'

export const DEFAULT_SCENE = 'governed-business-analysis.v1.json'

function option(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

function gatewayPath(args: readonly string[]): string {
  return option(args, '--gateway') ?? process.env.BKN_GATEWAY_BIN ?? join(appDir(), 'bin', gatewayFileName())
}

function loadScene(args: readonly string[]): ScenePack | undefined {
  const path = option(args, '--scene') ?? join(appDir(), 'scenes', DEFAULT_SCENE)
  if (!existsSync(path)) return undefined
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return validateScenePack(value).length === 0 ? value as ScenePack : undefined
  } catch {
    return undefined
  }
}

/** The gateway shares the data root; keep it aligned when tests or portable installs override it. */
function gatewayEnv(): Record<string, string> {
  return process.env.BKN_WORKBUDDY_HOME && !process.env.BKN_GATEWAY_CONFIG_DIR ? { BKN_GATEWAY_CONFIG_DIR: dataRoot() } : {}
}

/** What this process can see from inside the WorkBuddy sandbox. */
function selfCheck(gateway: string): SelfCheck {
  return () => {
    const probe = (fn: () => unknown) => { try { return fn() } catch (e) { return (e as NodeJS.ErrnoException).code ?? 'error' } }
    const mtime = (f: string) => probe(() => statSync(f).mtime.toISOString())
    return {
      data_root: dataRoot(),
      gateway_found: existsSync(gateway),
      state_dir_writable: probe(() => {
        mkdirSync(stateDir(), { recursive: true })
        const f = join(stateDir(), `.probe-${process.pid}`)
        writeFileSync(f, '')
        rmSync(f)
        return true
      }),
      last_hook_run: mtime(join(logDir(), 'hook.log')),
      hook_stderr_bytes: probe(() => statSync(join(logDir(), 'hook-stderr.log')).size),
    }
  }
}

function readStdin(): Promise<string> {
  return new Promise(resolve => {
    let text = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => { text += chunk })
    process.stdin.on('end', () => resolve(text))
    process.stdin.on('error', () => resolve(text))
  })
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv
  if (command === 'mcp') {
    const store = new TaskStore(stateDir())
    const gwPath = gatewayPath(rest)
    const gateway = new GatewayClient({ command: gwPath, env: gatewayEnv() })
    const router = new ToolRouter(new BridgeSession(store, gateway), gateway, loadScene(rest), undefined, selfCheck(gwPath))
    await runMcpServer(router, process.stdin, process.stdout)
    await gateway.close()
    return 0
  }
  if (command === 'hook') {
    const event = rest[0] ?? ''
    const logs = logDir()
    let gateway: GatewayClient | undefined
    try {
      const store = new TaskStore(stateDir())
      gateway = new GatewayClient({ command: gatewayPath(rest), requestTimeoutMs: 20_000, env: gatewayEnv() })
      const outcome = await handleHook(event, await readStdin(), {
        session: new BridgeSession(store, gateway), hasTask: key => store.exists(key), logDir: logs,
      })
      logHook(logs, event, outcome)
    } catch (error) {
      logHook(logs, event, `error ${error instanceof Error ? (('code' in error && String(error.code)) || error.name) : 'unknown'}`)
    } finally {
      await gateway?.close().catch(() => undefined)
    }
    return 0 // never block WorkBuddy
  }
  process.stderr.write('usage: bridge mcp | bridge hook <UserPromptSubmit|Stop> [--gateway <path>] [--scene <path>]\n')
  return 64
}

const invokedDirectly = process.argv[1] !== undefined && /cli\.(js|mjs)$/.test(process.argv[1])
if (invokedDirectly) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code }, () => { process.exitCode = process.argv[2] === 'hook' ? 0 : 1 })
}
