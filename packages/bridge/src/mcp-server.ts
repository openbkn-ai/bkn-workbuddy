// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0): initialize,
// tools/list, tools/call, ping. WorkBuddy starts one process per task (R0b), and
// identifies the task and turn in `tools/call` `_meta`.
import { createInterface } from 'node:readline'
import type { HostContext, ToolRouter } from './tools.js'
import { isRecord } from '@bkn-workbuddy/core'

export const SERVER_NAME = 'openbkn-business-context'
export const SERVER_VERSION = '0.1.0-dev'
const DEFAULT_PROTOCOL = '2025-06-18'

const INSTRUCTIONS = [
  '用于查询用户有权访问的 OpenBKN 企业业务知识网络（只读），例如订单、库存、采购、物料、交期、BOM、客户、供应商和经营指标。',
  '用户问企业业务数据而本任务还没有选网络时：先调用 openbkn_list_networks，把网络名称告诉用户并请用户确认，用户回复后再 openbkn_select_network（用户已说出网络名称时可直接选择）。不要先问用户数据在哪里。一个任务只用一个网络，换网络需新建任务。',
  '查询只使用本连接器提供的工具，不要自行编写 SQL、代码或 HTTP 请求。每个业务数字都要来自本轮的查询结果。',
  '每轮问答会在 OpenBKN 上留下记录，业务溯源在 OpenBKN 平台页面查看；查询结果附带页面链接时，可在回答末尾附上，不要自己编写依据或来源。',
  '查询返回 TURN_NOT_STARTED 时：调用 openbkn_begin_turn（question 用用户本轮原话），再重试查询；这一轮给出最终回答之前调用 openbkn_end_turn（answer 填最终回答全文）。',
  '任何 OpenBKN 工具返回错误（例如登录失效、平台无法访问）时，如实告诉用户原因和下一步，不要用之前对话、记忆或本地文件里的数字作答。',
].join('\n')

interface JsonRpcMessage {
  readonly jsonrpc?: string
  readonly id?: string | number | null
  readonly method?: string
  readonly params?: unknown
}

export function hostContextOf(params: Record<string, unknown>): HostContext {
  const meta = isRecord(params._meta) ? params._meta : {}
  const pick = (key: string) => (typeof meta[key] === 'string' && (meta[key] as string).length > 0 ? meta[key] as string : undefined)
  const taskKey = pick('workbuddy.ai/conversationId')
  const turnKey = pick('workbuddy.ai/requestId')
  return { ...(taskKey ? { taskKey } : {}), ...(turnKey ? { turnKey } : {}) }
}

export function runMcpServer(router: ToolRouter, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void> {
  const send = (message: unknown) => { output.write(JSON.stringify(message) + '\n') }
  const reply = (id: JsonRpcMessage['id'], result: unknown) => send({ jsonrpc: '2.0', id, result })
  const fail = (id: JsonRpcMessage['id'], code: number, message: string) => send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
  const inflight = new Set<Promise<void>>()

  const handle = async (msg: JsonRpcMessage): Promise<void> => {
    const isRequest = msg.id !== undefined && msg.id !== null
    const params = isRecord(msg.params) ? msg.params : {}
    switch (msg.method) {
      case 'initialize':
        return reply(msg.id, {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: INSTRUCTIONS,
        })
      case 'ping':
        return reply(msg.id, {})
      case 'tools/list':
        return reply(msg.id, { tools: await router.list() })
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : ''
        return reply(msg.id, await router.call(name, params.arguments, hostContextOf(params)))
      }
      default:
        // Notifications (initialized, cancelled, …) need no answer. A cancelled call still
        // finishes on the platform side; the turn is settled by the Stop hook.
        if (isRequest) fail(msg.id, -32601, `method not found: ${msg.method ?? ''}`)
    }
  }

  return new Promise(resolve => {
    const lines = createInterface({ input })
    lines.on('line', line => {
      if (!line.trim()) return
      let parsed: unknown
      try { parsed = JSON.parse(line) } catch { fail(null, -32700, 'parse error'); return }
      if (!isRecord(parsed)) { fail(null, -32600, 'invalid request'); return }
      const msg = parsed as JsonRpcMessage
      const task = handle(msg).catch(() => fail(msg.id, -32603, 'internal error')).finally(() => inflight.delete(task))
      inflight.add(task)
    })
    lines.on('close', () => { void Promise.allSettled([...inflight]).then(() => resolve()) })
  })
}
