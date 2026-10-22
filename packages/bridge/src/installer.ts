#!/usr/bin/env node
// Local installer for the WorkBuddy adapter (G1: user-level hooks + custom MCP).
//
//   installer plan|install|status|doctor|login|uninstall [options]
//
//   install   --gateway <signed bkn-gateway> [--node <node>] [--scene <json>] [--settings <path>]
//   login     --origin <https://…> [--business-domain bd_public] [--ca-file <pem>]
//   uninstall [--purge]   also removes task state and the stored credential
//
// The installer never handles WorkBuddy's MCP file (it holds other connectors'
// secrets); it prints the MCP entry for the user to paste. The credential is read
// with hidden input and handed straight to the gateway's stdin.
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { catalogFingerprint, isRecord, type PlatformTool } from '@bkn-workbuddy/core'
import { GatewayClient } from './gateway-client.js'
import { formatSettings, HOOK_EVENTS, hookCommand, ourHooks, parseSettings, withOurHooks, withoutOurHooks } from './hook-settings.js'
import { SERVER_NAME, SERVER_VERSION } from './mcp-server.js'
import { appDir, dataRoot, gatewayFileName, legacyRoots, logDir } from './paths.js'
import { REVIEWED_FINGERPRINTS } from './tools.js'
import { userStateOf } from './user-state.js'

const here = dirname(fileURLToPath(import.meta.url))
const SCENE_FILE = 'governed-business-analysis.v1.json'

interface InstallRecord { readonly version: string; readonly node: string; readonly installedAt: string; readonly settings: string; readonly settingsBackup?: string }

