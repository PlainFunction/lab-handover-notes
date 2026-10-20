import { beforeEach, describe, expect, it } from 'vitest'
import { ActionError, perform } from '../src/actions'
import { call, ctx, MEMBERS, ORIGIN, publish, reset, seed } from './helpers'

beforeEach(reset)

const refused = (p: Promise<unknown>, status: number, text: RegExp) =>
  expect(p).rejects.toSatisfy((e: unknown) => e instanceof ActionError && e.status === status && text.test(e.message))

describe('drafts', () => {
  it("are only seen by writers until a person publishes them", async () => {
    const added = await perform('add_version', { title: 'How it works', markdown: '# How it works\n\nQuotes that go quiet get a follow-up.' }, ctx('sam'))
    expect(added).toMatchObject({ draft: 1, document: 'how-it-works', message: expect.stringMatching(/Nobody else sees it/) })

    expect((await perform('list_documents', {}, ctx('kira'))).documents).toEqual([])
    await refused(perform('read_document', { document: 'how-it-works' }, ctx('kira')), 404, /no document called "how-it-works"/)
    expect((await perform('list_documents', {}, ctx('sam'))).drafts).toMatchObject([{ draft: 1, slug: 'how-it-works', added_by: 'Sam' }])

    await perform('publish_draft', { draft: 1 }, ctx('sam', '2026-09-01T09:00:00Z'))
    const read = await perform('read_document', { document: 'how-it-works' }, ctx('kira'))
    expect(read).toMatchObject({ message: 'How it works, version 1, published 2026-09-01', version: 1, markdown: '# How it works\n\nQuotes that go quiet get a follow-up.\n' })
    expect((await perform('list_documents', {}, ctx('sam'))).drafts).toEqual([])
  })

  it("can be added by a writer's agent, but only a person publishes", async () => {
    const { draft } = await perform('add_version', { title: 'Build notes', markdown: '# Build notes\n\nGmail is connected.' }, ctx('draftbot'))
    await refused(perform('publish_draft', { draft }, ctx('draftbot')), 403, /only a person can publish/)
    expect((await perform('get_draft', { draft }, ctx('sam')))).toMatchObject({ added_by: 'Draft bot', replaces: null, markdown: '# Build notes\n\nGmail is connected.\n' })
    await perform('publish_draft', { draft }, ctx('sam'))
  })

  it("can't be added, read or published by readers", async () => {
    await refused(perform('add_version', { title: 'Notes', markdown: '# Notes\n\nSomething.' }, ctx('kira')), 403, /for the people who write/)
    await refused(perform('get_draft', { draft: 1 }, ctx('kira')), 403, /for the people who write/)
    await refused(perform('publish_draft', { draft: 1 }, ctx('assistant')), 403, /for the people who write/)
  })

  it('can be discarded, and published only once', async () => {
    const a = await perform('add_version', { title: 'How it works', markdown: '# One\n\nfirst draft' }, ctx('sam'))
    await perform('discard_draft', { draft: a.draft }, ctx('sam'))
    await refused(perform('publish_draft', { draft: a.draft }, ctx('sam')), 404, /no draft/)

    const b = await perform('add_version', { document: 'how-it-works', markdown: '# One\n\nsecond draft' }, ctx('sam'))
    await perform('publish_draft', { draft: b.draft }, ctx('sam'))
    await refused(perform('publish_draft', { draft: b.draft }, ctx('sam')), 404, /no draft/)
    expect((await perform('list_versions', { document: 'how-it-works' }, ctx('kira'))).versions).toHaveLength(1)
  })
})

