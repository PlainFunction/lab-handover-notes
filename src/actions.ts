import { z } from 'zod'
import { answer, gather, ModelError, search, type Cite } from './answer'
import { diffLines, MAX_MARKDOWN, normalise, sections } from './markdown'

// The whole room is this list of actions. The page, the HTTP API and MCP all
// call perform(), so a person and an agent, on either side, get the same
// things, except where an action says otherwise.

export interface Member { id: string; name: string; kind: 'person' | 'agent'; side: 'writer' | 'reader' }
export interface Ctx {
  db: D1Database
  ai?: Ai
  member: Member
  now: Date
  via: 'page' | 'api' | 'mcp'
  room: string
  asksPerDay: number
  gateway?: string
  /** Where the room is served, for the links share hands out. */
  origin?: string
}
/** Every result starts with one plain line saying what happened. */
export type Result = { message: string } & Record<string, unknown>

export class ActionError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 429 | 502
  constructor(status: ActionError['status'], message: string) { super(message); this.status = status }
}

interface Action<S extends z.ZodObject = z.ZodObject> {
  name: string
  description: string
  changes: boolean
  /** Who may run it. Writers add and publish; only people publish or reply. Default: anyone in the room. */
  who?: 'anyone' | 'writers' | 'writer-people'
  input: S
  run: (args: z.infer<S>, ctx: Ctx) => Promise<Result>
}

const action = <S extends z.ZodObject>(a: Action<S>) => a as unknown as Action

const slug = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,59}$/, 'a document slug like "traction", from list_documents')
const date = z.iso.date().describe('YYYY-MM-DD. Uses what was published by the end of that day (UTC).')
const question = z.string().trim().min(3).max(1_000)

interface DocRow { id: number; slug: string; title: string; current_version: number | null }
interface VersionRow {
  id: number; document_id: number; number: number | null; state: string; markdown: string; note: string; source: string
  added_by: string; added_by_name: string; added_at: string; published_at: string | null; published_by_name: string | null
}

const VERSION = `SELECT v.*, a.name AS added_by_name, p.name AS published_by_name FROM versions v
  JOIN members a ON a.id = v.added_by LEFT JOIN members p ON p.id = v.published_by`

async function doc(db: D1Database, s: string, member: Member): Promise<DocRow> {
  const d = await db.prepare('SELECT id, slug, title, current_version FROM documents WHERE slug = ?').bind(s).first<DocRow>()
  // A document with nothing published yet doesn't exist, as far as readers know.
  if (!d || (!d.current_version && member.side !== 'writer')) throw new ActionError(404, `There's no document called "${s}". list_documents has them all.`)
  return d
}

async function published(db: D1Database, d: DocRow, opts: { version?: number; asOf?: string }): Promise<VersionRow> {
  const v = opts.version
    ? await db.prepare(`${VERSION} WHERE v.document_id = ? AND v.state = 'published' AND v.number = ?`).bind(d.id, opts.version).first<VersionRow>()
    : opts.asOf
      ? await db.prepare(`${VERSION} WHERE v.document_id = ? AND v.state = 'published' AND v.published_at <= ? ORDER BY v.number DESC LIMIT 1`).bind(d.id, `${opts.asOf}T23:59:59.999Z`).first<VersionRow>()
      : d.current_version ? await db.prepare(`${VERSION} WHERE v.id = ?`).bind(d.current_version).first<VersionRow>() : null
  if (!v) {
    if (opts.version) throw new ActionError(404, `"${d.slug}" has no version ${opts.version}. list_versions has them.`)
    if (opts.asOf) throw new ActionError(404, `"${d.slug}" hadn't been published by ${opts.asOf}.`)
    throw new ActionError(404, `"${d.slug}" has nothing published yet.`)
  }
  return v
}

async function draft(db: D1Database, id: number): Promise<VersionRow & { slug: string; title: string }> {
  const v = await db.prepare(`${VERSION.replace('SELECT v.*', 'SELECT v.*, d.slug, d.title')} JOIN documents d ON d.id = v.document_id WHERE v.id = ? AND v.state = 'draft'`)
    .bind(id).first<VersionRow & { slug: string; title: string }>()
  if (!v) throw new ActionError(404, `There's no draft ${id}. list_documents shows the drafts waiting.`)
  return v
}

