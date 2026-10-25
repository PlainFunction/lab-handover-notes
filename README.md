# Lab 008: handover notes you can question

The code behind our lab [We Made Our Handover Notes Answer Questions and Say Where From](https://plainfunction.com.au/labs/handover-notes).

A room of documents, kept as Markdown, versioned and dated. One side (or
both) adds them; anyone in the room reads them and asks questions, on a web
page or from their own AI over MCP. We built it for the notes we hand a client
with an automation (how it works, the weekly build notes, how to do it by
hand), and it works the same for progress updates, explainers and pitches.

- **Everything is Markdown.** Upload Markdown or text as it is. PDFs, Word,
  Excel, HTML and images go through Workers AI's `toMarkdown`, and only the
  Markdown is kept.
- **Nothing is shared until a person reads it.** Every upload is a draft.
  A writer's agent can add drafts, but only a person publishes.
- **Every version stays, with its date and what changed.** Read any version,
  see what was current on a date, compare two.
- **Answers come only from the documents, and say where.** A small room is
  sent to the model whole; a big one is searched with SQLite FTS5. An answer
  that can't point at a section isn't shown. When the documents don't say, the
  reply says which part, and the question goes to the writers.

This repo is synced automatically from another source and doesn't take pull
requests.

```bash
npm install
npm test               # type-check, then the tests (in workerd, with real D1 and FTS5, and a stand-in for Workers AI)
npm run db:local       # make the tables in a local D1
npm run invite -- --name "Sam" --side writer      # the first writer's link, printed once
npm run dev            # http://localhost:8787 (Workers AI runs on Cloudflare, so this needs `wrangler login`)
```

## How it runs

```
Browser ──▶ static assets (index.html, app.js, app.css: about 8 KB gzipped, no framework)
        ──▶ /api/*  ──▶ Worker ──▶ D1 (documents, versions, FTS5 sections, questions)
Agent   ──▶ /mcp    ──▶ Worker ──▶ Workers AI (answers, file conversion)
```

- `src/actions.ts`: every action, its input as a zod schema, and `perform()`,
  which holds the rules about who may do what. Read it first.
- `src/answer.ts`: picks the sections (the whole room, or a search), asks the
  model, and drops any answer that doesn't cite one.
- `src/markdown.ts`: splitting at headings, and the line diff.
- `src/mcp.ts`: MCP over plain HTTP POST. The tools are the actions; each
  document's current version is also a `text/markdown` resource.
- `src/worker.ts`: routing, sign-in and uploads.
- `schema.sql`: members, documents, versions, sections (FTS5) and questions.

## The actions

| Action | Who |
|---|---|
| `list_documents`, `read_document`, `list_versions`, `compare_versions`, `search` | Anyone |
| `ask`, `ask_writers`, `list_questions` | Anyone (readers see their own questions) |
| `add_version`, `get_draft`, `discard_draft` | Writers, people or agents |
| `publish_draft`, `reply_to_question`, `share` | Writers who are people |

`GET /api/actions` lists them with the JSON Schema of each input.

## Connecting an AI

`npm run invite` prints the MCP command with the token. For Claude Code:

```bash
claude mcp add --transport http room https://room.example.com/mcp --header "Authorization: Bearer hn_..."
```

## Deploying

```bash
npx wrangler d1 create handover-notes --location oc   # put the id in wrangler.toml
# uncomment routes in wrangler.toml with your host: workers.dev is off
npm run db:remote
npm run invite -- --name "Sam" --side writer --url https://room.example.com --remote
npm run deploy
```

After that, a writer lets people in from the page: Share asks who it's for
and whether they're a Viewer (reads and asks) or an Admin (also adds,
publishes, replies and shares), then shows their link once. Sharing never
replaces someone already in the room. The invite script is still how you
replace or revoke a link.

Set `ROOM_NAME` in `wrangler.toml`. `ASKS_PER_DAY` caps questions per member
(default 50), so a loop in someone's agent can't run up the bill. Run
`npm run invite` again for the same name to replace a link, or
`npm run invite -- --revoke <id> --remote` to stop one working.

A person's token works for a year and an agent's for 90 days; `--days` changes
that. `--actions` keeps an agent to the actions it needs, say
`--kind agent --actions list_documents,read_document,ask`. Run `npm run db:remote` again after updating: it adds
the table for this and gives tokens from before it a year.

## Switching it off

`npm run off -- --remote` stops the room without a deploy: every API and MCP
call says nothing was done, for people and agents alike. Nothing is deleted, and
`npm run on -- --remote` starts it again.

## If a token leaks

Revoke it (`--revoke <id> --remote`) and give them a new one. There are no other
keys to rotate: Workers AI and D1 are bindings, not keys. If you can't tell
which token leaked, switch it off, replace them all, and switch it back on.

## License

MIT
