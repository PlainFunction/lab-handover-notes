// Answers a question from the room's documents, or says which part they don't
// cover. A small room is sent whole; a big one is searched (SQLite FTS5, no
// embeddings) and the model sees the best sections. Either way it only sees
// sections, and an answer that can't point at one isn't shown.

export const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
/**
 * Up to this many characters of current sections, the model reads all of them
 * (about 6,000 tokens; the model takes 24,000). Word search missed 4 of our 22
 * test questions, all on wording ("hosted" against "runs", "cancel" against
 * "stops Looked After"), and a client's handover notes are far smaller than this.
 */
export const WHOLE_ROOM = 24_000
/** How many sections the model reads when the room is too big to send whole. */
export const TOP_K = 6

export interface Hit {
  n: number
  document: string
  title: string
  version: number
  published_at: string
  heading: string
  anchor: string
  body: string
  snippet: string
}

export type Cite = Omit<Hit, 'body' | 'snippet'>

export interface Answer {
  state: 'answered' | 'partly' | 'not_in_documents' | 'uncited'
  answer: string
  missing: string
  cites: Cite[]
  /** What the model said when it was dropped for citing nothing. Kept for us, never shown. */
  dropped?: string
}

const STOP = new Set(('a an and are as at be but by can did do does for from had has have how i if in is it its ' +
  'me my of on or our so than that the their them there these they this to was we were what when where which who ' +
  'why will with you your about any much many tell please').split(' '))

/** Words from a question, as an FTS5 query: each quoted, any of them may match. bm25 ranks the rest. */
export function ftsQuery(text: string): string | null {
  // Split the way FTS5's unicode61 tokenizer does, so "what's" is "what" and "s", and quotes can't get through.
  const words = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
    .filter(w => w.length > 1 && !STOP.has(w))
    .slice(0, 16)
  return words.length ? words.map(w => `"${w}"`).join(' OR ') : null
}

/** The version ids a search covers: each document's current version, or the one that was current on a date. */
const versionsIn = (asOf?: string) => asOf
  ? { sql: `SELECT (SELECT v2.id FROM versions v2 WHERE v2.document_id = d2.id AND v2.state = 'published' AND v2.published_at <= ? ORDER BY v2.number DESC LIMIT 1) FROM documents d2`, binds: [`${asOf}T23:59:59.999Z`] }
  : { sql: 'SELECT current_version FROM documents', binds: [] }

export async function search(db: D1Database, text: string, opts: { asOf?: string; limit?: number } = {}): Promise<Hit[]> {
  const q = ftsQuery(text)
  if (!q) return []
  const scope = versionsIn(opts.asOf)
  const { results } = await db.prepare(
    `SELECT sections.heading, sections.anchor, sections.body,
            snippet(sections, 1, '**', '**', '…', 24) AS snippet,
            v.number AS version, v.published_at, d.slug AS document, d.title
       FROM sections
       JOIN versions v ON v.id = CAST(sections.version_id AS INTEGER)
       JOIN documents d ON d.id = v.document_id
      WHERE sections MATCH ? AND v.id IN (${scope.sql})
      ORDER BY bm25(sections, 2.0, 1.0)
      LIMIT ?`,
  ).bind(q, ...scope.binds, opts.limit ?? TOP_K).all<Omit<Hit, 'n'>>()
  return results.map((r, i) => ({ ...r, n: i + 1 }))
}

/**
 * The sections a question is answered from: the whole room when it's small,
 * otherwise the best search matches. A whole room is numbered in document order.
 */
