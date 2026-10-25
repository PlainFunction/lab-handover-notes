// The off switch. Off, every API and MCP call says nothing was done; on, it carries on.
// Tokens and data are untouched, so turning it back on is all it takes.
//
//   npm run off -- --remote
//   npm run on -- --remote

import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({ options: { remote: { type: 'boolean', default: false } }, allowPositionals: true })
const state = positionals[0]
if (!['on', 'off'].includes(state)) { console.error('Say on or off'); process.exit(1) }

const sql = state === 'off'
  ? "INSERT OR REPLACE INTO settings (key, value) VALUES ('off-switch', 'on')"
  : "DELETE FROM settings WHERE key = 'off-switch'"
// One command string: npx is a .cmd on Windows, which Node only runs through a shell.
// Nothing here comes from the command line except on or off, checked above.
const where = values.remote ? '--remote' : '--local'
const run = spawnSync(`npx wrangler d1 execute handover-notes ${where} --config wrangler.toml --command "${sql}"`, { stdio: ['ignore', 'ignore', 'inherit'], shell: true })
if (run.status !== 0) { console.error('wrangler d1 execute failed, so nothing changed.'); process.exit(1) }
console.log(state === 'off' ? 'Switched off. Every call now says nothing was done.' : 'Switched back on.')
