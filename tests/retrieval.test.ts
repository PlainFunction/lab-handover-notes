import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { gather, prompt, search, TOP_K } from '../src/answer'
import { reset, seed } from './helpers'
import questions from './fixtures/questions.json'

// Not a unit test: the measurement in the write-up. Twenty-two questions an owner
// might ask of the made-up handover notes, worded the way people talk rather than
// like the headings, and two the notes can't answer. Does word search put the right
// section in front of the model?

beforeAll(async () => { await reset(); await seed() })

describe('retrieval over the made-up handover notes', () => {
  it(`finds the right section in the top ${TOP_K} for most questions`, async () => {
    const rows: string[] = []
    let found = 0
    let first = 0
    let answerable = 0
    for (const { q, doc, heading } of questions as { q: string; doc: string | null; heading?: string }[]) {
      const hits = await search(env.DB, q)
      if (!doc) { rows.push(`  none expected  ${hits.length} hit(s)  ${q}`); continue }
      answerable++
      const at = hits.findIndex(h => h.document === doc && h.heading.endsWith(heading!))
      if (at >= 0) found++
      if (at === 0) first++
      rows.push(`  ${at >= 0 ? `found at ${at + 1}` : 'MISSED    '}  ${q}${at < 0 ? `  (got ${hits.map(h => h.heading).join(' | ') || 'nothing'})` : ''}`)
    }
    console.log(`\nRight section in the top ${TOP_K}: ${found} of ${answerable}. First: ${first} of ${answerable}.\n${rows.join('\n')}`)
    expect(found).toBeGreaterThanOrEqual(Math.floor(answerable * 0.75))
  })

  it('is small enough to send whole', async () => {
    const { hits, how } = await gather(env.DB, 'Is there anything you need from me?')
    const chars = prompt('Is there anything you need from me?', hits).reduce((n, m) => n + m.content.length, 0)
    console.log(`\nWhole room: ${hits.length} sections, a prompt of ${chars} characters (about ${Math.round(chars / 4)} tokens).`)
    expect(how).toBe('whole')
    expect(hits).toHaveLength(23)
  })
})
