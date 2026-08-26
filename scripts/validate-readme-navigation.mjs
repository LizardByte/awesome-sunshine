import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import GithubSlugger from 'github-slugger'

const root = process.cwd()

function findLocalizedReadmes (directory) {
  if (!fs.existsSync(directory)) return []

  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const entryPath = path.join(directory, entry.name)

      if (entry.isDirectory()) return findLocalizedReadmes(entryPath)
      return entry.isFile() && entry.name === 'README.md' ? [entryPath] : []
    })
}

function decodeHtml (value) {
  return value.replace(/&(?:#(\d+)|#x([\da-f]+)|amp|lt|gt|quot|apos);/gi, entity => {
    const decimal = /^&#(\d+);$/i.exec(entity)
    if (decimal) return String.fromCodePoint(Number(decimal[1]))

    const hexadecimal = /^&#x([\da-f]+);$/i.exec(entity)
    if (hexadecimal) return String.fromCodePoint(Number.parseInt(hexadecimal[1], 16))

    return {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&apos;': "'"
    }[entity.toLowerCase()]
  })
}

function headingText (markdown) {
  return decodeHtml(markdown)
    .replace(/<[^<>]+>/g, '')
    .replace(/[`*_~]/g, '')
    .trim()
}

function splitHeading (text) {
  const firstSpace = text.indexOf(' ')
  const prefix = firstSpace > 0 ? text.slice(0, firstSpace) : ''

  if (/\p{Extended_Pictographic}/u.test(prefix)) {
    return {
      emoji: prefix,
      text: text.slice(firstSpace + 1).trim()
    }
  }

  return { emoji: '', text }
}

function parseCanonicalHeadings (lines) {
  const headings = []

  for (const line of lines) {
    const match = /^(#{1,6})[ \t](.+)$/.exec(line)
    if (!match) continue

    const level = match[1].length
    const sourceText = headingText(match[2].replace(/[ \t]#+[ \t]*$/, ''))
    const heading = splitHeading(sourceText)

    if (level === 2 && heading.emoji) {
      headings.push({
        emoji: heading.emoji,
        text: heading.text
      })
    }
  }

  return headings
}

function parseHeadings (lines) {
  const slugger = new GithubSlugger()
  const navigationHeadings = []

  for (const [index, line] of lines.entries()) {
    const match = /^(#{1,6})[ \t](.+)$/.exec(line)
    if (!match) continue

    const level = match[1].length
    const text = headingText(match[2].replace(/[ \t]#+[ \t]*$/, ''))
    const slug = slugger.slug(text)
    const firstSpace = text.indexOf(' ')

    if (
      level === 2 &&
      firstSpace > 0 &&
      /\p{Extended_Pictographic}/u.test(text.slice(0, firstSpace))
    ) {
      navigationHeadings.push({
        line: index + 1,
        slug,
        text: text.slice(firstSpace + 1).trim()
      })
    }
  }

  return navigationHeadings
}

function readLocalizedHeadings (file, canonicalHeadings) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  const h2Count = lines.filter(line => /^##[ \t]+/.test(line)).length

  if (h2Count <= canonicalHeadings.length) {
    throw new Error(
      `${file} has fewer than ${canonicalHeadings.length} navigation headings plus its final section`
    )
  }

  const slugger = new GithubSlugger()
  const headings = []
  let navigationIndex = 0

  for (const line of lines) {
    const match = /^(#{1,6})[ \t](.+)$/.exec(line)
    if (!match) continue

    const level = match[1].length
    const currentText = headingText(match[2].replace(/[ \t]#+[ \t]*$/, ''))
    let expectedText = currentText

    if (level === 2 && navigationIndex < canonicalHeadings.length) {
      const canonical = canonicalHeadings[navigationIndex]
      const localized = splitHeading(currentText)
      expectedText = `${canonical.emoji} ${localized.text}`
      headings.push({
        expected: expectedText,
        slug: slugger.slug(expectedText),
        text: localized.text
      })
      navigationIndex++
      continue
    }

    slugger.slug(expectedText)
  }

  if (headings.length !== canonicalHeadings.length) {
    throw new Error(
      `${file} has ${headings.length} navigation headings; expected ${canonicalHeadings.length}`
    )
  }

  return headings
}

function parseNavigationLinks (lines) {
  const firstHeading = lines.findIndex(line => /^#{1,6}[ \t]+/.test(line))
  const preambleLines = lines.slice(0, firstHeading === -1 ? lines.length : firstHeading)
  const links = []

  for (const [index, line] of preambleLines.entries()) {
    const match = /^[ \t]*<a href="(#[^"]*)">([^<>]*)<\/a>/.exec(line)
    if (!match) continue

    links.push({
      href: match[1],
      line: index + 1,
      text: decodeHtml(match[2].trim())
    })
  }

  return links
}

function createHeadingTranslations (file, canonicalHeadings) {
  return readLocalizedHeadings(file, canonicalHeadings)
    .map(heading => heading.expected)
}

function createNavigationTranslation (file, canonicalHeadings) {
  const headings = readLocalizedHeadings(file, canonicalHeadings)

  const links = headings.map((heading, index) => {
    const separator = index === headings.length - 1 ? '' : ' •'
    return `  ${anchor('#' + heading.slug, heading.text)}${separator}`
  })

  return `\n[\n${links.join('\n')}\n]\n`
}

function decodedFragment (href) {
  try {
    return decodeURIComponent(href.slice(1))
  } catch {
    return null
  }
}

function anchor (href, text) {
  return `<a href="${href}">${text}</a>`
}

function validateReadme (file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  const headings = parseHeadings(lines)
  const links = parseNavigationLinks(lines)
  const issues = []

  for (let index = 0; index < Math.max(headings.length, links.length); index++) {
    const heading = headings[index]
    const link = links[index]

    if (!heading) {
      issues.push({
        issue: 'Extra navigation link',
        line: link.line,
        current: anchor(link.href, link.text),
        expected: '(remove link)'
      })
      continue
    }

    const expected = anchor(`#${heading.slug}`, heading.text)
    if (!link) {
      issues.push({
        issue: 'Missing navigation link',
        line: heading.line,
        current: '(missing)',
        expected
      })
      continue
    }

    const mismatches = []
    if (decodedFragment(link.href) !== heading.slug) mismatches.push('anchor')
    if (link.text !== heading.text) mismatches.push('visible text')

    if (mismatches.length > 0) {
      issues.push({
        issue: `Incorrect ${mismatches.join(' and ')}`,
        line: link.line,
        current: anchor(link.href, link.text),
        expected
      })
    }
  }

  return issues
}

function markdownCode (value) {
  const escaped = value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '&#124;')

  return `<code>${escaped}</code>`
}