function opt(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

function settingsPath(args: readonly string[]): string {
  return opt(args, '--settings') ?? join(homedir(), '.workbuddy', 'settings.json')
}

function layout() {
  const app = appDir()
  return {
    app,
    cli: join(app, 'bridge', 'cli.js'),
    gateway: join(app, 'bin', gatewayFileName()),
    scene: join(app, 'scenes', SCENE_FILE),
    record: join(app, 'install.json'),
    hookLog: join(logDir(), 'hook.log'),
    hookStderr: join(logDir(), 'hook-stderr.log'),
  }
}

/** The gateway shares the data root; keep it aligned when tests or portable installs override it. */
function gatewayEnv(): Record<string, string> {
  return process.env.BKN_WORKBUDDY_HOME && !process.env.BKN_GATEWAY_CONFIG_DIR ? { BKN_GATEWAY_CONFIG_DIR: dataRoot() } : {}
}

/** Remove files left by development bundles that installed outside ~/.bkn-workbuddy. */
function removeLegacy(): string[] {
  const removed: string[] = []
  for (const root of legacyRoots()) {
    if (!existsSync(root)) continue
    rmSync(root, { recursive: true, force: true })
    removed.push(root)
  }
  return removed
}

function mcpEntry(node: string, cli: string): Record<string, unknown> {
  return { mcpServers: { [SERVER_NAME]: { command: node, args: [cli, 'mcp'] } } }
}

function readRecord(): InstallRecord | undefined {
  try { return JSON.parse(readFileSync(layout().record, 'utf8')) as InstallRecord } catch { return undefined }
}

// ---- install ----------------------------------------------------------------

function copyJs(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  for (const f of readdirSync(from)) if (f.endsWith('.js')) copyFileSync(join(from, f), join(to, f))
}

function stageApp(stage: string, gatewaySource: string, sceneSource: string): void {
  copyJs(here, join(stage, 'bridge'))
  writeFileSync(join(stage, 'bridge', 'package.json'), JSON.stringify({ type: 'module', private: true }) + '\n')
  const coreEntry = createRequire(import.meta.url).resolve('@bkn-workbuddy/core')
  const coreDir = join(stage, 'node_modules', '@bkn-workbuddy', 'core')
  copyJs(dirname(coreEntry), join(coreDir, 'dist', 'src'))
  writeFileSync(join(coreDir, 'package.json'), JSON.stringify({ name: '@bkn-workbuddy/core', type: 'module', exports: { '.': './dist/src/index.js' } }) + '\n')
  mkdirSync(join(stage, 'bin'), { recursive: true })
  copyFileSync(gatewaySource, join(stage, 'bin', gatewayFileName()))
  chmodSync(join(stage, 'bin', gatewayFileName()), 0o755)
  mkdirSync(join(stage, 'scenes'), { recursive: true })
  copyFileSync(sceneSource, join(stage, 'scenes', SCENE_FILE))
}

function writeSettings(path: string, transform: (json: Record<string, unknown>) => Record<string, unknown>): string | undefined {
  if (!existsSync(path)) throw new Error(`没有找到 WorkBuddy 设置文件：${path}。请先打开一次 WorkBuddy 再安装。`)
  const raw = readFileSync(path, 'utf8')
  const { json, format } = parseSettings(raw)
  const next = transform(json)
  if (JSON.stringify(next) === JSON.stringify(json)) return undefined
  const backup = `${path}.bkn-workbuddy-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`
  copyFileSync(path, backup)
  try { chmodSync(backup, 0o600) } catch { /* not meaningful on Windows */ }
  const tmp = `${path}.bkn-workbuddy-tmp-${process.pid}`
  writeFileSync(tmp, formatSettings(next, format), { mode: statSync(path).mode & 0o777 })
  renameSync(tmp, path)
  return backup
}

function install(args: readonly string[]): number {
  const gatewaySource = opt(args, '--gateway')
  if (!gatewaySource || !existsSync(gatewaySource)) { console.error('需要 --gateway <已签名的 bkn-gateway 可执行文件>'); return 2 }
  const node = resolve(opt(args, '--node') ?? process.execPath)
  if (!isAbsolute(node) || !existsSync(node)) { console.error(`node 路径不存在：${node}`); return 2 }
  const sceneSource = opt(args, '--scene') ?? resolve(here, '../../../../scenes', SCENE_FILE)
  if (!existsSync(sceneSource)) { console.error(`没有找到场景包：${sceneSource}`); return 2 }
  const l = layout()
  const settings = settingsPath(args)
  hookCommand(node, l.cli, 'Stop', l.hookStderr) // validates the paths before anything is written

  const stage = `${l.app}.new-${process.pid}`
  const old = `${l.app}.old-${process.pid}`
  rmSync(stage, { recursive: true, force: true })
  stageApp(stage, gatewaySource, sceneSource)
  if (existsSync(l.app)) {
    try { renameSync(l.app, old) } catch {
      rmSync(stage, { recursive: true, force: true })
      console.error('无法替换已安装的文件（可能正在使用）。请完全退出 WorkBuddy 后重试。')
      return 1
    }
  }
  renameSync(stage, l.app)
  rmSync(old, { recursive: true, force: true })
  mkdirSync(logDir(), { recursive: true })
  const legacy = removeLegacy()

  const backup = writeSettings(settings, json => withOurHooks(json, node, l.cli, l.hookStderr))
  const record: InstallRecord = { version: SERVER_VERSION, node, installedAt: new Date().toISOString(), settings, ...(backup ? { settingsBackup: backup } : {}) }
  writeFileSync(l.record, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })

  if (legacy.length > 0) console.log(`已清理旧版本的安装位置：${legacy.join('、')}（其中的登录信息一并删除，需要重新登录）`)
  console.log(`已安装到：${l.app}
WorkBuddy 钩子：${HOOK_EVENTS.map(e => e.event).join('、')}${backup ? `（设置备份：${backup}）` : '（已是最新）'}

接下来：
1. 在 WorkBuddy「自定义连接器 / 自定义 MCP」中粘贴下面的配置（不含任何凭证），点「信任」启用：
${JSON.stringify(mcpEntry(node, l.cli), null, 2)}
2. 登录 OpenBKN（输入不会显示）：
   "${process.execPath}" "${join(here, 'installer.js')}" login --origin https://<平台地址> [--ca-file <私有 CA 证书>]
3. 完全退出并重新打开 WorkBuddy，在任意任务里发送一条消息，然后运行 doctor：它会检查钩子是否真的在 WorkBuddy 中运行过。`)
  if (node.includes(`${join('.workbuddy', 'binaries')}`)) {
    console.log('\n提示：当前使用 WorkBuddy 自带的 Node，WorkBuddy 升级后路径可能变化；届时重新运行 install 即可。')
  }
  return 0
}

// ---- login ------------------------------------------------------------------

