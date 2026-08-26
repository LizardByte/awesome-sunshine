import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it, jest } from '@jest/globals'

import {
  createHeadingTranslations,
  createNavigationTranslation,
  findLocalizedReadmes,
  main,
  parseCanonicalHeadings,
  parseNavigationLinks,
  runIfMain,
  validateReadme
} from '../scripts/validate-readme-navigation.mjs'
import { findHeadingSources } from '../scripts/sync-readme-navigation-crowdin.mjs'

describe('README heading and navigation synchronization', () => {
  const directories = []

  afterEach(() => {
    jest.restoreAllMocks()
    process.exitCode = 0
    for (const directory of directories) {
      fs.rmSync(directory, { force: true, recursive: true })
    }
    directories.length = 0
  })

  function temporaryDirectory () {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awesome-sunshine-'))
    directories.push(directory)
    return directory
  }

  function temporaryReadme (lines) {
    const file = path.join(temporaryDirectory(), 'README.md')
    fs.writeFileSync(file, lines.join('\n'))
    return file
  }

  it('finds localized READMEs recursively and ignores other files', () => {
    const directory = temporaryDirectory()
    const nested = path.join(directory, 'fr', 'nested')
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(directory, 'fr', 'README.md'), '')
    fs.writeFileSync(path.join(nested, 'README.md'), '')
    fs.writeFileSync(path.join(nested, 'notes.md'), '')

    expect(findLocalizedReadmes(path.join(directory, 'missing'))).toEqual([])
    expect(findLocalizedReadmes(directory).sort()).toEqual([
      path.join(directory, 'fr', 'README.md'),
      path.join(nested, 'README.md')
    ].sort())
  })

  it('parses canonical headings and HTML entities', () => {
    expect(parseCanonicalHeadings([
      'not a heading',
      '# 📺 Wrong level',
      '## No emoji',
      '## 📺 **Clients &amp; &#67;&#x44;** ###'
    ])).toEqual([
      { emoji: '📺', text: 'Clients & CD' }
    ])
    expect(parseNavigationLinks([
      'plain text',
      '  <a href="#symbols">&lt;&gt;&quot;&apos;&amp;</a>'
    ])).toEqual([
      { href: '#symbols', line: 2, text: `<>"'&` }
    ])
    expect(parseNavigationLinks([
      '<a href="#before">Before</a>',
      '## 📺 Clients',
      '<a href="#after">After</a>'
    ])).toEqual([
      { href: '#before', line: 1, text: 'Before' }
    ])
  })

  it('derives the current headings and emojis from Crowdin source navigation', () => {
    const headings = findHeadingSources([
      { id: 1, isHidden: true, text: '🎮 Game Stores' },
      { id: 2, isHidden: false, text: '🛒 Game Stores' },
      { id: 3, isHidden: false, text: '🎮 Virtual Gamepads' }
    ], {
      text: [
        '',
        '[',
        '  <a href="#-game-stores">Game Stores</a> •',
        '  <a href="#-virtual-gamepads">Virtual Gamepads</a>',
        ']',
        ''
      ].join('\n')
    })

    expect(headings.map(heading => heading.source.id)).toEqual([2, 3])
    expect(headings.map(heading => heading.canonical.emoji)).toEqual(['🛒', '🎮'])
  })

  it('supports a new section and repairs localized emojis', () => {
    const canonicalHeadings = parseCanonicalHeadings([
      '## 📺 Clients',
      '## 🛒 Game Stores',
      '## 🎮 Virtual Gamepads',
      '## 📜 Scripts',
      '## Contribute'
    ])
    const localizedFile = temporaryReadme([
      '[',
      '  <a href="#-clients">Clients</a> •',
      '  <a href="#-magasins-de-jeux">Magasins de jeux</a> •',
      '  <a href="#-manettes-virtuelles">Manettes virtuelles</a> •',
      '  <a href="#-scripts">Scripts</a>',
      ']',
      '',
      '## 📺 Clients',
      '## 🎮 Magasins de jeux',
      '## Manettes virtuelles',
      '## 📜 Scripts',
      '## Contribuer'
    ])

    expect(createHeadingTranslations(localizedFile, canonicalHeadings)).toEqual([
      '📺 Clients',
      '🛒 Magasins de jeux',
      '🎮 Manettes virtuelles',
      '📜 Scripts'
    ])
    expect(createNavigationTranslation(localizedFile, canonicalHeadings)).toBe([
      '',
      '[',
      '  <a href="#-clients">Clients</a> •',
      '  <a href="#-magasins-de-jeux">Magasins de jeux</a> •',
      '  <a href="#-manettes-virtuelles">Manettes virtuelles</a> •',
      '  <a href="#-scripts">Scripts</a>',
      ']',
      ''
    ].join('\n'))
  })

  it('rejects a missing localized section instead of consuming the final section', () => {
    const canonicalHeadings = parseCanonicalHeadings([
      '## 📺 Clients',
      '## 🎮 Virtual Gamepads',
      '## Contribute'
    ])
    const localizedFile = temporaryReadme([
      '## 📺 Clients',
      '## Contribuer'
    ])

    expect(() => createNavigationTranslation(localizedFile, canonicalHeadings)).toThrow(
      'fewer than 2 navigation headings plus its final section'
    )
  })

  it('rejects malformed localized headings that pass the coarse section count', () => {
    const canonicalHeadings = parseCanonicalHeadings([
      '## 📺 Clients',
      '## 🎮 Virtual Gamepads',
      '## 📜 Scripts'
    ])
    const localizedFile = temporaryReadme([
      '## 📺 Clients',
      '## ',
      '## Contribuer',
      '## '
    ])

    expect(() => createNavigationTranslation(localizedFile, canonicalHeadings)).toThrow(
      'has 2 navigation headings; expected 3'
    )
  })

  it.each([
    {
      issue: 'Extra navigation link',
      lines: [
        '<a href="#-clients">Clients</a>',
        '<a href="#extra">Extra</a>',
        '## 📺 Clients'
      ]
    },
    { issue: 'Missing navigation link', lines: ['## 📺 Clients'] },
    { issue: 'Incorrect anchor', lines: ['<a href="#wrong">Clients</a>', '## 📺 Clients'] },
    { issue: 'Incorrect visible text', lines: ['<a href="#-clients">Wrong</a>', '## 📺 Clients'] },
    {
      issue: 'Incorrect anchor and visible text',
      lines: ['<a href="#%E0">Wrong</a>', '## 📺 Clients']
    }
  ])('reports $issue', ({ issue, lines }) => {
    const issues = validateReadme(temporaryReadme(lines))
    expect(issues.map(result => result.issue)).toContain(issue)
  })

  it('accepts matching navigation and headings', () => {
    expect(validateReadme(temporaryReadme([
      '<a href="#-clients">Clients</a>',
      '## 📺 Clients'
    ]))).toEqual([])
  })

  it('renders success and failure summaries and writes the requested summary file', () => {
    const valid = temporaryReadme([
      '<a href="#-clients">Clients</a>',
      '## 📺 Clients'
    ])
    const invalid = temporaryReadme([
      '<a href="#wrong">Wrong &amp; |</a>',
      '## 📺 Right | <em>Name</em>'
    ])
    const secondInvalid = temporaryReadme(['## 📺 Missing'])
    const summaryFile = path.join(temporaryDirectory(), 'summary.md')
    jest.spyOn(console, 'log').mockImplementation(() => {})
    jest.spyOn(console, 'error').mockImplementation(() => {})

    const success = main({ requestedFiles: [valid], summaryFile })
    expect(success.results).toHaveLength(0)
    expect(success.summary).toContain('✅ All 1 README navigation blocks')

    const failure = main({ requestedFiles: [invalid], summaryFile })
    expect(failure.results).toHaveLength(1)
    expect(failure.summary).toContain('❌ Found 1 navigation mismatch in 1 file')
    expect(failure.summary).toContain('&amp; &#124;')
    expect(process.exitCode).toBe(1)
    expect(fs.readFileSync(summaryFile, 'utf8')).toContain('README navigation validation')

    const pluralFailure = main({ requestedFiles: [invalid, secondInvalid], summaryFile: '' })
    expect(pluralFailure.summary).toContain('Found 2 navigation mismatches in 2 files')
  })

  it('validates the root and every localized README by default', () => {
    const originalArgv = process.argv
    const originalSummary = process.env.GITHUB_STEP_SUMMARY
    jest.spyOn(console, 'log').mockImplementation(() => {})
    process.argv = [originalArgv[0], originalArgv[1]]
    delete process.env.GITHUB_STEP_SUMMARY
    try {
      const result = main()
      expect(result.results).toHaveLength(0)
      expect(result.summary).toContain('All 22 README navigation blocks')
    } finally {
      process.argv = originalArgv
      if (originalSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY
      else process.env.GITHUB_STEP_SUMMARY = originalSummary
    }
  })

  it('runs the validator only for its command-line entry point', () => {
    const entryPoint = path.join(temporaryDirectory(), 'validator.mjs')
    const mainFunction = jest.fn()
    runIfMain(pathToFileURL(entryPoint), entryPoint, mainFunction)
    runIfMain(pathToFileURL(entryPoint), '', mainFunction)
    expect(mainFunction).toHaveBeenCalledTimes(1)
  })
})
