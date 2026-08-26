import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it, jest } from '@jest/globals'

import {
  actionVerb,
  createCrowdinClient,
  createLanguageIds,
  findHeadingSources,
  findReadmeStrings,
  localizedReadme,
  main,
  run,
  runIfMain,
  synchronizeTranslation
} from '../scripts/sync-readme-navigation-crowdin.mjs'

const branchName = '[LizardByte.awesome-sunshine] master'
const navigationContext = 'CXPath: //html[2]/root/div[0][0]'

function response (...items) {
  return { data: items.map(data => ({ data })) }
}

function createCrowdin ({ approvals = {}, languages = [], translations = {} } = {}) {
  const navigation = '\n[\n  <a href="#-clients">Clients</a>\n]\n'
  const sourceStrings = [
    { id: 10, isHidden: false, text: '📺 Clients' },
    { context: navigationContext, id: 20, text: navigation }
  ]
  const api = {
    addApproval: jest.fn(async () => {}),
    addTranslation: jest.fn(async (_project, target) => ({ data: { id: 99, text: target.text } })),
    listStringTranslations: jest.fn(async (_project, stringId) => response(...(translations[stringId] ?? []))),
    listTranslationApprovals: jest.fn(async (_project, options) => response(...(approvals[options.stringId] ?? []))),
    removeApproval: jest.fn(async () => {}),
    withFetchAll () { return this }
  }

  return {
    api,
    crowdin: {
      projectsGroupsApi: {
        getProject: jest.fn(async () => ({ data: { targetLanguages: languages } }))
      },
      sourceFilesApi: {
        withFetchAll () { return this },
        listProjectBranches: jest.fn(async () => response({ id: 1, name: branchName })),
        listProjectFiles: jest.fn(async () => response({ id: 2, name: 'README.md' }))
      },
      sourceStringsApi: {
        withFetchAll () { return this },
        listProjectStrings: jest.fn(async () => response(...sourceStrings))
      },
      stringTranslationsApi: api
    },
    navigation
  }
}

