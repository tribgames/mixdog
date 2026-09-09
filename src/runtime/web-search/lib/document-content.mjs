import { Readability } from '@mozilla/readability'

let domModule
const loadDom = () => (domModule ||= import('jsdom'))

export function assertReadableContent(content) {
  if (!String(content ?? '').trim()) {
    const error = new Error('No readable content in response')
    error.code = 'EMPTY_CONTENT'
    throw error
  }
}

export function buildContentPayload(url, title, content, extractor, extra = {}) {
  const text = String(content ?? '')
  assertReadableContent(text)
  return {
    url, title: String(title || '').trim(), content: text,
    excerpt: text.slice(0, 240), extractor, ...extra,
  }
}

function safeLink(value, base) {
  try {
    const url = new URL(value, base)
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : ''
  } catch { return '' }
}

function markdown(node, base) {
  if (node.nodeType === 3) return node.nodeValue.replace(/\s+/g, ' ').replace(/([\\`*_[\]])/g, '\\$1')
  if (node.nodeType !== 1) return ''
  const tag = node.tagName.toLowerCase()
  const children = () => [...node.childNodes].map(child => markdown(child, base)).join('')
  if (tag === 'pre') {
    const code = node.textContent.replace(/\r\n/g, '\n').replace(/\n$/, '')
    const longest = Math.max(2, ...(code.match(/`+/g) || []).map(run => run.length))
    const fence = '`'.repeat(longest + 1)
    const language = node.querySelector('code')?.className?.match(/(?:language|lang)-([\w+-]+)/)?.[1] || ''
    return `\n\n${fence}${language}\n${code}\n${fence}\n\n`
  }
  if (tag === 'code') {
    const text = node.textContent.replace(/\s+/g, ' ')
    const fence = '`'.repeat(Math.max(0, ...(text.match(/`+/g) || []).map(run => run.length)) + 1)
    return `${fence} ${text} ${fence}`
  }
  if (tag === 'br') return '\n'
  if (tag === 'hr') return '\n\n---\n\n'
  if (tag === 'img') {
    const alt = node.getAttribute('alt')?.trim()
    const url = safeLink(node.getAttribute('src'), base)
    return alt && url ? `![${alt.replace(/[\[\]]/g, '')}](<${url}>)` : ''
  }
  if (tag === 'a') {
    const label = children().trim()
    const url = safeLink(node.getAttribute('href'), base)
    return label && url ? `[${label}](<${url}>)` : label
  }
  if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${children().trim()}\n\n`
  if (tag === 'strong' || tag === 'b') return `**${children().trim()}**`
  if (tag === 'em' || tag === 'i') return `*${children().trim()}*`
  if (tag === 'blockquote') return `\n\n${children().trim().split('\n').map(line => `> ${line}`).join('\n')}\n\n`
  if (tag === 'table') {
    const rows = [...node.querySelectorAll('tr')].filter(row => row.closest('table') === node)
      .map(row => [...row.children].filter(cell => /^(TD|TH)$/.test(cell.tagName))
        .map(cell => markdown(cell, base).trim().replace(/\n+/g, '<br>').replace(/\|/g, '\\|')))
    if (!rows.length) return ''
    const width = Math.max(...rows.map(row => row.length))
    const render = row => `| ${Array.from({ length: width }, (_, i) => row[i] || '').join(' | ')} |`
    return `\n\n${render(rows[0])}\n${render(Array(width).fill('---'))}\n${rows.slice(1).map(render).join('\n')}\n\n`
  }
  if (tag === 'ul' || tag === 'ol') {
    let index = Number(node.getAttribute('start')) || 1
    return '\n\n' + [...node.children].map(item => {
      const prefix = tag === 'ol' ? `${index++}. ` : '- '
      return prefix + markdown(item, base).trim().replace(/\n/g, `\n${' '.repeat(prefix.length)}`)
    }).join('\n') + '\n\n'
  }
  const value = children()
  return /^(p|div|section|article|main|header|figure|figcaption|dl|dt|dd)$/.test(tag) ? `\n\n${value.trim()}\n\n` : value
}

function tidyMarkdown(text) {
  // Do not normalize fenced code: blank lines and indentation may be meaningful.
  let fence = null
  let blanks = 0
  return text.split('\n').filter(line => {
    const match = /^(`{3,})/.exec(line)
    if (match && (!fence || match[1].length >= fence.length)) fence = fence ? null : match[1]
    if (fence || line.trim()) { blanks = 0; return true }
    return ++blanks <= 1
  }).join('\n').trim()
}

export async function extractDocument(url, body, contentType = '') {
  const mime = contentType.split(';')[0].trim().toLowerCase()
  const isHtml = mime === 'text/html' || mime === 'application/xhtml+xml' ||
    (!mime && /^\s*(?:<!doctype html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(body))
  if (!isHtml) {
    const format = /json/.test(mime) ? 'json' : /markdown/.test(mime) || /\.md(?:own)?$/i.test(new URL(url).pathname) ? 'markdown' : 'text'
    return buildContentPayload(url, '', body, 'raw', { format, contentType: mime })
  }
  const { JSDOM } = await loadDom()
  const dom = new JSDOM(body, { url })
  try {
    const doc = dom.window.document
    const title = doc.title
    const images = ['meta[property="og:image"]', 'meta[name="twitter:image"]']
      .map(selector => doc.querySelector(selector)?.getAttribute('content')).filter(Boolean)
    for (const element of doc.querySelectorAll('script,style,noscript,template,nav,footer,aside,[hidden],[aria-hidden="true"],[inert]')) element.remove()
    // Semantic document containers take precedence over article heuristics.
    // Readability works on a clone so a failed parse never destroys the fallback.
    const candidates = [...doc.querySelectorAll('main,[role="main"],article,.markdown-body,[itemprop="articleBody"]')]
    let root = candidates.sort((a, b) => b.textContent.trim().length - a.textContent.trim().length)[0]
    let extractor = 'dom-markdown'
    if (!root?.textContent.trim()) {
      const article = new Readability(doc.cloneNode(true)).parse()
      if (article?.content && article.textContent?.trim()) {
        root = doc.createElement('div')
        root.innerHTML = article.content
        extractor = 'readability'
      } else root = doc.body
    }
    const text = tidyMarkdown(root ? markdown(root, url) : '')
    // Metadata must never turn an empty JS shell into a successful document.
    const payload = buildContentPayload(url, title, text, extractor, { format: 'html', contentType: mime || 'text/html' })
    const imageLines = [...new Set(images)].map(value => safeLink(value, url)).filter(Boolean).map(value => `og:image: ${value}`)
    if (imageLines.length) payload.content = `${imageLines.join('\n')}\n\n${payload.content}`
    return payload
  } finally { dom.window.close() }
}