export async function gather(db: D1Database, text: string, opts: { asOf?: string } = {}): Promise<{ hits: Hit[]; how: 'whole' | 'search' }> {
  const scope = versionsIn(opts.asOf)
  const size = await db.prepare(`SELECT COALESCE(SUM(length(body)), 0) AS n FROM sections WHERE CAST(version_id AS INTEGER) IN (${scope.sql})`)
    .bind(...scope.binds).first<{ n: number }>()
  if ((size?.n ?? 0) > WHOLE_ROOM) return { hits: await search(db, text, opts), how: 'search' }
  const { results } = await db.prepare(
    `SELECT sections.heading, sections.anchor, sections.body, '' AS snippet,
            v.number AS version, v.published_at, d.slug AS document, d.title
       FROM sections
       JOIN versions v ON v.id = CAST(sections.version_id AS INTEGER)
       JOIN documents d ON d.id = v.document_id
      WHERE v.id IN (${scope.sql})
      ORDER BY d.id, sections.rowid`,
  ).bind(...scope.binds).all<Omit<Hit, 'n'>>()
  return { hits: results.map((r, i) => ({ ...r, n: i + 1 })), how: 'whole' }
}

const SYSTEM = `You answer questions about a set of documents, using only the numbered sections you are given.
- Use only what the sections say. Never add facts, estimates, opinions or advice of your own.
- Put the number of every section you used in "cites".
- If the sections answer only part of the question, answer that part, and say in "missing" exactly which part they don't cover.
- If they don't answer it at all, set "answer" to "", "cites" to [] and "missing" to the whole question.
- When the answer depends on when something was written, give the date or version.
- Plain English, Australian spelling, under 120 words, no headings.`

const SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    cites: { type: 'array', items: { type: 'integer' } },
    missing: { type: 'string' },
  },
  required: ['answer', 'cites', 'missing'],
  additionalProperties: false,
}

export function prompt(question: string, hits: Hit[]) {
  const sources = hits.map(h =>
    `[${h.n}] ${h.title}, version ${h.version} (${h.published_at.slice(0, 10)}), section "${h.heading || 'Top'}":\n${h.body}`).join('\n\n')
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Sections:\n\n${sources}\n\nQuestion: ${question}` },
  ]
}

const cite = ({ body: _b, snippet: _s, ...c }: Hit): Cite => c

export class ModelError extends Error {}

export async function answer(ai: Ai, question: string, hits: Hit[], gateway?: string): Promise<Answer> {
  // Nothing matched, so there's nothing to read and no reason to pay for a model.
  if (!hits.length) return { state: 'not_in_documents', answer: '', missing: question, cites: [] }

  let out: { response?: unknown }
  try {
    out = await ai.run(MODEL as Parameters<Ai['run']>[0], {
      messages: prompt(question, hits),
      response_format: { type: 'json_schema', json_schema: SCHEMA },
      max_tokens: 500,
      temperature: 0.1,
    } as never, gateway ? { gateway: { id: gateway, collectLog: false } } : undefined) as { response?: unknown }
  } catch (err) {
    throw new ModelError(err instanceof Error ? err.message : String(err))
  }
  // With a schema, Workers AI sometimes hands back an object and sometimes a string.
  let reply: { answer?: unknown; cites?: unknown; missing?: unknown }
  try { reply = typeof out.response === 'string' ? JSON.parse(out.response) : out.response as typeof reply }
  catch { throw new ModelError('The model replied with something that was not JSON.') }
  if (!reply || typeof reply !== 'object') throw new ModelError('The model gave no answer.')

  const text = typeof reply.answer === 'string' ? reply.answer.trim() : ''
  const missing = typeof reply.missing === 'string' ? reply.missing.trim() : ''
  // Only numbers we gave it count. A made-up [9] is the same as no citation.
  const ns = Array.isArray(reply.cites) ? [...new Set(reply.cites.filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= hits.length))] : []
  const cites = ns.sort((a, b) => a - b).map(n => cite(hits[n - 1]))

  if (!text) return { state: 'not_in_documents', answer: '', missing: missing || question, cites: [] }
  if (!cites.length) return { state: 'uncited', answer: '', missing: question, cites: [], dropped: text }
  return { state: missing ? 'partly' : 'answered', answer: text, missing, cites }
}
