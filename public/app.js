// The room's page. No framework: it calls POST /api/actions/<name> (and /api/upload) and draws the result.
'use strict'

const $ = s => document.querySelector(s)
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props)
  e.append(...kids.filter(k => k != null))
  return e
}
const day = iso => iso ? new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : ''

let me = null
let current = null // { document, version }

async function act(name, args = {}) {
  const res = await fetch(`/api/actions/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) })
  const body = await res.json().catch(() => ({ ok: false, error: 'The room did not answer. Try again in a minute.' }))
  if (res.status === 401) { showSignIn(); throw new Error(body.error) }
  if (!body.ok) throw new Error(body.error)
  return body
}

const status = text => { $('#status').textContent = text }

// ---- Markdown, drawn safely: text is escaped first, and only these few things become HTML.

const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const anchorFor = h => h.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-') || 'top'

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noopener noreferrer" target="_blank">$1</a>')
}

/** Headings get the same ids the server gives sections, so a citation can jump to one. */
function markdown(md, into) {
  const used = new Map()
  const out = []
  let list = null
  let para = []
  let fence = null
  const endPara = () => { if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`); para = [] }
  const endList = () => { if (list) out.push(`</${list}>`); list = null }
  for (const line of md.split('\n')) {
    if (fence !== null) {
      if (/^(```|~~~)/.test(line)) { out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`); fence = null } else fence.push(line)
      continue
    }
    if (/^(```|~~~)/.test(line)) { endPara(); endList(); fence = []; continue }
    const h = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line)
    if (h) {
      endPara(); endList()
      const level = Math.min(h[1].length + 1, 6)
      // Only #, ## and ### start a section on the server, so only they count towards anchors.
      let id = ''
      if (h[1].length <= 3) { const base = anchorFor(h[2]); const n = used.get(base) ?? 0; used.set(base, n + 1); id = ` id="s-${esc(n ? `${base}-${n}` : base)}"` }
      out.push(`<h${level}${id}>${inline(h[2])}</h${level}>`)
      continue
    }
    const li = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line)
    if (li) {
      endPara()
      const kind = li[1] ? 'ul' : 'ol'
      if (list !== kind) { endList(); out.push(`<${kind}>`); list = kind }
      out.push(`<li>${inline(li[3])}</li>`)
      continue
    }
    if (/^\|.*\|\s*$/.test(line)) {
      endPara(); endList()
      if (/^\|[\s:|-]+\|\s*$/.test(line)) continue
      const cells = line.trim().slice(1, -1).split('|').map(c => `<td>${inline(c.trim())}</td>`).join('')
      const last = out.at(-1)
      if (last?.endsWith('</tr></table>')) out[out.length - 1] = last.slice(0, -8) + `<tr>${cells}</tr></table>`
      else out.push(`<table><tr>${cells}</tr></table>`)
      continue
    }
    if (/^>\s?/.test(line)) { endPara(); endList(); out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`); continue }
    if (!line.trim()) { endPara(); endList(); continue }
    endList()
    para.push(line.trim())
  }
  if (fence !== null) out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`)
  endPara(); endList()
  into.innerHTML = out.join('\n')
}

function diff(text, into) {
  into.replaceChildren(...text.split('\n').map(l => el('span', { className: l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : '', textContent: `${l}\n` })))
  into.hidden = false
}

// ---- Signing in

function showSignIn() {
  $('#app').hidden = true
  $('#me').hidden = true
  $('#sign-in').hidden = false
}

async function signIn(token) {
  const res = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })
  const body = await res.json()
  if (!body.ok) throw new Error(body.error)
}

$('#sign-in').addEventListener('submit', async e => {
  e.preventDefault()
  const err = $('#sign-in .error')
  try { await signIn($('#token').value.trim()); $('#token').value = ''; err.textContent = ''; await start() }
  catch (x) { err.textContent = x.message }
})

$('#sign-out').addEventListener('click', async () => {
  await fetch('/api/session', { method: 'DELETE' })
  location.reload()
})

// ---- The room

async function loadDocuments() {
  const { documents, drafts = [], room } = await act('list_documents')
  $('#room').textContent = room
  document.title = room
  $('#no-docs').hidden = documents.length > 0
  $('#documents').replaceChildren(...documents.map(d => el('li', {},
    el('button', { type: 'button', className: 'doc' + (current?.document === d.slug ? ' on' : ''), onclick: () => openDocument(d.slug) },
      el('span', { className: 't', textContent: d.title }),
      el('span', { className: 'm', textContent: `Version ${d.version} · ${day(d.published_at)}${d.added_by_side === 'reader' ? ` · from ${d.added_by}` : ''}` }),
      d.note ? el('span', { className: 'm note', textContent: d.note }) : null))))
  // Rebuilt on every refresh, so keep whatever the writer had picked.
  const pick = $('#add-doc')
  const picked = pick.value
  pick.replaceChildren(pick.options[0], ...documents.map(d => el('option', { value: d.slug, textContent: d.title, selected: d.slug === picked })))

  if (me.side === 'writer') {
    $('#drafts').replaceChildren(...drafts.map(d => el('li', {},
      el('p', {}, el('strong', { textContent: `Draft of ${d.title}` }), ` from ${d.added_by}${d.added_by_kind === 'agent' ? ' (agent)' : ''}${d.note ? `: ${d.note}` : ''}`),
      el('button', { type: 'button', className: 'primary', textContent: 'Read and publish', onclick: () => openDraft(d.draft) }))))
  }
  return documents
}

// Replies this browser has already shown, so a new one is pointed out once. Only a convenience: without storage, it just isn't.
const SEEN = 'seen-replies'
const seenReplies = () => { try { return new Set(JSON.parse(localStorage.getItem(SEEN) ?? '[]')) } catch { return new Set() } }
const saveSeen = ids => { try { localStorage.setItem(SEEN, JSON.stringify([...ids])) } catch {} }
// Stay marked until the page is reloaded, not just until the next refresh.
const newThisVisit = new Set()

async function loadQuestions() {
  const { questions } = await act('list_questions', { show: me.side === 'writer' ? 'open' : 'all' })
  if (me.side === 'writer') {
    // This also runs on a timer, so keep any reply that's half typed.
    const typed = new Map([...$('#open-questions').querySelectorAll('textarea')].map(t => [t.dataset.q, t.value]))
    const done = [...$('#open-questions').querySelectorAll('li.replied')]
    $('#open-questions').replaceChildren(...questions.map(q => {
      const box = el('textarea', { rows: 2, maxLength: 4000, placeholder: 'Reply…', value: typed.get(String(q.id)) ?? '' })
      box.dataset.q = q.id
      const item = el('li', {},
        el('p', {}, el('strong', { textContent: `${q.asked_by} asked: ` }), q.question),
        el('p', { className: 'hint', textContent: q.state === 'partly' ? `Answered in part. Not covered: ${q.missing}` : "The documents don't answer this." }),
        box)
      const send = el('button', { type: 'button', textContent: 'Reply', onclick: async () => {
        send.disabled = true
        try {
          const r = await act('reply_to_question', { question: q.id, reply: box.value })
          // Say so where they clicked. It goes at the next refresh.
          item.className = 'replied'
          item.replaceChildren(el('p', { className: 'hint', textContent: `Replied to ${q.asked_by}. They'll see it with their question.` }))
          status(r.message)
        } catch (x) { status(x.message); send.disabled = false }
      } })
      item.append(send)
      return item
    }), ...done.slice(-3))
  } else {
    const seen = seenReplies()
    const fresh = questions.filter(q => q.reply && !seen.has(q.id))
    for (const q of fresh) newThisVisit.add(q.id)
    $('#answers').replaceChildren(...questions.map(q => {
      const card = answerCard(q)
      if (newThisVisit.has(q.id)) card.classList.add('new')
      if (fresh.includes(q)) card.classList.add('flash')
      return card
    }))
    if (fresh.length) {
      status(fresh.length === 1 ? `${fresh[0].replied_by} replied to "${fresh[0].question}"` : `${fresh.length} new replies to your questions`)
      for (const q of questions) if (q.reply) seen.add(q.id)
      saveSeen(seen)
    }
  }
}

