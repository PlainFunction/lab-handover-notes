-- Everyone in the room. Writers add and publish documents; readers read and ask.
-- Both sides can be writers (a founder and an investor, a builder and a client).
-- Only a hash of each token is kept.
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('person', 'agent')),
  side TEXT NOT NULL CHECK (side IN ('writer', 'reader')),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- How long each token works and, for an agent, which actions it may run (a JSON list;
-- NULL is every action its side allows). A member with no row here never runs out, so
-- applying this again gives any that are missing a year from now.
CREATE TABLE IF NOT EXISTS token_limits (
  id TEXT PRIMARY KEY REFERENCES members(id),
  expires_at TEXT NOT NULL,
  actions TEXT
);
INSERT OR IGNORE INTO token_limits (id, expires_at) SELECT id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+365 days') FROM members;

-- A document is a name. Its words live in versions.
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  current_version INTEGER,
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL
);

-- Every version is Markdown, kept for good and never edited once published.
-- A draft is only seen by writers until a person publishes it.
CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  number INTEGER,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'published', 'discarded')),
  markdown TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  sha256 TEXT NOT NULL,
  added_by TEXT NOT NULL REFERENCES members(id),
  added_at TEXT NOT NULL,
  published_by TEXT REFERENCES members(id),
  published_at TEXT
);
CREATE INDEX IF NOT EXISTS versions_document ON versions (document_id, state, number);
-- Two drafts published at once can't both become the same version.
CREATE UNIQUE INDEX IF NOT EXISTS versions_number ON versions (document_id, number);

-- Each published version split at its headings, for search. Written when it's published.
CREATE VIRTUAL TABLE IF NOT EXISTS sections USING fts5(
  heading, body, anchor UNINDEXED, version_id UNINDEXED, tokenize = 'porter unicode61'
);

-- Every question asked, how it was answered and which sections it came from.
-- Questions the documents couldn't fully answer wait for a writer.
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asked_by TEXT NOT NULL REFERENCES members(id),
  question TEXT NOT NULL,
  via TEXT NOT NULL CHECK (via IN ('page', 'api', 'mcp')),
  -- uncited: the model answered but couldn't point at a section, so the asker
  -- was told the documents don't say. What it said is kept in dropped, for us.
  state TEXT NOT NULL CHECK (state IN ('answered', 'partly', 'not_in_documents', 'uncited', 'for_writers')),
  answer TEXT NOT NULL DEFAULT '',
  dropped TEXT,
  missing TEXT NOT NULL DEFAULT '',
  cites TEXT NOT NULL DEFAULT '[]',
  asked_at TEXT NOT NULL,
  reply TEXT,
  replied_by TEXT REFERENCES members(id),
  replied_at TEXT
);
CREATE INDEX IF NOT EXISTS questions_by ON questions (asked_by, id);
CREATE INDEX IF NOT EXISTS questions_open ON questions (state, replied_at);

-- One switch that stops the room: while 'off-switch' is here, every API and MCP call
-- says nothing was done. npm run off -- --remote adds it; npm run on takes it away.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