const sha256Hex = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('')

const day = (iso: string | null) => iso?.slice(0, 10) ?? null

const slugFrom = (title: string) =>
  title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'document'

/** A question goes on the list writers see when the documents didn't fully answer it. */
async function record(ctx: Ctx, q: string, a: { state: string; answer?: string; missing?: string; cites?: Cite[]; dropped?: string }) {
  const row = await ctx.db.prepare(
    'INSERT INTO questions (asked_by, question, via, state, answer, missing, cites, dropped, asked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
  ).bind(ctx.member.id, q, ctx.via, a.state, a.answer ?? '', a.missing ?? '', JSON.stringify(a.cites ?? []), a.dropped ?? null, ctx.now.toISOString()).first<{ id: number }>()
  return row!.id
}

/** A cap on questions per member per day, so a loop in someone's agent can't run up the bill. */
async function underCap(ctx: Ctx) {
  const since = new Date(ctx.now.getTime() - 86_400_000).toISOString()
  const row = await ctx.db.prepare('SELECT COUNT(*) AS n FROM questions WHERE asked_by = ? AND asked_at > ?').bind(ctx.member.id, since).first<{ n: number }>()
  if ((row?.n ?? 0) >= ctx.asksPerDay) {
    throw new ActionError(429, `Not asked: you've asked ${ctx.asksPerDay} questions in the last 24 hours, which is this room's daily limit. Reading and searching still work.`)
  }
}

const writers = async (db: D1Database) =>
  (await db.prepare("SELECT name FROM members WHERE side = 'writer' AND kind = 'person' ORDER BY created_at").all<{ name: string }>()).results.map(r => r.name)