function relativePath (file) {
  return path.relative(root, file).split(path.sep).join('/')
}

function main ({
  requestedFiles = process.argv.slice(2),
  summaryFile = process.env.GITHUB_STEP_SUMMARY
} = {}) {
  const files = (requestedFiles.length > 0
    ? requestedFiles.map(file => path.resolve(root, file))
    : [path.join(root, 'README.md'), ...findLocalizedReadmes(path.join(root, 'locale'))]
  ).sort((left, right) => relativePath(left).localeCompare(relativePath(right), 'en'))

  const results = files
    .map(file => ({ file, issues: validateReadme(file) }))
    .filter(result => result.issues.length > 0)

  let summary = '## README navigation validation\n\n'

  if (results.length === 0) {
    summary += `✅ All ${files.length} README navigation blocks match their section headings.\n`
    console.log(`All ${files.length} README navigation blocks match their section headings.`)
  } else {
    const issueCount = results.reduce((total, result) => total + result.issues.length, 0)
    summary += `❌ Found ${issueCount} navigation mismatch${issueCount === 1 ? '' : 'es'} in ${results.length} file${results.length === 1 ? '' : 's'}.\n\n`

    for (const result of results) {
      const file = relativePath(result.file)
      summary += `### \`${file}\`\n\n`
      summary += '| Issue | Current value | Correct value |\n'
      summary += '| --- | --- | --- |\n'

      for (const issue of result.issues) {
        summary += `| ${issue.issue} | ${markdownCode(issue.current)} | ${markdownCode(issue.expected)} |\n`
        console.error(`${file}:${issue.line}: ${issue.issue}; expected ${issue.expected}`)
      }

      summary += '\n'
    }
  }

  if (summaryFile) {
    fs.appendFileSync(summaryFile, summary)
  }

  if (results.length > 0) process.exitCode = 1

  return { results, summary }
}

function runIfMain (moduleUrl, entryPoint = process.argv[1], mainFunction = main) {
  if (entryPoint && path.resolve(entryPoint) === fileURLToPath(moduleUrl)) mainFunction()
}

runIfMain(import.meta.url)

export {
  createHeadingTranslations,
  createNavigationTranslation,
  findLocalizedReadmes,
  main,
  parseCanonicalHeadings,
  parseNavigationLinks,
  runIfMain,
  validateReadme
}
