// Client for the signed credential gateway (`bkn-gateway serve`), which owns the
// OpenBKN credential and every authenticated request (TECHNICAL_PLAN §0.9).
// Protocol: one JSON object per line on stdin/stdout, see gateway/serve.go.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

/** Stable error codes from gateway/platform.go and serve.go, plus client-side ones. */
export type GatewayErrorCode =
  | 'AUTHENTICATION_REQUIRED' | 'FORBIDDEN' | 'NOT_DISCLOSED' | 'PLATFORM_UNAVAILABLE' | 'PLATFORM_ERROR'
  | 'REDIRECT_REFUSED' | 'CERTIFICATE_ERROR' | 'OUTPUT_OVERFLOW' | 'INVALID_RESPONSE' | 'MCP_ERROR' | 'CREDENTIAL_STORE_ERROR'
  | 'POLICY_REFUSED' | 'BAD_REQUEST' | 'INTERNAL'
  // client side
  | 'NOT_CONFIGURED' | 'GATEWAY_TIMEOUT' | 'GATEWAY_EXITED' | 'GATEWAY_UNAVAILABLE'

export class GatewayCallError extends Error {
  constructor(
    readonly code: GatewayErrorCode | string,
    message: string,
    readonly httpStatus?: number,
    readonly platformCode?: string,
  ) {
    super(message)
    this.name = 'GatewayCallError'
  }
}

export interface ManagedContext {
  readonly knowledgeNetworkId: string
  readonly hostTaskKey?: string
}

/** Platform pages the bridge may link to (gateway `platform.capabilities`). */
export interface PlatformCapabilities {
  readonly edition?: string
  /** Studio offers the business provenance page (Enterprise). */
  readonly businessProvenance: boolean
}

export interface GatewayStatus {
  readonly version: string
  readonly configured: boolean
  readonly origin?: string
  readonly businessDomain?: string
  readonly credential?: boolean
}

export interface McpToolResult {
  readonly content?: readonly { readonly type?: string; readonly text?: string }[]
  readonly isError?: boolean
  readonly structuredContent?: unknown
}

export interface GatewayClientOptions {
  /** Absolute path of the signed `bkn-gateway` executable. */
  readonly command: string
  readonly args?: readonly string[]
  /** Extra environment for the gateway process (never a credential). */
  readonly env?: Readonly<Record<string, string>>
  readonly requestTimeoutMs?: number
}

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: GatewayCallError) => void
  readonly timer: NodeJS.Timeout
}

const STDERR_TAIL = 2048

export class GatewayClient {
  private child: ChildProcessWithoutNullStreams | undefined
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private stderrTail = ''
  private closed = false

  constructor(private readonly options: GatewayClientOptions) {}

  status(): Promise<GatewayStatus> { return this.request('status') }
  catalogPage(offset: number, limit: number): Promise<unknown> { return this.request('catalog.page', { offset, limit }) }
  tools(): Promise<readonly unknown[]> { return this.request('mcp.tools') }
  callTool(tool: string, args: Readonly<Record<string, unknown>>, managed: ManagedContext): Promise<McpToolResult> {
    return this.request('mcp.call', { tool, arguments: args, managed })
  }
  operations(interactionId: string): Promise<unknown> { return this.request('obs.operations', { interactionId }) }
  businessGraph(interactionId: string): Promise<unknown> { return this.request('obs.businessGraph', { interactionId }) }
  async capabilities(): Promise<PlatformCapabilities> {
    const raw = await this.request('platform.capabilities', {})
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    return { businessProvenance: r.businessProvenance === true, ...(typeof r.edition === 'string' ? { edition: r.edition } : {}) }
  }

  request<T>(op: string, params?: unknown, timeoutMs = this.options.requestTimeoutMs ?? 90_000): Promise<T> {
    if (this.closed) return Promise.reject(new GatewayCallError('GATEWAY_UNAVAILABLE', 'gateway client is closed'))
    let child: ChildProcessWithoutNullStreams
    try { child = this.ensureChild() } catch (error) {
      return Promise.reject(error instanceof GatewayCallError ? error : new GatewayCallError('GATEWAY_UNAVAILABLE', 'cannot start the gateway'))
    }
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        // The gateway serves requests in order; a stuck one blocks the rest, so restart it.
        this.failAll(new GatewayCallError('GATEWAY_TIMEOUT', `gateway did not answer "${op}" in ${timeoutMs} ms`))
        this.kill()
      }, timeoutMs)
      this.pending.set(id, { resolve: v => resolve(v as T), reject, timer })
      const line = JSON.stringify(params === undefined ? { id, op } : { id, op, params }) + '\n'
      child.stdin.write(line, error => {
        if (error) this.settle(id, undefined, new GatewayCallError('GATEWAY_UNAVAILABLE', 'cannot write to the gateway'))
      })
    })
  }

  async close(): Promise<void> {
    this.closed = true
    this.failAll(new GatewayCallError('GATEWAY_UNAVAILABLE', 'gateway client is closed'))
    const child = this.child
    if (!child) return
    await new Promise<void>(resolve => {
      child.once('exit', () => resolve())
      child.stdin.end()
      setTimeout(() => { child.kill(); resolve() }, 2000).unref()
    })
  }

  /** Last lines the gateway wrote to stderr; the gateway never prints credentials. */
  diagnostics(): string { return this.stderrTail }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child
    const child = spawn(this.options.command, [...(this.options.args ?? ['serve'])], {
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    this.stderrTail = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL) })
    const lines = createInterface({ input: child.stdout })
    lines.on('line', line => this.onLine(line))
    // Only the current child's failure fails pending requests: a child replaced after a
    // timeout exits asynchronously, when requests may already belong to its successor.
    child.on('error', () => {
      if (this.child !== child) return
      this.child = undefined
      this.failAll(new GatewayCallError('GATEWAY_UNAVAILABLE', 'cannot start the gateway'))
    })
    child.on('exit', code => {
      if (this.child !== child) return
      this.child = undefined
      const notConfigured = /not configured/i.test(this.stderrTail)
      this.failAll(notConfigured
        ? new GatewayCallError('NOT_CONFIGURED', 'OpenBKN is not connected yet')
        : new GatewayCallError('GATEWAY_EXITED', `gateway exited (code ${code ?? 'signal'})`))
    })
    return child
  }

  private onLine(line: string): void {
    let msg: { id?: unknown; ok?: unknown; result?: unknown; error?: { code?: string; message?: string; httpStatus?: number; platformCode?: string } }
    try { msg = JSON.parse(line) as typeof msg } catch { return }
    if (typeof msg.id !== 'number') return
    if (msg.ok === true) this.settle(msg.id, msg.result)
    else {
      const e = msg.error ?? {}
      this.settle(msg.id, undefined, new GatewayCallError(e.code ?? 'INTERNAL', e.message ?? 'gateway error', e.httpStatus, e.platformCode))
    }
  }

  private settle(id: number, value: unknown, error?: GatewayCallError): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    clearTimeout(p.timer)
    if (error) p.reject(error)
    else p.resolve(value)
  }

  private failAll(error: GatewayCallError): void {
    for (const id of [...this.pending.keys()]) this.settle(id, undefined, error)
  }

  private kill(): void {
    const child = this.child
    this.child = undefined
    child?.kill()
  }
}