export const ACTIONS: Action[] = [
  action({
    name: 'list_documents',
    description: 'Every document in the room, each with its current version, when it was published and what changed. Start here. Writers also see drafts waiting to be published.',
    changes: false,
    input: z.strictObject({}),
    async run(_, ctx) {
      const { results } = await ctx.db.prepare(
        `SELECT d.slug, d.title, v.number AS version, v.published_at, v.note, a.name AS added_by, a.side AS added_by_side,
                (SELECT COUNT(*) FROM versions x WHERE x.document_id = d.id AND x.state = 'published') AS versions
           FROM documents d JOIN versions v ON v.id = d.current_version JOIN members a ON a.id = v.added_by
          ORDER BY v.published_at DESC`,
      ).all()
      const out: Result = {
        message: `${results.length} document${results.length === 1 ? '' : 's'} in ${ctx.room}`,
        room: ctx.room,
        you: ctx.member,
        documents: results,
      }
      if (ctx.member.side === 'writer') {
        out.drafts = (await ctx.db.prepare(
          `SELECT v.id AS draft, d.slug, d.title, v.note, v.source, a.name AS added_by, a.kind AS added_by_kind, v.added_at, length(v.markdown) AS characters
             FROM versions v JOIN documents d ON d.id = v.document_id JOIN members a ON a.id = v.added_by
            WHERE v.state = 'draft' ORDER BY v.id`,
        ).all()).results
      }
      return out
    },
  }),

  action({
    name: 'read_document',
    description: 'The Markdown of one document: the current version, a numbered version, or the version that was current on a date.',
    changes: false,
    input: z.strictObject({
      document: slug,
      version: z.number().int().positive().optional().describe('A version number from list_versions'),
      as_of: date.optional(),
    }),
    async run({ document, version, as_of }, ctx) {
      const d = await doc(ctx.db, document, ctx.member)
      const v = await published(ctx.db, d, { version, asOf: as_of })
      const latest = v.id === d.current_version
      return {
        message: `${d.title}, version ${v.number}, published ${day(v.published_at)}${latest ? '' : ' (not the current version)'}`,
        document: d.slug, title: d.title, version: v.number, current: latest,
        published_at: v.published_at, added_by: v.added_by_name, note: v.note,
        markdown: v.markdown,
      }
    },
  }),

  action({
    name: 'list_versions',
    description: 'Every published version of a document, oldest first, with its date, who added it and what changed.',
    changes: false,
    input: z.strictObject({ document: slug }),
    async run({ document }, ctx) {
      const d = await doc(ctx.db, document, ctx.member)
      const { results } = await ctx.db.prepare(
        `SELECT v.number AS version, v.published_at, v.note, v.source, a.name AS added_by, p.name AS published_by
           FROM versions v JOIN members a ON a.id = v.added_by LEFT JOIN members p ON p.id = v.published_by
          WHERE v.document_id = ? AND v.state = 'published' ORDER BY v.number`,
      ).bind(d.id).all()
      return { message: `${d.title}: ${results.length} version${results.length === 1 ? '' : 's'}`, document: d.slug, title: d.title, versions: results }
    },
  }),

  action({
    name: 'compare_versions',
    description: 'What changed in a document between two versions, as lines added (+) and removed (-). "to" defaults to the current version.',
    changes: false,
    input: z.strictObject({
      document: slug,
      from: z.number().int().positive().describe('The older version number'),
      to: z.number().int().positive().optional().describe('The newer version number. Default: the current one'),
    }),
    async run({ document, from, to }, ctx) {
      const d = await doc(ctx.db, document, ctx.member)
      const [a, b] = await Promise.all([published(ctx.db, d, { version: from }), published(ctx.db, d, { version: to })])
      if (a.number === b.number) throw new ActionError(400, `Those are the same version (${a.number}). Give two different ones.`)
      const lines = diffLines(a.markdown, b.markdown)
      if (!lines) throw new ActionError(400, `${d.title} is too long to compare line by line. Read both versions instead.`)
      const added = lines.filter(l => l.op === '+').length
      const removed = lines.filter(l => l.op === '-').length
      return {
        message: lines.length
          ? `${d.title}, version ${a.number} (${day(a.published_at)}) to ${b.number} (${day(b.published_at)}): ${added} line${added === 1 ? '' : 's'} added, ${removed} removed`
          : `${d.title}: versions ${a.number} and ${b.number} say the same thing`,
        document: d.slug, from: { version: a.number, published_at: a.published_at, note: a.note }, to: { version: b.number, published_at: b.published_at, note: b.note },
        diff: lines.map(l => `${l.op} ${l.text}`).join('\n'),
      }
    },
  }),

  action({
    name: 'search',
    description: 'Find sections of the documents by words, best match first. Searches the current versions, or what was current on a date. No AI: this is a word search.',
    changes: false,
    input: z.strictObject({
      query: z.string().trim().min(2).max(300),
      as_of: date.optional(),
      limit: z.number().int().min(1).max(20).default(8),
    }),
    async run({ query, as_of, limit }, ctx) {
      const hits = await search(ctx.db, query, { asOf: as_of, limit })
      return {
        message: hits.length ? `${hits.length} section${hits.length === 1 ? '' : 's'} matched` : 'Nothing in the documents matched those words.',
        results: hits.map(({ body: _, ...h }) => h),
      }
    },
  }),

  action({
    name: 'ask',
    description: "Ask a question. It's answered only from the documents, with the sections it came from, or the reply says which part the documents don't cover and passes it to the writers. Agents that can read for themselves may prefer search and read_document.",
    changes: true,
    input: z.strictObject({ question, as_of: date.optional() }),
    async run({ question: q, as_of }, ctx) {
      await underCap(ctx)
      if (!ctx.ai) throw new ActionError(502, 'Not answered: this room has no AI connected yet. The documents can still be read and searched.')
      const { hits } = await gather(ctx.db, q, { asOf: as_of })
      let a
      try {
        a = await answer(ctx.ai, q, hits, ctx.gateway)
      } catch (err) {
        if (!(err instanceof ModelError)) throw err
        // Fail once, clearly, and don't lose the question.
        console.error('ask: model failed', err.message)
        const id = await record(ctx, q, { state: 'for_writers', missing: q })
        return {
          message: `The AI that reads the documents didn't answer, so your question went straight to ${(await writers(ctx.db)).join(' and ') || 'the writers'}.`,
          question: id, state: 'for_writers', answer: '', missing: q, cites: [],
        }
      }
      const id = await record(ctx, q, a)
      const people = (await writers(ctx.db)).join(' and ') || 'the writers'
      const message = {
        answered: 'Answered from the documents.',
        partly: `Partly answered. The documents don't cover: ${a.missing}. We've passed that part to ${people}.`,
        not_in_documents: `The documents don't answer that yet. We've passed your question to ${people}.`,
        uncited: `The documents don't answer that yet. We've passed your question to ${people}.`,
      }[a.state]
      return { message, question: id, state: a.state === 'uncited' ? 'not_in_documents' : a.state, answer: a.answer, missing: a.missing, cites: a.cites }
    },
  }),

  action({
    name: 'ask_writers',
    description: 'Put a question straight to the people who wrote the documents, without the AI. They reply in list_questions.',
    changes: true,
    input: z.strictObject({ question }),
    async run({ question: q }, ctx) {
      await underCap(ctx)
      const id = await record(ctx, q, { state: 'for_writers', missing: q })
      return { message: `Sent to ${(await writers(ctx.db)).join(' and ') || 'the writers'}. Their reply will show in list_questions.`, question: id }
    },
  }),

  action({
    name: 'list_questions',
    description: "Questions asked in the room and their answers. Readers see their own; writers see everyone's. 'open' is what the documents didn't fully answer and nobody has replied to yet.",
    changes: false,
    input: z.strictObject({ show: z.enum(['open', 'all']).default('all') }),
    async run({ show }, ctx) {
      const where: string[] = []
      const binds: unknown[] = []
      if (ctx.member.side !== 'writer') { where.push('q.asked_by = ?'); binds.push(ctx.member.id) }
      if (show === 'open') where.push("q.state != 'answered' AND q.reply IS NULL")
      const { results } = await ctx.db.prepare(
        `SELECT q.id, q.question, q.state, q.answer, q.missing, q.cites, q.via, q.asked_at, a.name AS asked_by, a.kind AS asked_by_kind,
                q.reply, r.name AS replied_by, q.replied_at
           FROM questions q JOIN members a ON a.id = q.asked_by LEFT JOIN members r ON r.id = q.replied_by
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY q.id DESC LIMIT 200`,
      ).bind(...binds).all<Record<string, unknown> & { cites: string; state: string }>()
      const questions = results.map(r => ({ ...r, state: r.state === 'uncited' ? 'not_in_documents' : r.state, cites: JSON.parse(r.cites) }))
      return { message: `${questions.length} question${questions.length === 1 ? '' : 's'}`, questions }
    },
  }),

  action({
    name: 'add_version',
    description: 'Add Markdown as a new document, or as a new version of one. It becomes a draft: nobody else sees it until a person on the writing side reads it and publishes it.',
    changes: true,
    who: 'writers',
    input: z.strictObject({
      document: slug.optional().describe('An existing document\'s slug, for a new version of it. Leave out to start a new document'),
      title: z.string().trim().min(1).max(120).optional().describe('Needed for a new document'),
      markdown: z.string().max(MAX_MARKDOWN),
      note: z.string().trim().max(300).default('').describe('What changed, in a line. Readers see it next to the version. Needed for a new version of a document'),
      source: z.string().trim().max(200).default('').describe('Where it came from, e.g. the file name it was converted from'),
    }),
    async run({ document, title, markdown, note, source }, ctx) {
      const md = normalise(markdown)
      if (md.trim().length < 10) throw new ActionError(400, 'Nothing added: the Markdown is empty.')
      const now = ctx.now.toISOString()
      let d: DocRow | null = document ? await doc(ctx.db, document, ctx.member) : null
      if (d && d.current_version && !note) throw new ActionError(400, `Nothing added: say what changed in "note", so readers know why there's a new version of ${d.title}.`)
      if (d?.current_version) {
        const current = await ctx.db.prepare('SELECT sha256 FROM versions WHERE id = ?').bind(d.current_version).first<{ sha256: string }>()
        if (current?.sha256 === await sha256Hex(md)) throw new ActionError(409, `Nothing added: that's word for word the current version of ${d.title}.`)
      }
      if (!d) {
        if (!title) throw new ActionError(400, 'Nothing added: a new document needs a title (or give "document" to add a version of one).')
        let s = slugFrom(title)
        if (await ctx.db.prepare('SELECT 1 FROM documents WHERE slug = ?').bind(s).first()) s = `${s.slice(0, 52)}-${Date.now().toString(36).slice(-6)}`
        await ctx.db.prepare('INSERT INTO documents (slug, title, created_by, created_at) VALUES (?, ?, ?, ?)').bind(s, title, ctx.member.id, now).run()
        d = (await ctx.db.prepare('SELECT id, slug, title, current_version FROM documents WHERE slug = ?').bind(s).first<DocRow>())!
      }
      const row = await ctx.db.prepare(
        'INSERT INTO versions (document_id, markdown, note, source, sha256, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
      ).bind(d.id, md, note, source, await sha256Hex(md), ctx.member.id, now).first<{ id: number }>()
      const parts = sections(md)
      return {
        message: `Saved a draft of ${d.title} (draft ${row!.id}). Nobody else sees it until a person publishes it.`,
        draft: row!.id, document: d.slug, sections: parts.map(p => p.heading || 'Top'),
      }
    },
  }),

  action({
    name: 'get_draft',
    description: 'A draft, with its Markdown, so a writer can read it before publishing.',
    changes: false,
    who: 'writers',
    input: z.strictObject({ draft: z.number().int().positive() }),
    async run({ draft: id }, ctx) {
      const v = await draft(ctx.db, id)
      const d = await doc(ctx.db, v.slug, ctx.member)
      const current = d.current_version ? await published(ctx.db, d, {}) : null
      const lines = current ? diffLines(current.markdown, v.markdown) : null
      return {
        message: `Draft ${id} of ${v.title}, added by ${v.added_by_name}`,
        draft: id, document: v.slug, title: v.title, note: v.note, source: v.source, added_by: v.added_by_name, added_at: v.added_at,
        markdown: v.markdown,
        replaces: current ? { version: current.number, published_at: current.published_at } : null,
        diff: lines ? lines.map(l => `${l.op} ${l.text}`).join('\n') : null,
      }
    },
  }),

  action({
    name: 'publish_draft',
    description: 'Publish a draft as the next version, dated now. From then on everyone in the room can read it and ask about it. People only.',
    changes: true,
    who: 'writer-people',
    input: z.strictObject({ draft: z.number().int().positive() }),
    async run({ draft: id }, ctx) {
      const v = await draft(ctx.db, id)
      const last = await ctx.db.prepare("SELECT MAX(number) AS n FROM versions WHERE document_id = ? AND state = 'published'").bind(v.document_id).first<{ n: number | null }>()
      const number = (last?.n ?? 0) + 1
      const now = ctx.now.toISOString()
      const parts = sections(v.markdown)
      // One batch is one transaction: the version, the document's pointer and the search index change together.
      // The later statements only run if the first one published this draft just now, so a double click can't index it twice.
      const mine = 'SELECT 1 FROM versions WHERE id = ? AND published_at = ? AND published_by = ?'
      const results = await ctx.db.batch([
        ctx.db.prepare("UPDATE versions SET state = 'published', number = ?, published_by = ?, published_at = ? WHERE id = ? AND state = 'draft'")
          .bind(number, ctx.member.id, now, id),
        ctx.db.prepare(`UPDATE documents SET current_version = ? WHERE id = ? AND EXISTS (${mine})`).bind(id, v.document_id, id, now, ctx.member.id),
        ...parts.map(p => ctx.db.prepare(`INSERT INTO sections (heading, body, anchor, version_id) SELECT ?, ?, ?, ? WHERE EXISTS (${mine})`)
          .bind(p.heading, p.body, p.anchor, id, id, now, ctx.member.id)),
      ])
      if (!results[0].meta.changes) throw new ActionError(409, `Nothing published: draft ${id} was published or discarded a moment ago.`)
      return {
        message: `Published ${v.title} version ${number}, dated ${now.slice(0, 10)}. Everyone in the room can read it now.`,
        document: v.slug, version: number, published_at: now, sections: parts.length,
      }
    },
  }),

  action({
    name: 'discard_draft',
    description: 'Throw a draft away. It was never shared, so nobody else sees anything change.',
    changes: true,
    who: 'writers',
    input: z.strictObject({ draft: z.number().int().positive() }),
    async run({ draft: id }, ctx) {
      const v = await draft(ctx.db, id)
      await ctx.db.prepare("UPDATE versions SET state = 'discarded' WHERE id = ? AND state = 'draft'").bind(id).run()
      return { message: `Discarded draft ${id} of ${v.title}.` }
    },
  }),

  action({
    name: 'reply_to_question',
    description: "Reply to a question the documents didn't answer. The person who asked sees it with the question. If others will ask the same thing, add it to a document too. People only.",
    changes: true,
    who: 'writer-people',
    input: z.strictObject({ question: z.number().int().positive(), reply: z.string().trim().min(1).max(4_000) }),
    async run({ question: id, reply }, ctx) {
      const q = await ctx.db.prepare('SELECT q.id, q.question, a.name FROM questions q JOIN members a ON a.id = q.asked_by WHERE q.id = ?').bind(id).first<{ id: number; question: string; name: string }>()
      if (!q) throw new ActionError(404, `There's no question ${id}.`)
      await ctx.db.prepare('UPDATE questions SET reply = ?, replied_by = ?, replied_at = ? WHERE id = ?').bind(reply, ctx.member.id, ctx.now.toISOString(), id).run()
      return { message: `Replied to ${q.name}: "${q.question}"` }
    },
  }),

  action({
    name: 'share',
    description: "Let someone into the room and get their link, shown once. A viewer reads and asks; an admin also adds, publishes, replies and shares. Their AI can use the same token over MCP. People only.",
    changes: true,
    who: 'writer-people',
    input: z.strictObject({
      name: z.string().trim().min(1).max(80).describe('Who the link is for, as the room will show them'),
      access: z.enum(['viewer', 'admin']).describe('viewer: read and ask. admin: also add, publish, reply and share'),
    }),
    async run({ name, access }, ctx) {
      const side = access === 'admin' ? 'writer' : 'reader'
      // Always a new member: sharing again never replaces someone's link, so it can't lock them out.
      const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'member'
      const taken = new Set((await ctx.db.prepare("SELECT id FROM members WHERE id = ? OR id LIKE ? || '-%'").bind(base, base).all<{ id: string }>()).results.map(r => r.id))
      let id = base
      for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
      const bytes = crypto.getRandomValues(new Uint8Array(32))
      const token = `hn_${btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
      await ctx.db.prepare('INSERT INTO members (id, name, kind, side, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, name, 'person', side, await sha256Hex(token), ctx.now.toISOString()).run()
      const origin = ctx.origin ?? ''
      return {
        message: `${name} can now ${access === 'admin' ? 'read, add, publish, reply and share' : 'read and ask'}. Copy the link now: nobody can see it again.`,
        member: { id, name, kind: 'person', side, access },
        link: `${origin}/#t=${token}`,
        mcp: `claude mcp add --transport http room ${origin}/mcp --header "Authorization: Bearer ${token}"`,
        token,
      }
    },
  }),
]

