import { Logger, traceFetch, type Registry, type TelemetryEnv } from '#capabilities'
import { ActionError, describeActions, type Ctx, type Member } from './actions'
import { mcp, rpcError } from './mcp'
import { Actions, Converter, RoomModule } from './module'

// Only /api/* and /mcp reach this Worker. The page is static assets.
//
//   POST /api/session          a person's token in, an HttpOnly cookie out
//   GET  /api/me               who the cookie or token belongs to
//   GET  /api/actions          every action, with the JSON Schema of its input
//   POST /api/actions/<name>   run one (cookie for people, Bearer token for anyone)
//   POST /api/upload           a file in, a Markdown draft out (writers)
//   POST /mcp                  the same actions as MCP tools, documents as resources (Bearer token)

export interface Env extends TelemetryEnv {
  DB: D1Database
  AI?: Ai
  ROOM_NAME?: string
  ASKS_PER_DAY?: string
  AI_GATEWAY_ID?: string
}

const COOKIE = 'room_session'
const SESSION_DAYS = 30
/** toMarkdown takes bigger files, but a set of notes or an update that's bigger than this is mostly pictures. */
const MAX_UPLOAD = 10 * 1024 * 1024
/** Read as they are. Anything else goes through Workers AI's toMarkdown. */
const TEXT = /\.(md|markdown|txt)$/i

export async function sha256Hex(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('')
}

async function memberFor(db: D1Database, token: string): Promise<Member | null> {
  if (!token || token.length > 200) return null
  return db.prepare('SELECT id, name, kind, side FROM members WHERE token_hash = ?').bind(await sha256Hex(token)).first<Member>()
}

const cookieToken = (request: Request) =>
  (request.headers.get('cookie') ?? '').split(/;\s*/).find(c => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? ''

const bearer = (request: Request) => /^Bearer (\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? ''

/**
 * Agents send a Bearer token. People use the cookie, and only people get one.
 * A cookie rides along on cross-site requests, so those must come from our own origin,
 * and be JSON (or the upload form, which also needs the origin to match).
 */
async function who(request: Request, url: URL, db: D1Database): Promise<Member | null> {
  const token = bearer(request)
  if (token) return memberFor(db, token)
  const fromCookie = cookieToken(request)
  if (!fromCookie) return null
  if (request.method !== 'GET') {
    const origin = request.headers.get('origin')
    const type = request.headers.get('content-type') ?? ''
    if (url.pathname === '/api/upload') { if (origin !== url.origin) return null }
    else if ((origin && origin !== url.origin) || !type.startsWith('application/json')) return null
  }
  const m = await memberFor(db, fromCookie)
  return m?.kind === 'person' ? m : null
}

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } })

const cookie = (url: URL, value: string, maxAge: number) =>
  `${COOKIE}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${url.protocol === 'https:' ? '; Secure' : ''}`

async function readJson(request: Request): Promise<unknown> {
  try { return await request.json() } catch { throw new ActionError(400, 'Nothing changed: the body was not JSON.') }
}

const ctxFor = (env: Env, member: Member, via: Ctx['via'], origin: string): Ctx => ({
  db: env.DB, ai: env.AI, member, via, now: new Date(), origin,
  room: env.ROOM_NAME || 'The room',
  asksPerDay: Number(env.ASKS_PER_DAY) || 50,
  gateway: env.AI_GATEWAY_ID || undefined,
})

/** A file becomes Markdown here, then goes in as a draft like anything else. Nothing but the Markdown is kept. */
async function upload(request: Request, ctx: Ctx, c: Registry): Promise<Response> {
  let form: FormData
  try { form = await request.formData() } catch { throw new ActionError(400, 'Nothing added: send the file as multipart/form-data.') }
  // workers-types says get() is string | null, but a file field is a File.
  const file = form.get('file') as unknown
  if (!(file instanceof File) || !file.size) throw new ActionError(400, 'Nothing added: there was no file.')
  if (file.size > MAX_UPLOAD) throw new ActionError(400, `Nothing added: ${file.name} is over 10 MB.`)
  let markdown: string
  if (TEXT.test(file.name)) markdown = await file.text()
  else {
    if (!c.has(Converter)) throw new ActionError(502, `Nothing added: this room can't convert ${file.name} without Workers AI. Upload Markdown or plain text instead.`)
    markdown = await c.get(Converter).toMarkdown(file)
  }
  const field = (k: string) => { const v = form.get(k); return typeof v === 'string' && v.trim() ? v.trim() : undefined }
  const result = await c.get(Actions).perform('add_version', {
    document: field('document'),
    title: field('title') ?? (field('document') ? undefined : file.name.replace(/\.[^.]+$/, '')),
    note: field('note'),
    source: file.name.slice(0, 200),
    markdown,
  }, ctx)
  return json({ ok: true, ...result })
}

