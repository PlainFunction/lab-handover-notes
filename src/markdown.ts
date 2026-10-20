// Everything in the room is Markdown. These turn it into sections for search
// and compare two versions line by line. No parser: headings and code fences
// are all we need to find.

/** Bigger than any handover notes, update or explainer we tried, and well under D1's row limit. */
export const MAX_MARKDOWN = 200_000
/** Long sections are split so one search hit doesn't fill the model's context. */
const MAX_SECTION = 3_000

export interface Section { heading: string; anchor: string; body: string }

export function normalise(markdown: string): string {
  return markdown.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

/** Lowercase words joined by hyphens, as most Markdown renderers make heading ids. */
export const anchorFor = (heading: string) =>
  heading.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-') || 'top'

/**
 * Splits at #, ## and ### headings outside code fences. Each section's heading
 * is its path ("Traction › Revenue"), so a search hit says where it sits.
 */
export function sections(markdown: string): Section[] {
  const out: Section[] = []
  const path: string[] = []
  const used = new Map<string, number>()
  let lines: string[] = []
  let heading = ''
  let anchor = 'top'
  let fence = ''

  const flush = () => {
    const body = lines.join('\n').trim()
    lines = []
    // A heading with nothing under it lives on in its children's paths.
    if (!body) return
    for (let i = 0, part = 0; i < Math.max(body.length, 1); i += MAX_SECTION, part++) {
      out.push({ heading: heading + (part ? ` (part ${part + 1})` : ''), anchor, body: body.slice(i, i + MAX_SECTION) })
    }
  }

  for (const line of markdown.split('\n')) {
    const f = /^(```|~~~)/.exec(line)?.[1]
    if (f && (!fence || f === fence)) fence = fence ? '' : f
    const h = fence ? null : /^(#{1,3})\s+(.+?)\s*#*$/.exec(line)
    if (!h) { lines.push(line); continue }
    flush()
    const depth = h[1].length
    path.length = depth - 1
    path[depth - 1] = h[2]
    heading = path.filter(Boolean).join(' › ')
    // Repeated headings get -1, -2 like GitHub, so every anchor points at one place.
    const base = anchorFor(h[2])
    const n = used.get(base) ?? 0
    used.set(base, n + 1)
    anchor = n ? `${base}-${n}` : base
  }
  flush()
  return out
}

/**
 * Workers AI's toMarkdown starts a PDF with the file name and a "Metadata"
 * list (producer, creation date and so on). That's noise in handover notes, so it goes.
 */
export function tidyConverted(markdown: string): string {
  return markdown.replace(/^## Metadata\n(?:- .*\n?)*/m, '').replace(/^## Contents\n/m, '')
}

export interface DiffLine { op: ' ' | '+' | '-'; text: string }

/**
 * Line diff by longest common subsequence. Fine for documents of a few
 * thousand lines; anything bigger gets a plain "too long to compare".
 */
export function diffLines(a: string, b: string, context = 2): DiffLine[] | null {
  const x = a.split('\n')
  const y = b.split('\n')
  if (x.length * y.length > 4_000_000) return null
  const n = x.length
  const m = y.length
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  }
  const all: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { all.push({ op: ' ', text: x[i] }); i++; j++ }
    // Removals before additions, so a changed line reads old then new.
    else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) all.push({ op: '-', text: x[i++] })
    else all.push({ op: '+', text: y[j++] })
  }
  // Keep a few unchanged lines around each change, and mark the gaps.
  const keep = all.map((l, k) => l.op !== ' ' || all.slice(Math.max(0, k - context), k + context + 1).some(c => c.op !== ' '))
  const out: DiffLine[] = []
  keep.forEach((k, idx) => {
    if (k) out.push(all[idx])
    else if (keep[idx - 1] !== false) out.push({ op: ' ', text: '…' })
  })
  if (out.at(-1)?.text === '…') out.pop()
  return out
}
