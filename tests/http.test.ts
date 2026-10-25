import { beforeEach, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { ai, call, fetchWorker, ORIGIN, reset, rpc } from './helpers'

beforeEach(reset)

const signIn = async (token: string) => fetchWorker('/api/session', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
})

const asCookie = (res: Response) => res.headers.get('set-cookie')!.split(';')[0]

describe('signing in on the page', () => {
  it('turns a person\'s token into an HttpOnly cookie', async () => {
    const res = await signIn('kira-token')
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toMatch(/^room_session=kira-token; Path=\/api; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure$/)
    const me = await fetchWorker('/api/me', { headers: { cookie: asCookie(res) } })
    expect(await me.json()).toMatchObject({ you: { id: 'kira', side: 'reader' }, room: 'Saltwater Photography handover' })
  })

  it("won't give an agent a cookie", async () => {
    expect((await signIn('assistant-token')).status).toBe(403)
    expect((await signIn('wrong')).status).toBe(401)
  })

  it('refuses cookie requests from another site, or that are not JSON', async () => {
    const cookie = asCookie(await signIn('sam-token'))
    const post = (headers: Record<string, string>) => fetchWorker('/api/actions/list_documents', { method: 'POST', headers: { cookie, ...headers }, body: '{}' })
    expect((await post({ 'content-type': 'application/json', origin: ORIGIN })).status).toBe(200)
    expect((await post({ 'content-type': 'application/json', origin: 'https://evil.example' })).status).toBe(401)
    expect((await post({ 'content-type': 'text/plain' })).status).toBe(401)
  })
})

describe('uploading a file', () => {
  const upload = (headers: Record<string, string>, fields: Record<string, string | File>) => {
    const form = new FormData()
    for (const [k, v] of Object.entries(fields)) form.append(k, v)
    return fetchWorker('/api/upload', { method: 'POST', headers, body: form })
  }

  it('saves Markdown as a draft as it is', async () => {
    const res = await upload({ authorization: 'Bearer sam-token' }, { file: new File(['# Accounts\n\nGmail and Cloudflare.'], 'accounts.md') })
    expect(await res.json()).toMatchObject({ ok: true, draft: 1, document: 'accounts', message: expect.stringMatching(/Saved a draft of accounts/) })
    expect(ai.toMarkdown).not.toHaveBeenCalled()
  })

  it('turns anything else into Markdown with Workers AI, and keeps only the Markdown', async () => {
    ai.toMarkdown.mockImplementationOnce(async () => ({
      name: 'packages.pdf', mimeType: 'application/pdf', format: 'markdown', tokens: 40,
      data: '# packages.pdf\n## Metadata\n- Producer=Canva\n## Contents\n### Page 1\nSaltwater Photography: wedding packages\n',
    }))
    const res = await upload({ authorization: 'Bearer draftbot-token' }, { file: new File([new Uint8Array([37, 80, 68, 70])], 'packages.pdf', { type: 'application/pdf' }), title: 'Packages' })
    const body = await res.json() as { draft: number }
    expect(body).toMatchObject({ ok: true, document: 'packages' })
    const draft = await (await fetchWorker('/api/actions/get_draft', {
      method: 'POST', headers: { authorization: 'Bearer sam-token', 'content-type': 'application/json' }, body: JSON.stringify({ draft: body.draft }),
    })).json()
    expect(draft).toMatchObject({ source: 'packages.pdf', added_by: 'Draft bot', markdown: '# packages.pdf\n### Page 1\nSaltwater Photography: wedding packages\n' })
  })

  it('says plainly when a file can\'t be converted', async () => {
    ai.toMarkdown.mockImplementationOnce(async () => ({ name: 'x.key', mimeType: '', format: 'error', error: 'Unsupported file type' }))
    const res = await upload({ authorization: 'Bearer sam-token' }, { file: new File(['x'], 'x.key') })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ ok: false, error: "Nothing added: x.key couldn't be turned into Markdown (Unsupported file type)." })
  })

  it('is for writers, and a cookie upload must come from the page', async () => {
    expect((await upload({ authorization: 'Bearer kira-token' }, { file: new File(['# Hi there'], 'a.md') })).status).toBe(403)
    const cookie = asCookie(await signIn('sam-token'))
    expect((await upload({ cookie }, { file: new File(['# Hi there'], 'a.md') })).status).toBe(401)
    expect((await upload({ cookie, origin: ORIGIN }, { file: new File(['# Hi there'], 'a.md') })).status).toBe(200)
  })
})

describe('token limits', () => {
  it('stops a token working once it has run out', async () => {
    await env.DB.prepare("INSERT INTO token_limits (id, expires_at) VALUES ('kira', '2000-01-01T00:00:00Z')").run()
    expect((await signIn('kira-token')).status).toBe(401)
    expect((await call('kira-token', 'list_documents')).status).toBe(401)
    expect((await call('sam-token', 'list_documents')).status).toBe(200)
  })

  it('keeps an agent to the actions its token lists, over the API and MCP', async () => {
    await env.DB.prepare(`INSERT INTO token_limits (id, expires_at, actions) VALUES ('draftbot', '2999-01-01T00:00:00Z', '["list_documents"]')`).run()
    expect((await call('draftbot-token', 'list_documents')).status).toBe(200)
    const refused = await call('draftbot-token', 'add_version', { title: 'Notes', markdown: '# Notes' })
    expect(refused).toMatchObject({ status: 403, body: { error: expect.stringMatching(/^Nothing changed: this token can't add_version/) } })
    const { body } = await rpc('draftbot-token', 'tools/list')
    expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual(['list_documents'])
  })

  it('gives a shared link a year', async () => {
    const { body } = await call('sam-token', 'share', { name: 'Jo', access: 'viewer' })
    const row = await env.DB.prepare('SELECT expires_at FROM token_limits WHERE id = ?').bind(body.member.id).first<{ expires_at: string }>()
    const days = (Date.parse(row!.expires_at) - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(364)
    expect(days).toBeLessThan(366)
  })
})

describe('off switch', () => {
  it('answers every API and MCP call with what did not happen, until it is back on', async () => {
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('off-switch', 'on')").run()
    expect(await call('sam-token', 'list_documents')).toMatchObject({ status: 503, body: { error: expect.stringMatching(/^Switched off: nothing was done/) } })
    expect(await rpc('assistant-token', 'tools/list')).toMatchObject({ status: 503, body: { error: { message: expect.stringMatching(/^Switched off/) } } })
    await env.DB.prepare("DELETE FROM settings WHERE key = 'off-switch'").run()
    expect((await call('sam-token', 'list_documents')).status).toBe(200)
  })
})