describe('Crowdin README synchronization', () => {
  const directories = []

  afterEach(() => {
    jest.restoreAllMocks()
    process.exitCode = 0
    for (const directory of directories) fs.rmSync(directory, { force: true, recursive: true })
    directories.length = 0
  })

  function temporaryDirectory () {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awesome-sunshine-'))
    directories.push(directory)
    return directory
  }

  it('maps exact and two-letter Crowdin language IDs', () => {
    const ids = createLanguageIds(['en_US', 'fr'], [
      { id: 'en-US', twoLettersCode: 'en' },
      { id: 'fr-FR', twoLettersCode: 'fr' }
    ])
    expect([...ids]).toEqual([['en_US', 'en-US'], ['fr', 'fr-FR']])
    expect(() => createLanguageIds(['zz'], [])).toThrow(
      'Expected one Crowdin target language for locale/zz, found 0'
    )
  })

  it('rejects missing, duplicate, and empty heading sources', () => {
    expect(() => findHeadingSources([], { text: 'plain text' })).toThrow(
      'navigation source string has no links'
    )
    const navigation = { text: '<a href="#-clients">Clients</a>' }
    expect(() => findHeadingSources([], navigation)).toThrow(
      'Expected one README heading source string for Clients, found 0'
    )
    expect(() => findHeadingSources([
      { isHidden: false, text: '📺 Clients' },
      { isHidden: false, text: '🎮 Clients' }
    ], navigation)).toThrow(
      'Expected one README heading source string for Clients, found 2'
    )
  })

  it('retrieves the README source strings and canonical headings', async () => {
    const { crowdin } = createCrowdin()
    const result = await findReadmeStrings(crowdin)
    expect(result.canonicalHeadings).toEqual([{ emoji: '📺', text: 'Clients' }])
    expect(result.headings.map(heading => heading.id)).toEqual([10])
    expect(result.navigation.id).toBe(20)
  })

  it('builds a localized README target and validates its path and language', () => {
    const localeRoot = temporaryDirectory()
    const localeDirectory = path.join(localeRoot, 'fr')
    fs.mkdirSync(localeDirectory)
    const file = path.join(localeDirectory, 'README.md')
    fs.writeFileSync(file, '## 📺 Clients\n## Contribuer\n')
    const canonical = [{ emoji: '📺', text: 'Clients' }]
    const target = localizedReadme(localeRoot, file, canonical, new Map([['fr', 'fr']]))
    expect(target).toMatchObject({
      file: 'locale/fr/README.md',
      headings: ['📺 Clients'],
      languageId: 'fr'
    })

    expect(() => localizedReadme(localeRoot, path.join(localeRoot, 'README.md'), canonical, new Map())).toThrow(
      'Unexpected localized README path'
    )
    expect(() => localizedReadme(localeRoot, file, canonical, new Map())).toThrow(
      'No Crowdin language mapping for locale/fr'
    )
  })

  it('returns no actions for an already approved exact translation', async () => {
    const { api, crowdin } = createCrowdin({
      approvals: { 10: [{ id: 2, translationId: 1 }] },
      translations: { 10: [{ id: 1, text: 'expected' }] }
    })
    await expect(synchronizeTranslation(
      crowdin,
      10,
      { expected: 'expected', languageId: 'fr' },
      false
    )).resolves.toEqual([])
    expect(api.addApproval).not.toHaveBeenCalled()
  })

  it('describes dry-run translation, approval, and stale-approval actions', async () => {
    const { api, crowdin } = createCrowdin({ approvals: { 10: [{ id: 2, translationId: 1 }] } })
    await expect(synchronizeTranslation(
      crowdin,
      10,
      { expected: 'expected', languageId: 'fr' },
      true
    )).resolves.toEqual([
      'remove 1 stale approval',
      'add translation',
      'approve translation'
    ])
    expect(api.addTranslation).not.toHaveBeenCalled()
  })

  it('creates a translation and replaces stale approvals', async () => {
    const { api, crowdin } = createCrowdin({
      approvals: { 10: [{ id: 2, translationId: 1 }, { id: 3, translationId: 2 }] }
    })
    await expect(synchronizeTranslation(
      crowdin,
      10,
      { expected: 'expected', languageId: 'fr' },
      false
    )).resolves.toEqual([
      'remove 2 stale approvals',
      'add translation',
      'approve translation'
    ])
    expect(api.addTranslation).toHaveBeenCalledTimes(1)
    expect(api.removeApproval).toHaveBeenCalledTimes(2)
    expect(api.addApproval).toHaveBeenCalledWith(606145, { translationId: 99 })
  })

  it('approves an exact translation and removes only stale approvals', async () => {
    const unapproved = createCrowdin({ translations: { 10: [{ id: 4, text: 'expected' }] } })
    await expect(synchronizeTranslation(
      unapproved.crowdin,
      10,
      { expected: 'expected', languageId: 'fr' },
      false
    )).resolves.toEqual(['approve translation'])
    expect(unapproved.api.addApproval).toHaveBeenCalledWith(606145, { translationId: 4 })

    const stale = createCrowdin({
      approvals: { 10: [{ id: 5, translationId: 4 }, { id: 6, translationId: 7 }] },
      translations: { 10: [{ id: 4, text: 'expected' }] }
    })
    await expect(synchronizeTranslation(
      stale.crowdin,
      10,
      { expected: 'expected', languageId: 'fr' },
      false
    )).resolves.toEqual(['remove 1 stale approval'])
    expect(stale.api.addApproval).not.toHaveBeenCalled()
    expect(stale.api.removeApproval).toHaveBeenCalledWith(606145, 6)
  })

  it('selects the correct action verbs', () => {
    expect(actionVerb([], false)).toBe('Checked')
    expect(actionVerb(['change'], true)).toBe('Would update')
    expect(actionVerb(['change'], false)).toBe('Updated')
    expect(createCrowdinClient('test-token')).toBeDefined()
  })

  it('runs a complete localized dry run', async () => {
    const root = temporaryDirectory()
    for (const locale of ['fr', 'de']) {
      const localeDirectory = path.join(root, 'locale', locale)
      fs.mkdirSync(localeDirectory, { recursive: true })
      fs.writeFileSync(path.join(localeDirectory, 'README.md'), '## 📺 Clients\n## Contribute\n')
    }
    const approvals = {}
    const translations = {}
    const { crowdin, navigation } = createCrowdin({
      approvals,
      languages: [
        { id: 'fr', twoLettersCode: 'fr' },
        { id: 'de', twoLettersCode: 'de' }
      ],
      translations
    })
    jest.spyOn(console, 'log').mockImplementation(() => {})

    await main({ clientFactory: () => crowdin, dryRun: true, root, token: 'test-token' })
    expect(console.log).toHaveBeenCalledWith(
      'Checked 2 localized README heading and navigation translations.'
    )

    translations[10] = [{ id: 1, text: '📺 Clients' }]
    translations[20] = [{ id: 2, text: navigation }]
    approvals[10] = [{ id: 3, translationId: 1 }]
    approvals[20] = [{ id: 4, translationId: 2 }]
    await main({ crowdin, dryRun: false, root, token: 'test-token' })
    expect(console.log).toHaveBeenCalledWith(
      'Synchronized 2 localized README heading and navigation translations.'
    )
    expect(console.log).toHaveBeenCalledWith(
      'Checked locale/de/README.md heading 1: already correct and approved'
    )
  })

  it('rejects missing credentials and an empty locale directory', async () => {
    await expect(main({ token: '' })).rejects.toThrow('CROWDIN_TOKEN is required')
    const root = temporaryDirectory()
    fs.mkdirSync(path.join(root, 'locale'))
    const { crowdin } = createCrowdin()
    await expect(main({ crowdin, root, token: 'test-token' })).rejects.toThrow(
      'No localized README files were found'
    )
  })

  it('rejects inconsistent Crowdin source navigation and heading counts', async () => {
    const { crowdin } = createCrowdin()
    const findStrings = jest.fn(async () => ({
      canonicalHeadings: [],
      headings: [],
      navigation: { text: '<a href="#-clients">Clients</a>' }
    }))
    await expect(main({ crowdin, findStrings, token: 'test-token' })).rejects.toThrow(
      'Crowdin README navigation source has 1 links; expected 0'
    )
  })

  it('handles top-level failures without rejecting', async () => {
    const originalToken = process.env.CROWDIN_TOKEN
    jest.spyOn(console, 'error').mockImplementation(() => {})
    delete process.env.CROWDIN_TOKEN
    try {
      await run()
      await run(async () => {})
      await run(async () => { throw new Error('failure') })
      expect(console.error).toHaveBeenCalledWith(expect.objectContaining({ message: 'failure' }))
      expect(process.exitCode).toBe(1)
    } finally {
      if (originalToken === undefined) delete process.env.CROWDIN_TOKEN
      else process.env.CROWDIN_TOKEN = originalToken
    }
  })

  it('runs synchronization only for its command-line entry point', () => {
    const entryPoint = path.join(temporaryDirectory(), 'sync.mjs')
    const runFunction = jest.fn()
    runIfMain(pathToFileURL(entryPoint), entryPoint, runFunction)
    runIfMain(pathToFileURL(entryPoint), '', runFunction)
    expect(runFunction).toHaveBeenCalledTimes(1)
  })
})
