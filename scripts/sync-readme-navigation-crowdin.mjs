import path from 'node:path'
import process from 'node:process'

import { Client as CrowdinClient } from '@crowdin/crowdin-api-client'

import {
  createNavigationTranslation,
  findLocalizedReadmes,
  parseNavigationLinks
} from './validate-readme-navigation.mjs'

const PROJECT_ID = 606145
const BRANCH_NAME = '[LizardByte.awesome-sunshine] master'
const README_NAME = 'README.md'
const NAVIGATION_CONTEXT = 'CXPath: //html[2]/root/div[0][0]'

function data (response) {
  return response.data.map(item => item.data)
}

function findOne (items, description, predicate) {
  const matches = items.filter(predicate)

  if (matches.length !== 1) {
    throw new Error(`Expected one ${description}, found ${matches.length}`)
  }

  return matches[0]
}

function createLanguageIds (locales, targetLanguages) {
  const languageIds = new Map()
  const unassignedLanguages = new Map(targetLanguages.map(language => [language.id, language]))

  for (const locale of locales) {
    const exact = [...unassignedLanguages.values()].find(language => {
      return language.id.replaceAll('-', '_') === locale
    })

    if (exact) {
      languageIds.set(locale, exact.id)
      unassignedLanguages.delete(exact.id)
    }
  }

  for (const locale of locales) {
    if (languageIds.has(locale)) continue

    const language = findOne(
      [...unassignedLanguages.values()],
      `Crowdin target language for locale/${locale}`,
      item => item.twoLettersCode === locale
    )
    languageIds.set(locale, language.id)
    unassignedLanguages.delete(language.id)
  }

  return languageIds
}

async function findNavigationString (crowdin) {
  const branches = await crowdin.sourceFilesApi.withFetchAll()
    .listProjectBranches(PROJECT_ID)
  const branch = findOne(data(branches), `Crowdin branch named ${BRANCH_NAME}`, item => {
    return item.name === BRANCH_NAME
  })

  const files = await crowdin.sourceFilesApi.withFetchAll()
    .listProjectFiles(PROJECT_ID, { branchId: branch.id, recursion: 1 })
  const readme = findOne(data(files), `${BRANCH_NAME}/${README_NAME}`, item => {
    return item.name === README_NAME
  })

  const strings = await crowdin.sourceStringsApi.withFetchAll()
    .listProjectStrings(PROJECT_ID, { fileId: readme.id })

  return findOne(data(strings), `README navigation string with context ${NAVIGATION_CONTEXT}`, item => {
    return item.context === NAVIGATION_CONTEXT
  })
}

function localizedReadme (localeRoot, file, expectedHeadingCount, languageIds) {
  const relativeFile = path.relative(localeRoot, file)
  const parts = relativeFile.split(path.sep)

  if (parts.length !== 2 || parts[1] !== README_NAME) {
    throw new Error(`Unexpected localized README path: ${relativeFile}`)
  }

  const languageId = languageIds.get(parts[0])
  if (!languageId) throw new Error(`No Crowdin language mapping for locale/${parts[0]}`)

  return {
    expected: createNavigationTranslation(file, expectedHeadingCount),
    file: `locale/${parts.join('/')}`,
    languageId
  }
}

async function synchronizeTranslation (crowdin, stringId, target, dryRun) {
  const translationsApi = crowdin.stringTranslationsApi
  const [translationsResponse, approvalsResponse] = await Promise.all([
    translationsApi.withFetchAll()
      .listStringTranslations(PROJECT_ID, stringId, target.languageId),
    translationsApi.withFetchAll()
      .listTranslationApprovals(PROJECT_ID, {
        languageId: target.languageId,
        stringId
      })
  ])
  const translations = data(translationsResponse)
  const approvals = data(approvalsResponse)
  const approvedIds = new Set(approvals.map(approval => approval.translationId))
  const exactTranslations = translations.filter(translation => translation.text === target.expected)
  let translation = exactTranslations.find(item => approvedIds.has(item.id)) ?? exactTranslations[0]
  const staleApprovals = approvals.filter(approval => approval.translationId !== translation?.id)
  const needsTranslation = !translation
  const needsApproval = needsTranslation || !approvedIds.has(translation.id)
  const actions = []

  if (staleApprovals.length > 0) {
    actions.push(`remove ${staleApprovals.length} stale approval${staleApprovals.length === 1 ? '' : 's'}`)
  }
  if (needsTranslation) actions.push('add translation')
  if (needsApproval) actions.push('approve translation')

  if (dryRun || actions.length === 0) return actions

  if (needsTranslation) {
    const response = await translationsApi.addTranslation(PROJECT_ID, {
      languageId: target.languageId,
      stringId,
      text: target.expected
    })
    translation = response.data
  }

  for (const approval of staleApprovals) {
    await translationsApi.removeApproval(PROJECT_ID, approval.id)
  }

  if (needsApproval) {
    await translationsApi.addApproval(PROJECT_ID, { translationId: translation.id })
  }

  return actions
}

async function main () {
  const token = process.env.CROWDIN_TOKEN
  if (!token) throw new Error('CROWDIN_TOKEN is required')

  const dryRun = process.argv.includes('--dry-run')
  const root = process.cwd()
  const localeRoot = path.join(root, 'locale')
  const crowdin = new CrowdinClient({ token })
  const [projectResponse, navigationString] = await Promise.all([
    crowdin.projectsGroupsApi.getProject(PROJECT_ID),
    findNavigationString(crowdin)
  ])
  const expectedHeadingCount = parseNavigationLinks(navigationString.text.split(/\r?\n/)).length

  if (expectedHeadingCount === 0) {
    throw new Error('The Crowdin README navigation source string has no links')
  }

  const readmes = findLocalizedReadmes(localeRoot)
  const locales = readmes.map(file => path.relative(localeRoot, path.dirname(file)))
  const languageIds = createLanguageIds(locales, projectResponse.data.targetLanguages)
  const targets = readmes
    .map(file => localizedReadme(localeRoot, file, expectedHeadingCount, languageIds))
    .sort((left, right) => left.file.localeCompare(right.file, 'en'))

  if (targets.length === 0) throw new Error('No localized README files were found')

  for (const target of targets) {
    const actions = await synchronizeTranslation(
      crowdin,
      navigationString.id,
      target,
      dryRun
    )
    const status = actions.length === 0 ? 'already correct and approved' : actions.join(', ')
    let verb = 'Updated'
    if (actions.length === 0) verb = 'Checked'
    else if (dryRun) verb = 'Would update'
    console.log(`${verb} ${target.file}: ${status}`)
  }

  console.log(`${dryRun ? 'Checked' : 'Synchronized'} ${targets.length} localized README navigation translations.`)
}

try {
  await main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
