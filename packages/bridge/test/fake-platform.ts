// In-memory stand-in for the gateway + OpenBKN, enforcing the platform rules the
// bridge depends on (R0a): one active Interaction per conversation, `completed`
// needs an answer, unknown conversations are not disclosed.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { GatewayCallError, type GatewayStatus, type ManagedContext, type McpToolResult } from '../src/gateway-client.js'
import type { GatewayPort } from '../src/session.js'

const snapshot = JSON.parse(readFileSync(fileURLToPath(new URL('../../../core/test/fixtures/mcp-tools-r0a.json', import.meta.url)), 'utf8')) as { tools: unknown[] }

export interface Call { readonly tool: string; readonly args: Record<string, unknown>; readonly managed: ManagedContext }

export class FakePlatform implements GatewayPort {
  readonly calls: Call[] = []
  readonly interactions = new Map<string, { conversationId: string; status: string; outcome?: string; answer?: string; reason?: string }>()
  networks = [
    { id: 'kn_supply', name: '供应链', comment: '供应链样例' },
    { id: 'kn_world', name: '世界杯', comment: '世界杯样例' },
  ]
  toolCatalog: unknown[] = structuredClone(snapshot.tools)
  configured = true
  failFinish = 0
  invalidConversations = new Set<string>()
  private seq = 0

  async status(): Promise<GatewayStatus> {
    return this.configured
      ? { version: 'test', configured: true, origin: 'https://openbkn.test', businessDomain: 'bd_public', credential: true }
      : { version: 'test', configured: false }
  }

  async catalogPage(offset: number, limit: number): Promise<unknown> {
    this.requireConfigured()
    return { entries: this.networks.slice(offset, offset + limit), total_count: this.networks.length }
  }

  async tools(): Promise<readonly unknown[]> { return this.toolCatalog }

  async callTool(tool: string, args: Readonly<Record<string, unknown>>, managed: ManagedContext): Promise<McpToolResult> {
    this.requireConfigured()
    this.calls.push({ tool, args: structuredClone(args) as Record<string, unknown>, managed })
    if (tool === 'bkn_start_interaction') {
      let conversationId = args.conversation_id as string | undefined
      if (args.conversation_mode === 'continue' && conversationId && this.invalidConversations.has(conversationId)) {
        return err('resource_not_disclosed')
      }
      conversationId ??= `conv_${++this.seq}`
      const open = [...this.interactions.entries()].find(([, v]) => v.conversationId === conversationId && v.status === 'active')
      if (open) return err('interaction_in_progress', { current_interaction_id: open[0] })
      const id = `int_${++this.seq}`
      this.interactions.set(id, { conversationId, status: 'active' })
      return ok({ interaction_id: id, conversation_id: conversationId, execution_status: 'running' })
    }
    if (tool === 'bkn_finish_interaction') {
      if (this.failFinish > 0) { this.failFinish--; return err('internal_error') }
      const it = this.interactions.get(args.interaction_id as string)
      if (!it) return err('resource_not_disclosed')
      if (it.status !== 'active') return err('terminal_conflict', { current_status: it.status })
      if (args.outcome === 'completed' && !args.answer) return err('closure_manifest_invalid')
      Object.assign(it, { status: String(args.outcome), outcome: args.outcome, answer: args.answer, reason: args.reason })
      return ok({ interaction_id: args.interaction_id, execution_status: args.outcome })
    }
    const ctx = args.bkn_context as { interaction_id?: string } | undefined
    const it = ctx?.interaction_id ? this.interactions.get(ctx.interaction_id) : undefined
    if (!it || it.status !== 'active') return err('interaction_not_active')
    return ok({ tool, rows: [{ name: '订单 1' }] })
  }

  async operations(interactionId: string): Promise<unknown> {
    return { entries: [{ operation_id: 'op_1', tool_name: 'query_object_instance', status: 'succeeded', interaction_id: interactionId }], total_count: 1 }
  }

  businessProvenance = true
  async capabilities(): Promise<{ businessProvenance: boolean; edition?: string }> {
    if (!this.configured) throw new GatewayCallError('NOT_CONFIGURED', 'OpenBKN is not connected yet')
    return { businessProvenance: this.businessProvenance, edition: this.businessProvenance ? 'enterprise' : 'community' }
  }

  async businessGraph(interactionId: string): Promise<unknown> {
    return { interaction_id: interactionId, execution_status: 'completed', evidence_status: 'complete', assembly: { business_refs: [{ technical_ref: { ref_id: 'r1', ref_type: 'object_type' }, display: { name: '销售订单' } }], operation_business_edges: [] }, events: [] }
  }

  /** The real gateway exits with "not configured" before serving anything. */
  private requireConfigured(): void {
    if (!this.configured) throw new GatewayCallError('NOT_CONFIGURED', 'OpenBKN is not connected yet')
  }

  started(): Call[] { return this.calls.filter(c => c.tool === 'bkn_start_interaction') }
  finished(): Call[] { return this.calls.filter(c => c.tool === 'bkn_finish_interaction') }
}

function ok(value: unknown): McpToolResult { return { content: [{ type: 'text', text: JSON.stringify(value) }] } }
function err(code: string, extra: Record<string, unknown> = {}): McpToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code, ...extra } }) }] }
}
