import { beforeEach, describe, expect, it } from 'vitest'
import { ACTIONS } from '../src/actions'
import { fetchWorker, modelCites, reset, rpc, seed } from './helpers'

beforeEach(async () => { await reset(); await seed() })

describe('/mcp', () => {
  it('needs a token', async () => {
    expect((await rpc(null, 'tools/list')).status).toBe(401)
    expect((await rpc('wrong', 'tools/list')).status).toBe(401)
    expect((await fetchWorker('/mcp')).status).toBe(405)
  })

  it('initialises with the room and its rules in the instructions', async () => {
    const { body } = await rpc('assistant-token', 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    expect(body.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'handover-notes' } })
    expect(body.result.instructions).toMatch(/^Saltwater Photography handover: .*You are Kira's assistant, a reader\./s)
    expect(body.result.instructions).toMatch(/say which document and version/)
    expect(body.result.instructions).not.toMatch(/add_version/)
    expect((await rpc('draftbot-token', 'initialize', {})).body.result.instructions).toMatch(/Only a person publishes/)
    expect((await rpc('assistant-token', 'notifications/initialized')).status).toBe(202)
  })

  it("lists only the tools each side can use", async () => {
    const names = async (token: string) => (await rpc(token, 'tools/list')).body.result.tools.map((t: { name: string }) => t.name)
    expect(await names('assistant-token')).toEqual(['list_documents', 'read_document', 'list_versions', 'compare_versions', 'search', 'ask', 'ask_writers', 'list_questions'])
    expect(await names('draftbot-token')).toEqual(ACTIONS.map(a => a.name))
    const { tools } = (await rpc('assistant-token', 'tools/list')).body.result
    const read = tools.find((t: { name: string }) => t.name === 'read_document')
    expect(read.annotations.readOnlyHint).toBe(true)
    expect(read.inputSchema).toMatchObject({ type: 'object', required: ['document'], additionalProperties: false })
  })

  it('serves each document as a Markdown resource', async () => {
    const { resources } = (await rpc('assistant-token', 'resources/list')).body.result
    expect(resources.map((r: { uri: string }) => r.uri).sort()).toEqual(['room://documents/accounts', 'room://documents/build-notes', 'room://documents/by-hand', 'room://documents/costs', 'room://documents/how-it-works'])
    expect(resources.find((r: { name: string }) => r.name === 'build-notes')).toMatchObject({
      mimeType: 'text/markdown', description: 'Version 2, published 2026-10-02. Test week started, and wedding quotes are in',
    })
    const read = (await rpc('assistant-token', 'resources/read', { uri: 'room://documents/by-hand' })).body.result
    expect(read.contents[0]).toMatchObject({ uri: 'room://documents/by-hand', mimeType: 'text/markdown' })
    expect(read.contents[0].text).toMatch(/^# By hand/)
    expect((await rpc('assistant-token', 'resources/read', { uri: 'room://documents/nope' })).body.error.code).toBe(-32002)
  })

  it('runs the same actions, with the same rules', async () => {
    modelCites(['Costs › Running costs'], 'About 2 cents a draft, so under a dollar a month at your busiest.')
    const asked = await rpc('assistant-token', 'tools/call', { name: 'ask', arguments: { question: 'How much does it cost to run?' } })
    expect(asked.body.result.structuredContent).toMatchObject({ state: 'answered', cites: [{ document: 'costs' }] })
    expect(JSON.parse(asked.body.result.content[0].text)).toEqual(asked.body.result.structuredContent)

    const draft = await rpc('draftbot-token', 'tools/call', { name: 'add_version', arguments: { document: 'build-notes', markdown: '# Build notes\n\nLive since 14 October.', note: 'Went live' } })
    expect(draft.body.result.structuredContent.message).toMatch(/Nobody else sees it until a person publishes it/)

    // A refusal is a result the agent reads, not a protocol error.
    const publish = await rpc('draftbot-token', 'tools/call', { name: 'publish_draft', arguments: { draft: draft.body.result.structuredContent.draft } })
    expect(publish.body.result).toMatchObject({ isError: true, content: [{ text: 'Nothing changed: only a person can publish. Agents can add drafts for a person to publish.' }] })
  })

  it('answers unknown methods and bad JSON with JSON-RPC errors', async () => {
    expect((await rpc('assistant-token', 'prompts/list')).body.error.code).toBe(-32601)
    const bad = await fetchWorker('/mcp', { method: 'POST', headers: { authorization: 'Bearer assistant-token' }, body: '{' })
    expect((await bad.json() as { error: { code: number } }).error.code).toBe(-32700)
  })
})