const BY_NAME = new Map(ACTIONS.map(a => [a.name, a]))

export function find(name: string): Action {
  const a = BY_NAME.get(name)
  if (!a) throw new ActionError(404, `There's no action called "${name}". GET /api/actions lists them.`)
  return a
}

export const inputSchema = (a: Action) => {
  const { $schema: _, ...schema } = z.toJSONSchema(a.input, { io: 'input' }) as Record<string, unknown>
  return schema
}

export const describeActions = () => ACTIONS.map(a => ({ name: a.name, description: a.description, changes: a.changes, who: a.who ?? 'anyone', input: inputSchema(a) }))

/** Every call from the page, the API and MCP comes through here. The rules about who may do what live here and nowhere else. */
export async function perform(name: string, raw: unknown, ctx: Ctx): Promise<Result> {
  const a = find(name)
  const who = a.who ?? 'anyone'
  if (who !== 'anyone' && ctx.member.side !== 'writer') throw new ActionError(403, `Nothing changed: ${a.name} is for the people who write the documents.`)
  if (who === 'writer-people' && ctx.member.kind !== 'person') throw new ActionError(403, `Nothing changed: only a person can ${{ publish_draft: 'publish', share: 'share the room' }[a.name] ?? 'reply'}. Agents can add drafts for a person to publish.`)
  const parsed = a.input.safeParse(raw ?? {})
  if (!parsed.success) {
    const problems = parsed.error.issues.map(i => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')
    throw new ActionError(400, `Nothing changed. ${problems}`)
  }
  // Awaited here, not returned: a run() that throws before its first await would otherwise
  // reject a promise nobody is holding yet, and workerd reports it as unhandled.
  return await a.run(parsed.data, ctx)
}
