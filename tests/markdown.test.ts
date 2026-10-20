import { describe, expect, it } from 'vitest'
import { diffLines, normalise, sections, tidyConverted } from '../src/markdown'

describe('sections', () => {
  it('splits at headings and keeps the path', () => {
    const s = sections('# Build notes\nIntro\n\n## Done\nGmail\n\n### This week\nDrafts\n\n## Next\nGo live\n')
    expect(s.map(x => [x.heading, x.anchor, x.body])).toEqual([
      ['Build notes', 'build-notes', 'Intro'],
      ['Build notes › Done', 'done', 'Gmail'],
      ['Build notes › Done › This week', 'this-week', 'Drafts'],
      ['Build notes › Next', 'next', 'Go live'],
    ])
  })

  it('ignores headings inside code fences', () => {
    const s = sections('## Setup\n```bash\n# not a heading\nnpm i\n```\n')
    expect(s).toHaveLength(1)
    expect(s[0].body).toContain('# not a heading')
  })

  it('gives repeated headings their own anchors', () => {
    expect(sections('## Notes\na\n## Notes\nb\n').map(x => x.anchor)).toEqual(['notes', 'notes-1'])
  })

  it('keeps text before the first heading, and splits long sections', () => {
    const s = sections(`Before\n\n## Long\n${'x'.repeat(7000)}`)
    expect(s[0]).toMatchObject({ heading: '', body: 'Before' })
    expect(s.slice(1).map(x => x.heading)).toEqual(['Long', 'Long (part 2)', 'Long (part 3)'])
  })
})

describe('normalise and tidyConverted', () => {
  it('evens out line endings and blank lines', () => {
    expect(normalise('a  \r\n\r\n\r\n\r\nb')).toBe('a\n\nb\n')
  })

  it("drops the metadata toMarkdown puts at the top of a PDF", () => {
    const pdf = '# packages.pdf\n## Metadata\n- PDFFormatVersion=1.7\n- Producer=Canva\n## Contents\n### Page 1\nSaltwater\n'
    expect(tidyConverted(pdf)).toBe('# packages.pdf\n### Page 1\nSaltwater\n')
  })
})

describe('diffLines', () => {
  it('shows what was added and removed, with a little context', () => {
    const a = ['# T', 'one', 'two', 'three', 'four', 'five', 'six', 'Live on 7 October'].join('\n')
    const b = ['# T', 'one', 'two', 'three', 'four', 'five', 'six', 'Live on 14 October'].join('\n')
    expect(diffLines(a, b)).toEqual([
      { op: ' ', text: '…' },
      { op: ' ', text: 'five' },
      { op: ' ', text: 'six' },
      { op: '-', text: 'Live on 7 October' },
      { op: '+', text: 'Live on 14 October' },
    ])
  })

  it('is empty when nothing changed', () => {
    expect(diffLines('a\nb', 'a\nb')).toEqual([])
  })
})
