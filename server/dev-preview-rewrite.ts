import { parse } from '@babel/parser'

type Edit = { start: number; end: number; value: string }

function applyEdits(source: string, edits: Edit[]) {
  let output = source
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    output = output.slice(0, edit.start) + edit.value + output.slice(edit.end)
  }
  return output
}

function assetUrl(value: string, base: string, port: number) {
  if (value.startsWith('/') && !value.startsWith('//')) {
    try {
      const url = new URL(value, 'http://preview.invalid')
      if (url.origin !== 'http://preview.invalid') return value
      const path = url.pathname + url.search + url.hash
      return path === base || path.startsWith(base + '/') || path.startsWith(base + '?') || path.startsWith(base + '#') ? path : base + path
    } catch { return value }
  }
  if (!/^https?:\/\//i.test(value)) return value
  try {
    const url = new URL(value)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || Number(url.port) !== port || url.username || url.password) return value
    const path = url.pathname + url.search + url.hash
    return path === base || path.startsWith(base + '/') || path.startsWith(base + '?') || path.startsWith(base + '#') ? path : base + path
  } catch { return value }
}

/** Rewrite module specifiers, never arbitrary string or regular-expression literals. */
function rewriteScript(source: string, base: string, port: number) {
  let ast: ReturnType<typeof parse>
  try {
    ast = parse(source, { sourceType: 'unambiguous', createImportExpressions: true, allowAwaitOutsideFunction: true, attachComment: false })
  } catch {
    // Preserve future/unsupported syntax instead of producing different, invalid code.
    return source
  }
  const edits: Edit[] = []
  const pending: unknown[] = [ast]
  while (pending.length) {
    const value = pending.pop()
    if (!value || typeof value !== 'object') continue
    if (Array.isArray(value)) { pending.push(...value); continue }
    const node = value as { type?: string; source?: unknown; callee?: { type?: string }; arguments?: unknown[] }
    if (typeof node.type !== 'string') continue
    const specifier = ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(node.type || '')
      ? node.source
      : node.type === 'CallExpression' && node.callee?.type === 'Import' ? node.arguments?.[0] : undefined
    if (specifier && typeof specifier === 'object') {
      const literal = specifier as { type?: string; value?: unknown; expressions?: unknown[]; quasis?: { value?: { cooked?: string | null } }[]; start?: number; end?: number }
      const original = literal.type === 'StringLiteral' && typeof literal.value === 'string' ? literal.value
        : literal.type === 'TemplateLiteral' && literal.expressions?.length === 0 ? literal.quasis?.[0]?.value?.cooked : undefined
      if (typeof original === 'string' && typeof literal.start === 'number' && typeof literal.end === 'number') {
        const mapped = assetUrl(original, base, port)
        if (mapped !== original) edits.push({ start: literal.start, end: literal.end, value: JSON.stringify(mapped) })
      }
    }
    for (const [key, child] of Object.entries(value)) if (key !== 'loc' && key !== 'extra' && key !== 'comments' && child && typeof child === 'object') pending.push(child)
  }
  return applyEdits(source, edits)
}

function stringEnd(source: string, start: number) {
  const quote = source[start]
  let index = start + 1
  while (index < source.length) {
    if (source[index] === '\\') { index += 2; continue }
    if (source[index] === quote) return index
    index++
  }
  return source.length
}

function skipCssSpace(source: string, start: number) {
  let index = start
  while (index < source.length) {
    if (/\s/.test(source[index]!)) { index++; continue }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2)
      index = end < 0 ? source.length : end + 2
      continue
    }
    break
  }
  return index
}