async function api(request: Request, url: URL, env: Env, c: Registry): Promise<Response> {
  if (url.pathname === '/api/session' && request.method === 'POST') {
    const { token } = (await readJson(request) ?? {}) as { token?: unknown }
    const m = typeof token === 'string' ? await memberFor(env.DB, token.trim()) : null
    if (!m) return json({ ok: false, error: "That link or token didn't work. Ask whoever shared the room for a new one." }, 401)
    if (m.kind !== 'person') return json({ ok: false, error: "That's an agent's token. Agents use MCP or the API, not this page." }, 403)
    return json({ ok: true, you: m }, 200, { 'set-cookie': cookie(url, (token as string).trim(), SESSION_DAYS * 86400) })
  }
  if (url.pathname === '/api/session' && request.method === 'DELETE') {
    return json({ ok: true }, 200, { 'set-cookie': cookie(url, '', 0) })
  }

  const member = await who(request, url, env.DB)
  if (!member) return json({ ok: false, error: 'Sign in first: open the link you were sent, or send a token as "Authorization: Bearer <token>".' }, 401)
  const ctx = ctxFor(env, member, bearer(request) ? 'api' : 'page', url.origin)

  if (url.pathname === '/api/me' && request.method === 'GET') return json({ ok: true, you: member, room: ctx.room })
  if (url.pathname === '/api/actions' && request.method === 'GET') return json({ ok: true, actions: describeActions() })
  if (url.pathname === '/api/upload' && request.method === 'POST') return upload(request, ctx, c)
  const name = /^\/api\/actions\/([a-z_]+)$/.exec(url.pathname)?.[1]
  if (name && request.method === 'POST') return json({ ok: true, ...await c.get(Actions).perform(name, await readJson(request), ctx) })
  return json({ ok: false, error: `There's nothing at ${request.method} ${url.pathname}.` }, 404)
}

/** Span names and logs get the route, never ids or anything a caller typed. */
function routeOf(pathname: string): string {
  if (['/mcp', '/api/session', '/api/me', '/api/actions', '/api/upload'].includes(pathname)) return pathname
  if (/^\/api\/actions\/[a-z_]+$/.test(pathname)) return '/api/actions/:name'
  return 'unmatched'
}

// env is the same object for the life of an isolate, so so is the registry.
const registries = new WeakMap<object, Registry>()
const registryFor = (env: Env) => {
  let c = registries.get(env)
  if (!c) { c = new RoomModule(env).build(); registries.set(env, c) }
  return c
}

/** One request, traced, against a built registry. Tests hand it one with MemoryTelemetry. */
export function handle(c: Registry, request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const url = new URL(request.url)
  return traceFetch(c, request, ctx, routeOf(url.pathname), async span => {
    try {
      if (url.pathname === '/mcp') {
        if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
        const token = bearer(request)
        const member = token ? await memberFor(env.DB, token) : null
        if (!member) return rpcError(null, -32001, 'Send a token as "Authorization: Bearer <token>".', 401)
        return await mcp(request, ctxFor(env, member, 'mcp', url.origin), c.get(Actions))
      }
      if (url.pathname.startsWith('/api/')) return await api(request, url, env, c)
      return new Response('Not found', { status: 404 })
    } catch (err) {
      if (err instanceof ActionError) return json({ ok: false, error: err.message }, err.status)
      span.recordError(err)
      c.get(Logger).error('request.failed', { error: err })
      return json({ ok: false, error: 'Something went wrong on our side, and nothing was saved. Try again in a minute.' }, 500)
    }
  })
}

export default {
  fetch: (request: Request, env: Env, ctx?: ExecutionContext) => handle(registryFor(env), request, env, ctx),
} satisfies ExportedHandler<Env>