function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin
  if (!stdin.isTTY) {
    return new Promise(resolveText => {
      let text = ''
      stdin.setEncoding('utf8')
      stdin.on('data', c => { text += c })
      stdin.on('end', () => resolveText(text.trim()))
    })
  }
  process.stdout.write(prompt)
  return new Promise((resolveText, reject) => {
    let text = ''
    stdin.setRawMode(true)
    stdin.setEncoding('utf8')
    stdin.resume()
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') { done(); return }
        if (ch === '\u0003') { done(); reject(new Error('cancelled')); return }
        if (ch === '\u007f' || ch === '\b') text = text.slice(0, -1)
        else text += ch
      }
    }
    const done = () => { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stdout.write('\n'); resolveText(text.trim()) }
    stdin.on('data', onData)
  })
}

async function login(args: readonly string[]): Promise<number> {
  const origin = opt(args, '--origin')
  if (!origin) { console.error('需要 --origin https://<平台地址>'); return 2 }
  const gateway = layout().gateway
  if (!existsSync(gateway)) { console.error('尚未安装，请先运行 install。'); return 1 }
  const secret = await readHidden('粘贴 OpenBKN 访问令牌或 AppKey（输入不显示），回车确认：')
  if (!secret) { console.error('没有输入凭证。'); return 1 }
  if (!/^[\x21-\x7e]+$/.test(secret)) {
    console.error(`读到 ${secret.length} 个字符，其中含有空格或令牌不会出现的字符，可能粘贴了别的内容。请重新复制后再试。`)
    return 1
  }
  console.log(`已读到 ${secret.length} 个字符，正在验证…`)
  const gwArgs = ['login', '--origin', origin, '--business-domain', opt(args, '--business-domain') ?? 'bd_public']
  const ca = opt(args, '--ca-file')
  if (ca) gwArgs.push('--ca-file', resolve(ca))
  return new Promise(resolveCode => {
    const child = spawn(gateway, gwArgs, { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true, env: { ...process.env, ...gatewayEnv() } })
    child.on('exit', code => resolveCode(code ?? 1))
    child.on('error', () => { console.error('无法启动 bkn-gateway。'); resolveCode(1) })
    child.stdin.end(secret + '\n')
  })
}

// ---- status / doctor --------------------------------------------------------

interface Check { readonly ok: boolean | 'warn'; readonly label: string; readonly hint?: string }

