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

function createNavigationTranslation (file, expectedHeadingCount) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  const headings = parseHeadings(lines)

  if (headings.length !== expectedHeadingCount) {
    throw new Error(
      `${file} has ${headings.length} navigation headings; expected ${expectedHeadingCount}`
    )
  }

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

function main () {
  const requestedFiles = process.argv.slice(2)
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

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
  }

  if (results.length > 0) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()

export {
  createNavigationTranslation,
  findLocalizedReadmes,
  parseNavigationLinks,
  validateReadme
}