describe('versions', () => {
  beforeEach(seed)

  it('are numbered and dated, with what changed', async () => {
    const { versions } = await perform('list_versions', { document: 'build-notes' }, ctx('kira'))
    expect(versions).toMatchObject([
      { version: 1, published_at: '2026-09-01T09:05:00.000Z', note: '', added_by: 'Sam', published_by: 'Sam' },
      { version: 2, published_at: '2026-10-02T09:05:00.000Z', note: 'Test week started, and wedding quotes are in' },
    ])
  })

  it('can be read by number or as they stood on a date', async () => {
    expect(await perform('read_document', { document: 'build-notes' }, ctx('kira'))).toMatchObject({ version: 2, current: true })
    const old = await perform('read_document', { document: 'build-notes', version: 1 }, ctx('kira'))
    expect(old).toMatchObject({ version: 1, current: false, message: 'Build notes, version 1, published 2026-09-01 (not the current version)' })
    expect(old.markdown).toContain("Drafting follow-ups in Kira's voice")
    expect(await perform('read_document', { document: 'build-notes', as_of: '2026-09-30' }, ctx('kira'))).toMatchObject({ version: 1 })
    await refused(perform('read_document', { document: 'costs', as_of: '2026-09-30' }, ctx('kira')), 404, /hadn't been published by 2026-09-30/)
  })

  it('can be compared', async () => {
    const c = await perform('compare_versions', { document: 'build-notes', from: 1 }, ctx('kira'))
    expect(c.message).toMatch(/^Build notes, version 1 \(2026-09-01\) to 2 \(2026-10-02\): \d+ lines added, \d+ removed$/)
    expect(c.diff).toContain('- - A yes or no on following up wedding quotes as well as portraits')
    expect(c.diff).toContain('+ Live on 14 October, if the test week goes well.')
    await refused(perform('compare_versions', { document: 'build-notes', from: 2, to: 2 }, ctx('kira')), 400, /same version/)
  })

  it('need a note saying what changed, and a change', async () => {
    await refused(perform('add_version', { document: 'accounts', markdown: '# Accounts\n\nNew' }, ctx('sam')), 400, /say what changed in "note"/)
    const accounts = (await perform('read_document', { document: 'accounts' }, ctx('sam'))).markdown as string
    await refused(perform('add_version', { document: 'accounts', markdown: accounts, note: 'Same' }, ctx('sam')), 409, /word for word/)
  })

  it('are searched as they stand now, or on a date', async () => {
    const now = await perform('search', { query: 'test week' }, ctx('kira'))
    expect((now.results as unknown[])[0]).toMatchObject({ document: 'build-notes', version: 2, heading: 'Build notes › Next', anchor: 'next' })
    const then = (await perform('search', { query: 'test week', as_of: '2026-09-30' }, ctx('kira'))).results as { document: string; version: number }[]
    expect(then.some(r => r.document === 'costs')).toBe(false)
    expect(then.every(r => r.version === 1)).toBe(true)
    expect((await perform('search', { query: 'the and of' }, ctx('kira'))).message).toBe('Nothing in the documents matched those words.')
  })
})

describe('new documents', () => {
  it('get a slug from the title, and a different one if it is taken', async () => {
    await publish('# A\n\nfirst one', { title: 'Q3 update', at: '2026-10-01T00:00:00Z' })
    const second = await perform('add_version', { title: 'Q3 update', markdown: '# B\n\nsecond one' }, ctx('sam'))
    expect(second.document).toMatch(/^q3-update-[a-z0-9]+$/)
  })

  it('refuse empty Markdown and unknown fields', async () => {
    await refused(perform('add_version', { title: 'Empty', markdown: '  ' }, ctx('sam')), 400, /empty/)
    await refused(perform('add_version', { titel: 'Typo', markdown: '# Hi there' }, ctx('sam')), 400, /Unrecognized key: "titel"/)
  })
})

describe('over HTTP', () => {
  it('needs a token, and lists the actions with their schemas', async () => {
    expect((await call('nope', 'list_documents')).status).toBe(401)
    const res = await call('kira-token', 'list_documents')
    expect(res.body).toMatchObject({ ok: true, you: { id: 'kira', side: 'reader' }, room: 'Saltwater Photography handover' })
    expect((await call('kira-token', 'add_version', { title: 'x', markdown: '# Hello there' })).status).toBe(403)
  })
})

describe('sharing', () => {
  it('gives a viewer a link that reads and asks, and nothing more', async () => {
    const shared = await call(MEMBERS.sam.token, 'share', { name: 'Jo Smith', access: 'viewer' })
    expect(shared).toMatchObject({ status: 200, body: { ok: true, member: { id: 'jo-smith', side: 'reader', access: 'viewer' }, message: expect.stringMatching(/Jo Smith can now read and ask/) } })
    expect(shared.body.link).toBe(`${ORIGIN}/#t=${shared.body.token}`)
    expect(shared.body.mcp).toContain(`${ORIGIN}/mcp`)

    expect((await call(shared.body.token, 'list_documents')).body.you).toMatchObject({ name: 'Jo Smith', side: 'reader', kind: 'person' })
    expect((await call(shared.body.token, 'add_version', { title: 'Notes', markdown: '# Notes\n\nx' })).status).toBe(403)
  })

  it('gives an admin a link that can write and share', async () => {
    const { body } = await call(MEMBERS.sam.token, 'share', { name: 'Alex', access: 'admin' })
    expect(body.member).toMatchObject({ side: 'writer', access: 'admin' })
    expect((await call(body.token, 'add_version', { title: 'Notes', markdown: '# Notes\n\nx' })).status).toBe(200)
    expect((await call(body.token, 'share', { name: 'Kim', access: 'viewer' })).status).toBe(200)
  })

  it("never replaces someone who's already in the room", async () => {
    const { body } = await call(MEMBERS.sam.token, 'share', { name: 'Kira', access: 'admin' })
    expect(body.member.id).toBe('kira-2')
    expect((await call(MEMBERS.kira.token, 'list_documents')).body.you).toMatchObject({ id: 'kira', side: 'reader' })
    expect((await call(MEMBERS.sam.token, 'share', { name: 'Kira', access: 'viewer' })).body.member.id).toBe('kira-3')
  })

  it('is only for people on the writing side', async () => {
    await refused(perform('share', { name: 'Jo', access: 'admin' }, ctx('kira')), 403, /for the people who write/)
    await refused(perform('share', { name: 'Jo', access: 'admin' }, ctx('draftbot')), 403, /only a person can share the room/)
    await refused(perform('share', { name: 'Jo', access: 'owner' }, ctx('sam')), 400, /access/)
  })
})
