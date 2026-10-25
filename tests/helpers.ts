import { env } from 'cloudflare:workers'
import { vi } from 'vitest'
import { perform, type Ctx, type Member } from '../src/actions'
import worker, { sha256Hex } from '../src/worker'
import schema from '../schema.sql?raw'
import howItWorks from './fixtures/how-it-works.md?raw'
import buildNotesV1 from './fixtures/build-notes-v1.md?raw'
import buildNotesV2 from './fixtures/build-notes-v2.md?raw'
import byHand from './fixtures/by-hand.md?raw'
import accounts from './fixtures/accounts.md?raw'
import costs from './fixtures/costs.md?raw'

export const ORIGIN = 'https://room.example'

export const MEMBERS: Record<string, Member & { token: string }> = {
  sam: { id: 'sam', name: 'Sam', kind: 'person', side: 'writer', token: 'sam-token' },
  draftbot: { id: 'draftbot', name: 'Draft bot', kind: 'agent', side: 'writer', token: 'draftbot-token' },
  kira: { id: 'kira', name: 'Kira', kind: 'person', side: 'reader', token: 'kira-token' },
  assistant: { id: 'assistant', name: "Kira's assistant", kind: 'agent', side: 'reader', token: 'assistant-token' },
}

/** A fresh database with us writing (a person and an agent) and the client reading (a person and their AI), like `npm run invite` makes. */
export async function reset() {
  const statements = schema.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').split(';').map(s => s.trim()).filter(Boolean)
  // Dropped, not emptied: AUTOINCREMENT would carry on numbering from the last test.
  await env.DB.batch(['settings', 'questions', 'sections', 'versions', 'documents', 'token_limits', 'members'].map(t => env.DB.prepare(`DROP TABLE IF EXISTS ${t}`)))
  await env.DB.batch(statements.map(s => env.DB.prepare(s)))
  for (const m of Object.values(MEMBERS)) {
    await env.DB.prepare("INSERT INTO members (id, name, kind, side, token_hash, created_at) VALUES (?, ?, ?, ?, ?, '2026-08-01T00:00:00Z')")
      .bind(m.id, m.name, m.kind, m.side, await sha256Hex(m.token)).run()
  }
  ai.run.mockReset()
  ai.toMarkdown.mockReset()
}

/** Stands in for Workers AI. Tests set what the model says with ai.run.mockImplementationOnce. */
export const ai = {
  run: vi.fn<(model: string, inputs: unknown, options?: unknown) => Promise<unknown>>(),
  toMarkdown: vi.fn<(file: { name: string; blob: Blob }) => Promise<unknown>>(),
}

export const ctx = (who: keyof typeof MEMBERS, now = '2026-10-19T00:00:00Z', via: Ctx['via'] = 'api'): Ctx => {
  const { token: _, ...member } = MEMBERS[who]
  return { db: env.DB, ai: ai as unknown as Ai, member, now: new Date(now), via, room: 'Saltwater Photography handover', asksPerDay: 50 }
}

/** Adds a document and publishes it, as Sam, on a given day. */
export async function publish(markdown: string, opts: { title?: string; document?: string; note?: string; at: string }) {
  const added = await perform('add_version', { markdown, title: opts.title, document: opts.document, note: opts.note }, ctx('sam', opts.at))
  return perform('publish_draft', { draft: added.draft }, ctx('sam', opts.at))
}

/** Made-up handover notes for Saltwater Photography: five documents, and the build notes updated once. */
export async function seed() {
  await publish(howItWorks, { title: 'How it works', at: '2026-09-01T09:00:00Z' })
  await publish(buildNotesV1, { title: 'Build notes', at: '2026-09-01T09:05:00Z' })
  await publish(byHand, { title: 'By hand', at: '2026-09-01T09:10:00Z' })
  await publish(accounts, { title: 'Accounts', at: '2026-09-01T09:15:00Z' })
  await publish(costs, { title: 'Costs', at: '2026-10-02T09:00:00Z' })
  await publish(buildNotesV2, { document: 'build-notes', note: 'Test week started, and wedding quotes are in', at: '2026-10-02T09:05:00Z' })
}

export const fetchWorker = (path: string, init: RequestInit = {}, extra: Record<string, unknown> = {}) =>
  worker.fetch(new Request(`${ORIGIN}${path}`, init), { DB: env.DB, AI: ai as unknown as Ai, ROOM_NAME: 'Saltwater Photography handover', ...extra })

type Body = Record<string, any>

/** Calls an action over the HTTP API with a Bearer token. */
export async function call(token: string, name: string, args: unknown = {}): Promise<{ status: number; body: Body }> {
  const res = await fetchWorker(`/api/actions/${name}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(args),
  })
  return { status: res.status, body: await res.json() as Body }
}

let rpcId = 0
/** One JSON-RPC request to /mcp, as an MCP client sends it. */
export async function rpc(token: string | null, method: string, params: unknown = {}): Promise<{ status: number; body: Body }> {
  const res = await fetchWorker('/mcp', {
    method: 'POST',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) as Body : {} }
}

/** What Workers AI returns for a chat model with a JSON schema. */
export const modelSays = (reply: { answer: string; cites: number[]; missing: string }) =>
  ai.run.mockImplementationOnce(async () => ({ response: reply }))

/** A model that cites sections by their heading, looked up in the prompt it was sent, the way a real one reads the numbers. */
export const modelCites = (headings: string[], answer: string, missing = '') =>
  ai.run.mockImplementationOnce(async (_model, inputs) => {
    const prompt = (inputs as { messages: { content: string }[] }).messages[1].content
    const cites = headings.map(h => Number(new RegExp(`^\\[(\\d+)\\] [^\\n]*section "${h}":`, 'm').exec(prompt)?.[1] ?? 0))
    return { response: { answer, cites, missing } }
  })

/** The section headings in the last prompt the model was sent. */
export const lastPrompt = () => {
  const calls = ai.run.mock.calls
  return (calls.at(-1)![1] as { messages: { content: string }[] }).messages[1].content
}