async function doctor(args: readonly string[], deep: boolean): Promise<number> {
  const l = layout()
  const record = readRecord()
  const checks: Check[] = []
  const add = (ok: Check['ok'], label: string, hint?: string) => checks.push({ ok, label, ...(hint ? { hint } : {}) })

  add(existsSync(l.cli) && existsSync(l.gateway), `程序文件 ${l.app}`, '运行 install 重新安装')
  const node = record?.node
  add(node !== undefined && existsSync(node), `Node：${node ?? '未记录'}`, 'Node 路径已失效（WorkBuddy 升级后常见），请重新运行 install')
  if (node?.includes(join('.workbuddy', 'binaries'))) add('warn', '使用 WorkBuddy 自带 Node，升级后需重新运行 install')

  const settings = settingsPath(args)
  let hooksOk = false
  try {
    const { json } = parseSettings(readFileSync(settings, 'utf8'))
    const ours = ourHooks(json)
    hooksOk = node !== undefined && HOOK_EVENTS.every(e => ours.filter(h => h.event === e.event).length === 1 && ours.some(h => h.command === hookCommand(node, l.cli, e.event, l.hookStderr)))
  } catch { /* reported below */ }
  add(hooksOk, `WorkBuddy 钩子配置（${settings}）`, '运行 install 修复钩子，然后完全重启 WorkBuddy')
  // The hooks run inside WorkBuddy's sandbox; only their own traces prove they work there.
  let lastRun: Date | undefined
  try { lastRun = statSync(l.hookLog).mtime } catch { /* never ran */ }
  add(lastRun ? true : 'warn', lastRun ? `钩子最近一次在 WorkBuddy 中运行：${lastRun.toLocaleString()}` : '还没有钩子运行记录',
    '完全重启 WorkBuddy 后在任意任务里发送一条消息，再运行 doctor；仍无记录说明钩子没能在 WorkBuddy 中运行')
  let stderrBytes = 0
  try { stderrBytes = statSync(l.hookStderr).size } catch { /* none */ }
  if (stderrBytes > 0) add(false, `钩子报过错（${l.hookStderr}，${stderrBytes} 字节）`, '把该文件内容反馈给插件维护者')
  for (const root of legacyRoots()) if (existsSync(root)) add('warn', `发现旧版本的安装位置 ${root}`, '运行 install 或 uninstall --purge 清理')

  const version = existsSync(l.gateway) ? spawnSync(l.gateway, ['version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true }) : undefined
  const runs = version?.status === 0
  add(runs, `凭证网关 ${runs ? version!.stdout.trim() : ''}`.trim(),
    process.platform === 'win32' ? '网关无法运行：可能被安全软件隔离（如 360），请在安全软件中恢复并信任后重试' : '网关无法运行：请重新安装')

  if (runs && deep) {
    const client = new GatewayClient({ command: l.gateway, requestTimeoutMs: 30_000, env: gatewayEnv() })
    try {
      const status = await client.status()
      add(status.configured && status.credential === true, `已登录 OpenBKN ${status.origin ?? ''}`.trim(), '运行 login 登录（插件升级后需重新登录一次）')
      if (status.configured && status.credential === true) {
        try {
          await client.catalogPage(0, 1)
          add(true, '平台可访问，凭证有效')
          const tools = (await client.tools()).filter((t): t is PlatformTool => isRecord(t) && typeof t.name === 'string' && isRecord(t.inputSchema))
          const fp = catalogFingerprint(tools)
          add(REVIEWED_FINGERPRINTS.includes(fp), `平台查询工具版本 ${fp.slice(0, 12)}`, '与审核过的版本不一致，业务查询将被暂停；请联系插件维护者')
        } catch (error) {
          const s = userStateOf(error)
          add(false, `平台检查：${s.code}`, s.message)
        }
      }
    } catch (error) {
      add(false, '读取网关状态失败', userStateOf(error).message)
    } finally {
      await client.close()
    }
  }

  for (const c of checks) console.log(`${c.ok === true ? '✓' : c.ok === 'warn' ? '!' : '✗'} ${c.label}${c.ok === true ? '' : c.hint ? `\n    → ${c.hint}` : ''}`)
  if (deep) console.log('\n另请在 WorkBuddy「自定义连接器」中确认 openbkn-business-context 已启用（安装器不读取该配置）。')
  return checks.some(c => c.ok === false) ? 1 : 0
}

// ---- uninstall --------------------------------------------------------------

function uninstall(args: readonly string[]): number {
  const l = layout()
  const settings = settingsPath(args)
  let backup: string | undefined
  if (existsSync(settings)) backup = writeSettings(settings, withoutOurHooks)
  if (args.includes('--purge') && existsSync(l.gateway)) spawnSync(l.gateway, ['logout'], { stdio: 'ignore', windowsHide: true, env: { ...process.env, ...gatewayEnv() } })
  rmSync(l.app, { recursive: true, force: true })
  if (args.includes('--purge')) {
    rmSync(dataRoot(), { recursive: true, force: true })
    removeLegacy()
  }
  console.log(`已移除钩子${backup ? `（设置备份：${backup}）` : ''}和程序文件${args.includes('--purge') ? '、任务状态与已保存的凭证' : ''}。
请在 WorkBuddy「自定义连接器」中删除 ${SERVER_NAME}，然后完全退出并重新打开 WorkBuddy。`)
  return 0
}

function plan(args: readonly string[]): number {
  const l = layout()
  const node = resolve(opt(args, '--node') ?? process.execPath)
  console.log(JSON.stringify({
    app: l.app, settings: settingsPath(args), node,
    hooks: HOOK_EVENTS.map(e => ({ event: e.event, command: hookCommand(node, l.cli, e.event, l.hookStderr) })),
    mcp: mcpEntry(node, l.cli),
  }, null, 2))
  return 0
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...args] = argv
  switch (command) {
    case 'plan': return plan(args)
    case 'install': return install(args)
    case 'login': return login(args)
    case 'status': return doctor(args, false)
    case 'doctor': return doctor(args, true)
    case 'uninstall': return uninstall(args)
    default:
      console.error('usage: installer plan|install|status|doctor|login|uninstall [options]')
      return 64
  }
}

if (process.argv[1] !== undefined && /installer\.(js|mjs)$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code }, error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
}