async function refreshWaiting() {
  await Promise.all([loadDocuments(), loadQuestions()])
  if (me.side === 'writer') $('#waiting').hidden = !$('#drafts').children.length && !$('#open-questions').children.length
}

// Replies, questions and new versions come from the other side, so look again now and then while the page is open,
// and straight away when someone comes back to the tab. A failed check stays quiet: the next one will try again.
const REFRESH_MS = 60_000
let refreshing = false
async function refreshQuietly() {
  if (!me || refreshing || document.hidden) return
  refreshing = true
  try { await refreshWaiting() } catch {} finally { refreshing = false }
}
setInterval(refreshQuietly, REFRESH_MS)
document.addEventListener('visibilitychange', refreshQuietly)

function answerCard(a) {
  const cites = (a.cites ?? []).map(c => el('button', {
    type: 'button', className: 'cite',
    textContent: `${c.title} v${c.version}, ${day(c.published_at)} › ${c.heading.split(' › ').at(-1)}`,
    onclick: () => openDocument(c.document, c.version, c.anchor),
  }))
  const said = a.state === 'answered' || a.state === 'partly'
  return el('li', { className: `answer ${a.state}` },
    el('p', { className: 'q', textContent: a.question }),
    said ? el('p', { textContent: a.answer }) : el('p', { className: 'none', textContent: a.reply ? "The documents don't answer this." : "The documents don't answer this yet. It's been passed on." }),
    a.state === 'partly' ? el('p', { className: 'none', textContent: `Not covered: ${a.missing}` }) : null,
    cites.length ? el('p', { className: 'cites' }, 'From ', ...cites) : null,
    a.reply ? el('p', { className: 'reply' }, el('strong', { textContent: `${a.replied_by} replied: ` }), a.reply) : null)
}

