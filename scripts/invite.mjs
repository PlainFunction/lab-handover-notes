// Lets someone into the room, and prints their link once. Only a hash of the token is stored.
// Running it again for the same id replaces the token, so the old link stops working.
//
//   npm run invite -- --name "Sam" --side writer --url https://room.example.com
//   npm run invite -- --name "Kira" --side reader --url https://room.example.com --remote
//   npm run invite -- --name "Kira's assistant" --side reader --kind agent --remote
//   npm run invite -- --name "Drafting bot" --side writer --kind agent --actions add_version --days 30 --remote
//   npm run invite -- --revoke kira-s-assistant --remote
//
// A link works for a year (an agent's token for 90 days) unless --days says otherwise.
// --actions limits an agent to those actions (comma separated); without it, it gets
// every action its side allows.

import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    side: { type: 'string', default: 'reader' },
    kind: { type: 'string', default: 'person' },
    id: { type: 'string' },
    url: { type: 'string', default: 'http://localhost:8787' },
    revoke: { type: 'string' },
    days: { type: 'string' },
    actions: { type: 'string' },
    remote: { type: 'boolean', default: false },
  },
})

const sql = s => `'${String(s).replaceAll("'", "''")}'`
const hash = t => createHash('sha256').update(t).digest('hex')

let statement
let token
let expires
if (values.revoke) {
  // Their questions stay, so the row stays. Its token becomes a hash nobody has.
  statement = `UPDATE members SET token_hash = ${sql(`revoked:${randomBytes(16).toString('hex')}`)} WHERE id = ${sql(values.revoke)};`
} else {
  if (!values.name) { console.error('Give a --name, e.g. --name "Kira"'); process.exit(1) }
  if (!['writer', 'reader'].includes(values.side)) { console.error('--side is writer or reader'); process.exit(1) }
  if (!['person', 'agent'].includes(values.kind)) { console.error('--kind is person or agent'); process.exit(1) }
  const days = values.days === undefined ? (values.kind === 'agent' ? 90 : 365) : Number(values.days)
  if (!Number.isInteger(days) || days < 1) { console.error('--days is a whole number of days, 1 or more'); process.exit(1) }
  if (values.actions && values.kind !== 'agent') { console.error('--actions is for agents; people get what their side allows'); process.exit(1) }
  const actions = values.actions ? JSON.stringify(values.actions.split(',').map(a => a.trim()).filter(Boolean)) : null
  expires = new Date(Date.now() + days * 86_400_000).toISOString()
  const id = values.id ?? values.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  token = `hn_${randomBytes(32).toString('base64url')}`
  statement = `INSERT INTO members (id, name, kind, side, token_hash, created_at) VALUES (${sql(id)}, ${sql(values.name)}, ${sql(values.kind)}, ${sql(values.side)}, ${sql(hash(token))}, ${sql(new Date().toISOString())})
ON CONFLICT (id) DO UPDATE SET name = excluded.name, kind = excluded.kind, side = excluded.side, token_hash = excluded.token_hash;
INSERT INTO token_limits (id, expires_at, actions) VALUES (${sql(id)}, ${sql(expires)}, ${actions === null ? 'NULL' : sql(actions)})
ON CONFLICT (id) DO UPDATE SET expires_at = excluded.expires_at, actions = excluded.actions;`
}

const dir = mkdtempSync(join(tmpdir(), 'handover-notes-'))
const file = join(dir, 'invite.sql')
writeFileSync(file, statement)
// One command string: npx is a .cmd on Windows, which Node only runs through a shell,
// and passing an args array with shell: true is deprecated. Nothing here comes from the command line.
const where = values.remote ? '--remote' : '--local'
const run = spawnSync(`npx wrangler d1 execute handover-notes ${where} --config wrangler.toml --file "${file}"`, { stdio: ['ignore', 'ignore', 'inherit'], shell: true })
rmSync(dir, { recursive: true, force: true })
if (run.status !== 0) { console.error('wrangler d1 execute failed, so nothing was saved.'); process.exit(1) }

if (values.revoke) console.log(`Revoked ${values.revoke}'s link. Their questions stay in the room.`)
else {
  const base = values.url.replace(/\/$/, '')
  console.log(`${values.name} can now ${values.side === 'writer' ? 'add, publish and ask' : 'read and ask'}. Nothing stores this, so copy it now.\n`)
  if (values.kind === 'person') console.log(`  Link:  ${base}/#t=${token}\n`)
  console.log(`  MCP:   claude mcp add --transport http room ${base}/mcp --header "Authorization: Bearer ${token}"\n`)
  console.log(`  It works until ${expires.slice(0, 10)}. Run this again for the same name to give a new one.\n`)
}
