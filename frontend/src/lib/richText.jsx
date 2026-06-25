// (c) 2026 William Li
/**
 * Render a trusted i18n string that contains a tiny, fixed markup subset
 * (`<em>…</em>` and `<code>…</code>`) as React nodes — without
 * dangerouslySetInnerHTML.
 *
 * The placeholder/help strings in i18n.jsx are developer-authored constants, so
 * the markup is safe today. Routing them through React text nodes instead of an
 * innerHTML sink means that even if a translation ever gained an `<img onerror>`
 * or `<script>` (e.g. a bad spreadsheet round-trip), it would render as inert
 * text rather than execute. Only `<em>` and `<code>` are interpreted; every
 * other character — including any other `<tag>` — becomes literal text, which
 * React escapes.
 *
 * Tags are treated as non-nested (the dictionary never nests them). An unmatched
 * or unknown tag is emitted verbatim as text.
 */

const TOKEN = /<(em|code)>([\s\S]*?)<\/\1>/g

export function renderRichText(str) {
  if (typeof str !== 'string') return str
  const nodes = []
  let last = 0
  let m
  let key = 0
  while ((m = TOKEN.exec(str)) !== null) {
    if (m.index > last) nodes.push(str.slice(last, m.index))
    const [, tag, inner] = m
    nodes.push(tag === 'em'
      ? <em key={key++}>{inner}</em>
      : <code key={key++}>{inner}</code>)
    last = m.index + m[0].length
  }
  if (last < str.length) nodes.push(str.slice(last))
  return nodes
}
