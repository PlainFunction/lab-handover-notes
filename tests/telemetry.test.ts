import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { MemoryTelemetry, Telemetry } from '#capabilities'
import { RoomModule } from '../src/module'
import { handle, type Env } from '../src/worker'
import { ORIGIN, ai, reset } from './helpers'

beforeEach(reset)

function traced() {
  const t = new MemoryTelemetry({ serviceName: 'pf-handover-notes', serviceVersion: '0.1.0', environment: 'test', client: 'handover-notes' })
  const e: Env = { DB: env.DB, AI: ai as unknown as Ai }
  const c = new RoomModule(e).build().bind(Telemetry, () => t)
  const post = (path: string, token: string, body: BodyInit, json = true) => handle(c, new Request(`${ORIGIN}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, ...(json ? { 'content-type': 'application/json' } : {}) }, body,
  }), e)
  return { t, post }
}

describe('telemetry', () => {
  it('traces an upload: the request, the conversion and the draft it adds, and logs it', async () => {
    ai.toMarkdown.mockImplementationOnce(async () => ({ name: 'packages.pdf', mimeType: 'application/pdf', format: 'markdown', tokens: 40, data: '# Wedding packages\n' }))
    const form = new FormData()
    form.set('file', new File([new Uint8Array([37, 80, 68, 70])], 'packages.pdf', { type: 'application/pdf' }))
    const { t, post } = traced()
    expect((await post('/api/upload', 'draftbot-token', form, false)).status).toBe(200)

    const byName = Object.fromEntries(t.finishedSpans.map(s => [s.name, s]))
    const root = byName['POST /api/upload']
    expect(root).toMatchObject({ kind: 'server', attrs: { 'http.route': '/api/upload', 'http.response.status_code': 200 } })
    expect(byName['Converter.toMarkdown']).toMatchObject({ parentSpanId: root.spanId, attrs: { 'pf.adapter': 'WorkersAiConverter' } })
    expect(byName['Actions.perform']).toMatchObject({ parentSpanId: root.spanId, attrs: { 'pf.action': 'add_version', 'pf.via': 'api' } })
    expect(t.bufferedLogs).toMatchObject([{ severity: 'info', body: 'http.request', spanId: root.spanId }])
    // Nothing in the documents reaches telemetry.
    expect(JSON.stringify([t.finishedSpans, t.bufferedLogs])).not.toContain('Wedding')
  })

  it('a refused action is a 4xx and an info log, not an error', async () => {
    const { t, post } = traced()
    expect((await post('/api/actions/publish_draft', 'kira-token', JSON.stringify({ draft: 1 }))).status).toBe(403)
    expect(t.finishedSpans.at(-1)).toMatchObject({ name: 'POST /api/actions/:name', error: false, attrs: { 'http.response.status_code': 403 } })
    expect(t.bufferedLogs).toMatchObject([{ severity: 'info', body: 'http.request' }])
  })
})