/** CSS has quoted content and comments that must not be treated as URL references. */
function rewriteCss(source: string, base: string, port: number) {
  const edits: Edit[] = []
  for (let index = 0; index < source.length;) {
    if (source.startsWith('/*', index)) { index = skipCssSpace(source, index); continue }
    if (source[index] === '"' || source[index] === "'") { index = stringEnd(source, index) + 1; continue }
    const tail = source.slice(index)
    if (/^@import\b/i.test(tail)) {
      const start = skipCssSpace(source, index + 7)
      if (source[start] === '"' || source[start] === "'") {
        const end = stringEnd(source, start)
        const original = source.slice(start + 1, end)
        const mapped = assetUrl(original, base, port)
        if (mapped !== original) edits.push({ start: start + 1, end, value: mapped })
        index = end + 1
        continue
      }
    }
    const url = /^url\(/i.exec(tail)
    if (url && (index === 0 || !/[\w-]/.test(source[index - 1]!))) {
      let start = skipCssSpace(source, index + url[0].length)
      let end: number
      if (source[start] === '"' || source[start] === "'") {
        end = stringEnd(source, start)
        start++
      } else {
        end = start
        while (end < source.length && source[end] !== ')') { if (source[end] === '\\') end++; end++ }
        while (end > start && /\s/.test(source[end - 1]!)) end--
      }
      const original = source.slice(start, end)
      const mapped = assetUrl(original, base, port)
      if (mapped !== original) edits.push({ start, end, value: mapped })
      index = Math.max(index + 1, end + 1)
      continue
    }
    index++
  }
  return applyEdits(source, edits)
}

function rewriteSrcset(source: string, base: string, port: number) {
  const edits: Edit[] = []
  let index = 0
  while (index < source.length) {
    while (index < source.length && /[\s,]/.test(source[index]!)) index++
    const start = index
    while (index < source.length && !/\s/.test(source[index]!)) index++
    let end = index
    while (end > start && source[end - 1] === ',') end--
    const original = source.slice(start, end)
    const mapped = assetUrl(original, base, port)
    if (mapped !== original) edits.push({ start, end, value: mapped })
    if (end !== index) continue
    // Commas inside URL tokens (notably data URLs) are not candidate separators.
    let parentheses = 0
    while (index < source.length) {
      const character = source[index++]
      if (character === '(') parentheses++
      else if (character === ')') parentheses = Math.max(0, parentheses - 1)
      else if (character === ',' && !parentheses) break
    }
  }
  return applyEdits(source, edits)
}

const urlAttributes = new Set(['src', 'href', 'xlink:href', 'action', 'formaction', 'poster', 'data', 'background', 'cite'])

function rewriteTag(tag: string, base: string, port: number) {
  const edits: Edit[] = []
  const attributes = new Map<string, string>()
  let index = /^<\/?[a-z][\w:-]*/i.exec(tag)?.[0].length || tag.length
  while (index < tag.length) {
    while (/\s/.test(tag[index] || '')) index++
    if (index >= tag.length || tag[index] === '>' || tag[index] === '/') break
    const start = index
    while (index < tag.length && !/[\s=/>]/.test(tag[index]!)) index++
    if (index === start) { index++; continue }
    const name = tag.slice(start, index).toLowerCase()
    while (/\s/.test(tag[index] || '')) index++
    if (tag[index] !== '=') continue
    index++
    while (/\s/.test(tag[index] || '')) index++
    const quoted = tag[index] === '"' || tag[index] === "'"
    const quote = quoted ? tag[index++] : undefined
    const valueStart = index
    if (quoted) { while (index < tag.length && tag[index] !== quote) index++ }
    else { while (index < tag.length && !/[\s>]/.test(tag[index]!)) index++ }
    const original = tag.slice(valueStart, index)
    if (!attributes.has(name)) attributes.set(name, original)
    const mapped = urlAttributes.has(name) ? assetUrl(original, base, port)
      : name === 'srcset' || name === 'imagesrcset' ? rewriteSrcset(original, base, port)
      : name === 'style' ? rewriteCss(original, base, port) : original
    if (mapped !== original) edits.push({ start: valueStart, end: index, value: mapped })
    if (quoted) index++
  }
  return { source: applyEdits(tag, edits), attributes }
}

function rewriteHtml(source: string, base: string, port: number) {
  const pieces: string[] = []
  let cursor = 0
  while (cursor < source.length) {
    const start = source.indexOf('<', cursor)
    if (start < 0) break
    pieces.push(source.slice(cursor, start))
    if (source.startsWith('<!--', start)) {
      const close = source.indexOf('-->', start + 4)
      cursor = close < 0 ? source.length : close + 3
      pieces.push(source.slice(start, cursor))
      continue
    }
    const match = /^<(\/?)([a-z][\w:-]*)\b/i.exec(source.slice(start))
    if (!match) { pieces.push('<'); cursor = start + 1; continue }
    let end = start + match[0].length
    let quote: string | undefined
    for (; end < source.length; end++) {
      const character = source[end]
      if (quote) { if (character === quote) quote = undefined }
      else if (character === '"' || character === "'") quote = character
      else if (character === '>') { end++; break }
    }
    const tag = rewriteTag(source.slice(start, end), base, port)
    pieces.push(tag.source)
    cursor = end
    const name = match[2]!.toLowerCase()
    if (!match[1] && !/\/\s*>$/.test(tag.source) && ['script', 'style', 'textarea', 'title'].includes(name)) {
      const closing = new RegExp(`</${name}\\s*>`, 'ig')
      closing.lastIndex = cursor
      const close = closing.exec(source)
      const bodyEnd = close?.index ?? source.length
      const body = source.slice(cursor, bodyEnd)
      pieces.push(name === 'style' ? rewriteCss(body, base, port)
        : name === 'script' && tag.attributes.get('type')?.trim().toLowerCase() === 'module' ? rewriteScript(body, base, port) : body)
      cursor = bodyEnd
    }
  }
  pieces.push(source.slice(cursor))
  return pieces.join('')
}

export function rewriteDevelopmentAssets(source: string, contentType: string, base: string, port: number) {
  if (/text\/html|application\/xhtml\+xml/i.test(contentType)) return rewriteHtml(source, base, port)
  if (/text\/css/i.test(contentType)) return rewriteCss(source, base, port)
  if (/(?:javascript|ecmascript)/i.test(contentType)) return rewriteScript(source, base, port)
  return source
}
