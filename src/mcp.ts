import { ACTIONS, ActionError, inputSchema, type Ctx } from './actions'
import type { Actions } from './module'

// MCP over plain HTTP POST, JSON in and JSON out, with no session to keep.
// The tools are the actions, so an agent gets the same list the page uses.
// Each document's current version is also a resource, as text/markdown.

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26']

const instructions = (ctx: Ctx) => `${ctx.room}: a room of dated, versioned Markdown documents. You are ${ctx.member.name}, a ${ctx.member.side}.
Start with list_documents. Everything here is Markdown, so read_document gives you the source, not a summary.
Every version is dated. When you report something, say which document and version it came from; numbers change between versions, and compare_versions shows what changed.
If the documents don't answer something, say so and use ask_writers rather than guessing.${ctx.member.side === 'writer'
  ? '\nadd_version saves a draft. Only a person publishes, so tell them a draft is waiting.'
  : ''}`

interface RpcRequest { jsonrpc?: string; id?: number | string | null; method?: string; params?: Record<string, unknown> }

/** Readers don't see the writer-only tools at all. */
export const tools = (ctx: Ctx) => ACTIONS.filter(a => (!a.who || a.who === 'anyone' || ctx.member.side === 'writer') && (!ctx.member.actions || ctx.member.actions.includes(a.name))).map(a => ({
  name: a.name,
  description: a.description,
  inputSchema: inputSchema(a),
  annotations: { readOnlyHint: !a.changes, destructiveHint: false, idempotentHint: !a.changes, openWorldHint: false },
}))

const RESOURCE = /^room:\/\/documents\/([a-z0-9-]+)$/

async function resources(ctx: Ctx, actions: Actions) {
  const { documents } = await actions.perform('list_documents', {}, ctx) as unknown as { documents: { slug: string; title: string; version: number; published_at: string; note: string }[] }
  return documents.map(d => ({
    uri: `room://documents/${d.slug}`,
    name: d.slug,
    title: d.title,
    description: `Version ${d.version}, published ${d.published_at.slice(0, 10)}${d.note ? `. ${d.note}` : ''}`,
    mimeType: 'text/markdown',
  }))
}

export async function mcp(request: Request, ctx: Ctx, actions: Actions): Promise<Response> {
  let msg: RpcRequest
  try { msg = await request.json() } catch { return rpcError(null, -32700, 'That body is not JSON.') }
  if (Array.isArray(msg) || typeof msg !== 'object' || msg === null) return rpcError(null, -32600, 'Send one JSON-RPC request per POST.')
  const { id = null, method = '', params = {} } = msg
  const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id, result })

  // Notifications (no id) get no answer.
  if (method.startsWith('notifications/')) return new Response(null, { status: 202 })
  if (method === 'initialize') {
    const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
    return reply({
      protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: 'handover-notes', version: '0.1.0' },
      instructions: instructions(ctx),
    })
  }
  if (method === 'ping') return reply({})
  if (method === 'tools/list') return reply({ tools: tools(ctx) })
  if (method === 'resources/list') return reply({ resources: await resources(ctx, actions) })
  if (method === 'resources/templates/list') return reply({ resourceTemplates: [] })
  if (method === 'resources/read') {
    const slug = RESOURCE.exec(String(params.uri ?? ''))?.[1]
    if (!slug) return rpcError(id, -32602, 'Give a uri like room://documents/<slug>. resources/list has them.')
    try {
      const doc = await actions.perform('read_document', { document: slug }, ctx) as unknown as { markdown: string }
      return reply({ contents: [{ uri: params.uri, mimeType: 'text/markdown', text: doc.markdown }] })
    } catch (err) {
      if (err instanceof ActionError) return rpcError(id, -32002, err.message)
      throw err
    }
  }
  if (method === 'tools/call') {
    try {
      const result = await actions.perform(String(params.name ?? ''), params.arguments ?? {}, ctx)
      return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result })
    } catch (err) {
      // A refused or failed action is a tool result the agent can read and act on, not a protocol error.
      if (err instanceof ActionError) return reply({ content: [{ type: 'text', text: err.message }], isError: true })
      throw err
    }
  }
  return rpcError(id, -32601, `There's no method called "${method}".`)
}

export const rpcError = (id: number | string | null, code: number, message: string, status = 200) =>
  Response.json({ jsonrpc: '2.0', id, error: { code, message } }, { status })