$('#ask').addEventListener('submit', async e => {
  e.preventDefault()
  const question = $('#question').value.trim()
  const button = $('#ask button')
  button.disabled = true
  status('Reading the documents…')
  try {
    const r = await act('ask', { question })
    status(r.message)
    $('#question').value = ''
    $('#answers').prepend(answerCard({ ...r, question }))
  } catch (x) { status(x.message) }
  finally { button.disabled = false }
})

async function openDocument(slug, version, anchor) {
  try {
    const [doc, { versions }] = await Promise.all([act('read_document', { document: slug, ...(version ? { version } : {}) }), act('list_versions', { document: slug })])
    current = { document: slug, version: doc.version }
    $('#reader').hidden = false
    $('#doc-title').textContent = doc.title
    $('#doc-meta').textContent = `Version ${doc.version} of ${versions.length}, published ${day(doc.published_at)} by ${doc.added_by}${doc.note ? `. ${doc.note}` : ''}`
    $('#doc-version').replaceChildren(...versions.slice().reverse().map(v => el('option', { value: v.version, textContent: `Version ${v.version}, ${day(v.published_at)}`, selected: v.version === doc.version })))
    $('#doc-changes').hidden = doc.version === 1
    $('#doc-diff').hidden = true
    markdown(doc.markdown, $('#doc-body'))
    await loadDocuments()
    const target = anchor && document.getElementById(`s-${anchor}`)
    if (target) { target.scrollIntoView({ block: 'start' }); target.classList.add('flash') }
    else $('#reader').scrollIntoView({ block: 'start' })
  } catch (x) { status(x.message) }
}

$('#doc-version').addEventListener('change', e => openDocument(current.document, Number(e.target.value)))
$('#doc-changes').addEventListener('click', async () => {
  try {
    const c = await act('compare_versions', { document: current.document, from: current.version - 1, to: current.version })
    status(c.message)
    diff(c.diff, $('#doc-diff'))
  } catch (x) { status(x.message) }
})

// ---- Writers: drafts in, read, published

$('#add').addEventListener('submit', async e => {
  e.preventDefault()
  const err = $('#add .error')
  const button = $('#add button[type=submit]')
  button.disabled = true
  err.textContent = ''
  status('Turning it into Markdown…')
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: new FormData(e.target) })
    const body = await res.json()
    if (!body.ok) throw new Error(body.error)
    status(body.message)
    e.target.reset()
    await refreshWaiting()
    openDraft(body.draft)
  } catch (x) { err.textContent = x.message; status('') }
  finally { button.disabled = false }
})

