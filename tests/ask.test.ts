import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { ftsQuery, MODEL, TOP_K, WHOLE_ROOM } from '../src/answer'
import { ActionError, perform } from '../src/actions'
import { ai, ctx, lastPrompt, modelCites, modelSays, publish, reset, seed } from './helpers'

beforeEach(async () => { await reset(); await seed() })

describe('ftsQuery', () => {
  it('quotes the words that matter and drops the rest', () => {
    expect(ftsQuery("What's left to do, and when does it go live?")).toBe('"left" OR "go" OR "live"')
    expect(ftsQuery('"); DROP TABLE sections; --')).toBe('"drop" OR "table" OR "sections"')
    expect(ftsQuery('is it the')).toBeNull()
  })
})

describe('ask', () => {
  it("doesn't call the model when nothing is published", async () => {
    await reset()
    const r = await perform('ask', { question: 'Does it work with Xero?' }, ctx('kira'))
    expect(r).toMatchObject({ state: 'not_in_documents', message: "The documents don't answer that yet. We've passed your question to Sam." })
    expect(ai.run).not.toHaveBeenCalled()
  })

  it('answers from the sections it found, and says where it came from', async () => {
    modelCites(['Build notes › Waiting on Kira', 'Build notes › Waiting on Kira'], 'Nothing this week. Wedding quotes are in, as you asked.')
    const r = await perform('ask', { question: 'Is there anything you need from me?' }, ctx('kira'))
    expect(r).toMatchObject({ message: 'Answered from the documents.', state: 'answered', question: 1 })
    expect(r.cites).toEqual([{ n: 10, document: 'build-notes', title: 'Build notes', version: 2, published_at: '2026-10-02T09:05:00.000Z', heading: 'Build notes › Waiting on Kira', anchor: 'waiting-on-kira' }])

    const [model, inputs] = ai.run.mock.calls[0] as [string, { messages: { content: string }[]; response_format: unknown }]
    expect(model).toBe(MODEL)
    // A small room goes in whole, in document order, so "need from me" doesn't have to match any words.
    expect(inputs.messages[1].content).toMatch(/^Sections:\n\n\[1\] How it works, version 1 \(2026-09-01\), section "How it works":/)
    expect(inputs.messages[1].content).toContain('[10] Build notes, version 2 (2026-10-02), section "Build notes › Waiting on Kira":')
    expect(inputs.response_format).toMatchObject({ type: 'json_schema' })
  })

  it('says which part the documents miss, and passes that to the writers', async () => {
    modelCites(['Build notes › Next'], 'It goes live on 14 October, if the test week goes well.', 'whether it can follow up Instagram messages')
    const r = await perform('ask', { question: 'When does it go live, and will it follow up Instagram messages?' }, ctx('kira'))
    expect(r).toMatchObject({ state: 'partly', message: "Partly answered. The documents don't cover: whether it can follow up Instagram messages. We've passed that part to Sam." })
    expect((await perform('list_questions', { show: 'open' }, ctx('sam'))).questions).toMatchObject([{ asked_by: 'Kira', state: 'partly' }])
  })

  it("doesn't show an answer that cites nothing", async () => {
    modelSays({ answer: 'Yes, it sends each booking to Xero overnight.', cites: [], missing: '' })
    const r = await perform('ask', { question: 'Does it send bookings to Xero?' }, ctx('kira'))
    expect(r).toMatchObject({ state: 'not_in_documents', answer: '', cites: [] })
    const row = await env.DB.prepare('SELECT state, dropped FROM questions').first()
    expect(row).toEqual({ state: 'uncited', dropped: 'Yes, it sends each booking to Xero overnight.' })
  })

  it('says so when the documents have nothing on it', async () => {
    modelSays({ answer: '', cites: [], missing: 'Can it reply to Instagram DMs?' })
    const r = await perform('ask', { question: 'Can it reply to Instagram DMs?' }, ctx('kira'))
    expect(r).toMatchObject({ state: 'not_in_documents', message: "The documents don't answer that yet. We've passed your question to Sam." })
  })

  it('answers from what was published by a date', async () => {
    modelCites(['Build notes › Waiting on Kira'], 'Three more example follow-ups, and a yes or no on wedding quotes.')
    const r = await perform('ask', { question: 'What did you need from me?', as_of: '2026-09-15' }, ctx('kira'))
    expect(r.cites).toMatchObject([{ document: 'build-notes', version: 1 }])
    expect(lastPrompt()).not.toContain('Costs')
  })

  it('searches instead when the room is too big to send whole', async () => {
    const filler = Array.from({ length: 30 }, (_, i) => `## Appendix ${i + 1}\n\n${'Lens and flash settings for beach portraits. '.repeat(25)}`).join('\n\n')
    expect(filler.length).toBeGreaterThan(WHOLE_ROOM)
    await publish(`# Appendix\n\n${filler}`, { title: 'Appendix', at: '2026-10-03T00:00:00Z' })
    modelCites(['Build notes › Next'], 'Live on 14 October.')
    const r = await perform('ask', { question: 'What date does it go live?' }, ctx('kira'))
    expect(r.state).toBe('answered')
    expect(lastPrompt().match(/^\[\d+\]/gm)!.length).toBeLessThanOrEqual(TOP_K)
    expect(lastPrompt()).not.toContain('Appendix 1')
    expect(lastPrompt()).toContain('Build notes, version 2 (2026-10-02), section "Build notes › Next"')
  })

  it("keeps the question when the model fails, and says so once", async () => {
    ai.run.mockImplementationOnce(async () => { throw new Error('3040: capacity') })
    const r = await perform('ask', { question: 'What is churn like?' }, ctx('kira'))
    expect(r).toMatchObject({ state: 'for_writers', message: "The AI that reads the documents didn't answer, so your question went straight to Sam." })
    expect((await perform('list_questions', { show: 'open' }, ctx('sam'))).questions).toHaveLength(1)
  })

  it('stops at the daily cap', async () => {
    const c = { ...ctx('kira'), asksPerDay: 2 }
    await perform('ask_writers', { question: 'One?' }, c)
    await perform('ask_writers', { question: 'Two?' }, c)
    await expect(perform('ask', { question: 'Three?' }, c)).rejects.toSatisfy((e: unknown) => e instanceof ActionError && e.status === 429)
    expect(ai.run).not.toHaveBeenCalled()
  })
})

describe('questions', () => {
  it('readers see their own, writers see everyone\'s and reply', async () => {
    await perform('ask_writers', { question: 'Can we talk on Thursday?' }, ctx('kira'))
    await perform('ask_writers', { question: 'Is the test week on track?' }, ctx('assistant'))
    expect((await perform('list_questions', {}, ctx('kira'))).questions).toHaveLength(1)
    expect((await perform('list_questions', { show: 'open' }, ctx('sam'))).questions).toHaveLength(2)

    await expect(perform('reply_to_question', { question: 1, reply: 'Yes' }, ctx('draftbot'))).rejects.toThrow(/only a person can reply/)
    await perform('reply_to_question', { question: 1, reply: 'Yes, Thursday works.' }, ctx('sam'))
    expect((await perform('list_questions', {}, ctx('kira'))).questions).toMatchObject([{ reply: 'Yes, Thursday works.', replied_by: 'Sam' }])
    expect((await perform('list_questions', { show: 'open' }, ctx('sam'))).questions).toHaveLength(1)
  })
})