let openDraftId = null
async function openDraft(id) {
  try {
    const d = await act('get_draft', { draft: id })
    openDraftId = id
    $('#draft-title').textContent = `Draft of ${d.title}`
    $('#draft-meta').textContent = `Added by ${d.added_by}${d.source ? ` from ${d.source}` : ''}. ${d.replaces ? `Replaces version ${d.replaces.version} of ${day(d.replaces.published_at)}.` : 'A new document.'}${d.note ? ` What changed: ${d.note}` : ''}`
    if (d.diff) diff(d.diff, $('#draft-diff')); else $('#draft-diff').hidden = true
    markdown(d.markdown, $('#draft-body'))
    $('#draft .error').textContent = ''
    $('#draft').showModal()
  } catch (x) { status(x.message) }
}

for (const [button, name] of [['#publish', 'publish_draft'], ['#discard', 'discard_draft']]) {
  $(button).addEventListener('click', async () => {
    try {
      const r = await act(name, { draft: openDraftId })
      status(r.message)
      $('#draft').close()
      await refreshWaiting()
      if (r.document) openDocument(r.document)
    } catch (x) { $('#draft .error').textContent = x.message }
  })
}

// ---- Writers: sharing the room

function resetShare() {
  $('#share-form').reset()
  $('#share-form .error').textContent = ''
  $('#share-form').hidden = false
  $('#share-done').hidden = true
  // The link is shown once, so it doesn't stay in the page after the dialog closes.
  $('#share-link').value = ''
  $('#share-mcp').textContent = ''
}

$('#share-open').addEventListener('click', () => { resetShare(); $('#share').showModal(); $('#share-name').focus() })
$('#share-close').addEventListener('click', () => $('#share').close())
$('#share').addEventListener('close', resetShare)
$('#share-again').addEventListener('click', () => { resetShare(); $('#share-name').focus() })

$('#share-form').addEventListener('submit', async e => {
  e.preventDefault()
  const button = $('#share-form button[type=submit]')
  button.disabled = true
  try {
    const form = new FormData(e.target)
    const r = await act('share', { name: form.get('name').trim(), access: form.get('access') })
    $('#share-message').textContent = r.message
    $('#share-link').value = r.link
    $('#share-mcp').textContent = r.mcp
    $('#share-form').hidden = true
    $('#share-done').hidden = false
    $('#share-link').select()
  } catch (x) { $('#share-form .error').textContent = x.message }
  finally { button.disabled = false }
})

$('#share-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#share-link').value); $('#share-copy').textContent = 'Copied' }
  catch { $('#share-link').select(); $('#share-copy').textContent = 'Press Ctrl+C' }
  setTimeout(() => { $('#share-copy').textContent = 'Copy' }, 2000)
})

// ---- Start

async function start() {
  const res = await fetch('/api/me')
  if (!res.ok) return showSignIn()
  const body = await res.json()
  me = body.you
  $('#me-name').textContent = `${me.name}, ${me.side === 'writer' ? 'writing' : 'reading'}`
  $('#me').hidden = false
  $('#sign-in').hidden = true
  $('#app').hidden = false
  $('#add').hidden = me.side !== 'writer'
  $('#share-item').hidden = !(me.side === 'writer' && me.kind === 'person')
  $('#mcp-command').textContent = `claude mcp add --transport http room ${location.origin}/mcp --header "Authorization: Bearer <your token>"`
  const docs = await loadDocuments()
  await refreshWaiting()
  if (docs[0]) openDocument(docs[0].slug)
}

// A shared link carries the token after #, which never reaches a server log. Swap it for the cookie, then drop it from the address bar.
const fromLink = new URLSearchParams(location.hash.slice(1)).get('t')
if (fromLink) {
  history.replaceState(null, '', location.pathname)
  signIn(fromLink).then(start, x => { showSignIn(); $('#sign-in .error').textContent = x.message })
} else start()
