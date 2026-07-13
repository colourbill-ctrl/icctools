// (c) 2026 William Li
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../i18n.jsx'
import styles from './GuidePanel.module.css'

// The user guide is generated from MANUAL.md into a standalone help.html by
// scripts/generate-help.js (still linkable on its own). Rather than duplicate
// that content, this panel fetches the generated page once and renders its body
// inside a tiffview-style slide-in pane with an in-page search. MANUAL.md stays
// the single source of truth. BASE_URL is '/' in dev, '/profiletool/' in prod.
const HELP_URL = `${import.meta.env.BASE_URL}help.html`

// ── trusted-HTML → React (no HTML-injection sink; see hooks/pre-commit F4) ────
// The guide is our own committed build artifact, never profile-derived, but the
// repo's security invariant forbids HTML-injection sinks anywhere in frontend/src
// regardless of trust. So we parse the fetched page with DOMParser and convert
// the DOM tree into real React elements — text becomes auto-escaped string
// children, elements become createElement() calls. Inline SVG diagrams survive
// by passing their attributes through with SVG/CSS camelCasing.

// "font-size: 11px; --bg: #fff" → { fontSize: '11px', '--bg': '#fff' }
function parseStyle(str) {
  const style = {}
  for (const decl of String(str).split(';')) {
    const i = decl.indexOf(':')
    if (i === -1) continue
    const prop = decl.slice(0, i).trim()
    if (!prop) continue
    const val = decl.slice(i + 1).trim()
    // Custom properties keep their literal name; everything else camelCases.
    style[prop.startsWith('--') ? prop : prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = val
  }
  return style
}

// class→className, for→htmlFor, hyphenated SVG presentation attrs (stroke-width,
// text-anchor…) → camelCase so React recognises them; data-*/aria-* stay as-is.
function reactAttrName(name) {
  if (name === 'class') return 'className'
  if (name === 'for') return 'htmlFor'
  if (name.startsWith('data-') || name.startsWith('aria-') || !name.includes('-')) return name
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
}

function domToReact(node, key) {
  if (node.nodeType === 3) return node.nodeValue   // text node → escaped string child
  if (node.nodeType !== 1) return null             // skip comments / others
  const tag = node.tagName.toLowerCase()
  const props = { key }
  for (const attr of node.attributes) {
    if (attr.name === 'style') { props.style = parseStyle(attr.value); continue }
    props[reactAttrName(attr.name)] = attr.value
  }
  // Off-site links open in a new tab; in-page anchors are handled at click time
  // (onBodyClick) so they scroll within the pane instead of rewriting the
  // launch fragment in location.hash.
  if (tag === 'a' && props.href && !props.href.startsWith('#')) {
    props.target = '_blank'
    props.rel = 'noopener noreferrer'
  }
  const children = []
  let i = 0
  for (const child of node.childNodes) {
    const r = domToReact(child, i++)
    if (r !== null) children.push(r)
  }
  return children.length ? createElement(tag, props, children) : createElement(tag, props)
}

export default function GuidePanel({ open, onClose }) {
  const t = useT()
  const bodyRef = useRef(null)
  const searchRef = useRef(null)
  const closeRef = useRef(null)
  const [docText, setDocText] = useState(null)          // raw help.html once fetched
  const [status, setStatus] = useState('idle')          // idle | loading | ready | error
  const [count, setCount] = useState('')                // "n/m" | "none" | ''
  const [hasNav, setHasNav] = useState(false)

  // Imperative search state (mirrors tiffview): the <mark> hits live in the DOM,
  // which React does not reconcile away because the guide subtree is memoised and
  // never re-renders after load, so we track the hits in refs.
  const hitsRef = useRef([])
  const curRef = useRef(-1)

  // Fetch the guide the first time the panel opens; cache it thereafter. Guarded
  // by a ref rather than a cleanup flag: setStatus('loading') below re-renders and
  // (if status were a dep) would re-run this effect, whose cleanup would flip a
  // `cancelled` flag and silently drop the in-flight fetch's result — leaving the
  // pane stuck on "Loading". The ref makes the fetch fire exactly once per open.
  const fetchStartedRef = useRef(false)
  useEffect(() => {
    if (!open || fetchStartedRef.current) return
    fetchStartedRef.current = true
    setStatus('loading')
    fetch(HELP_URL)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text() })
      .then((text) => { setDocText(text); setStatus('ready') })
      .catch(() => { fetchStartedRef.current = false; setStatus('error') })   // allow retry on reopen
  }, [open])

  // Parse + convert once per fetched document. Stable reference across the
  // panel's re-renders (search state) so React never re-reconciles the body and
  // the injected <mark> highlights survive.
  const guideTree = useMemo(() => {
    if (!docText) return null
    const doc = new DOMParser().parseFromString(docText, 'text/html')
    const page = doc.querySelector('.page') || doc.body
    // The standalone page repeats the product title as an <h1> + subtitle; the
    // panel header already shows it, so strip both to avoid a doubled heading.
    page.querySelectorAll('h1, p.subtitle').forEach((el) => el.remove())
    const out = []
    let i = 0
    for (const child of page.childNodes) {
      const r = domToReact(child, i++)
      if (r !== null) out.push(r)
    }
    return out
  }, [docText])

  // ── in-page search (plain find over the rendered body) ─────────────────────
  // Unwrap every <mark> and re-merge the split text nodes for a clean re-search.
  const clearMarks = useCallback(() => {
    const body = bodyRef.current
    if (body) {
      for (const m of body.querySelectorAll('mark.' + styles.hit)) {
        const p = m.parentNode
        p.replaceChild(document.createTextNode(m.textContent), m)
        p.normalize()
      }
    }
    hitsRef.current = []
    curRef.current = -1
  }, [])

  const refreshCount = useCallback(() => {
    const hits = hitsRef.current
    const q = searchRef.current?.value.trim()
    setHasNav(hits.length > 1)
    setCount(!q ? '' : (hits.length ? `${curRef.current + 1}/${hits.length}` : 'none'))
  }, [])

  const setCurrent = useCallback((scroll) => {
    const hits = hitsRef.current
    hits.forEach((m, i) => m.classList.toggle(styles.cur, i === curRef.current))
    if (scroll && curRef.current >= 0) {
      hits[curRef.current].scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
    refreshCount()
  }, [refreshCount])

  const runSearch = useCallback(() => {
    clearMarks()
    const body = bodyRef.current
    const q = (searchRef.current?.value || '').trim().toLowerCase()
    if (!body || q.length < 2) { refreshCount(); return }   // ignore 0–1 char terms
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        if (!n.nodeValue || !n.nodeValue.toLowerCase().includes(q)) return NodeFilter.FILTER_REJECT
        if (n.parentElement && n.parentElement.closest('svg')) return NodeFilter.FILTER_REJECT // skip diagrams
        return NodeFilter.FILTER_ACCEPT
      },
    })
    const nodes = []
    let n
    while ((n = walker.nextNode())) nodes.push(n)   // collect before mutating
    const hits = []
    for (const node of nodes) {
      const text = node.nodeValue, lower = text.toLowerCase()
      const frag = document.createDocumentFragment()
      let from = 0, idx
      while ((idx = lower.indexOf(q, from)) !== -1) {
        if (idx > from) frag.appendChild(document.createTextNode(text.slice(from, idx)))
        const mark = document.createElement('mark')
        mark.className = styles.hit
        mark.textContent = text.slice(idx, idx + q.length)
        frag.appendChild(mark)
        hits.push(mark)
        from = idx + q.length
      }
      if (from < text.length) frag.appendChild(document.createTextNode(text.slice(from)))
      node.parentNode.replaceChild(frag, node)
    }
    hitsRef.current = hits
    curRef.current = hits.length ? 0 : -1
    setCurrent(true)   // jump to the first match
  }, [clearMarks, refreshCount, setCurrent])

  const step = useCallback((delta) => {
    const hits = hitsRef.current
    if (hits.length < 2) return
    curRef.current = (curRef.current + delta + hits.length) % hits.length
    setCurrent(true)
  }, [setCurrent])

  const timerRef = useRef(0)
  const onInput = useCallback(() => {
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(runSearch, 120)
  }, [runSearch])

  const onSearchKeyDown = useCallback((e) => {
    if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1) }
    else if (e.key === 'Escape' && searchRef.current?.value) {
      // Clear the search first; only a second Escape (empty box) closes the guide.
      e.preventDefault(); e.stopPropagation()
      searchRef.current.value = ''
      clearMarks(); refreshCount()
    }
  }, [step, clearMarks, refreshCount])

  // Focus management + document-level Escape-to-close while open; reset the
  // search when the panel closes so it reopens clean.
  useEffect(() => {
    if (open) {
      const id = setTimeout(() => closeRef.current?.focus(), 60)
      const onKey = (e) => { if (e.key === 'Escape') onClose() }
      document.addEventListener('keydown', onKey)
      return () => { clearTimeout(id); document.removeEventListener('keydown', onKey) }
    }
    if (searchRef.current) searchRef.current.value = ''
    clearMarks(); refreshCount()
  }, [open, onClose, clearMarks, refreshCount])

  // In-page anchors scroll within the pane rather than rewriting location.hash
  // (which carries the app's #url=/#tab= launch fragment). The heading ids start
  // with a digit, so escape before querySelector.
  const onBodyClick = useCallback((e) => {
    const a = e.target.closest?.('a[href^="#"]')
    if (!a) return
    const id = a.getAttribute('href').slice(1)
    const target = id && bodyRef.current?.querySelector(`#${CSS.escape(id)}`)
    if (target) { e.preventDefault(); target.scrollIntoView({ block: 'start', behavior: 'smooth' }) }
  }, [])

  const countLabel = count === 'none' ? t('guide_no_matches') : count

  return (
    <>
      <div
        className={`${styles.backdrop} ${open ? styles.open : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Panel stays mounted for the slide transition; when closed it sits
          off-screen, so mark it inert to keep its buttons out of the tab order. */}
      <aside
        className={`${styles.panel} ${open ? styles.open : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="guide-title"
        aria-hidden={open ? 'false' : 'true'}
        {...(!open && { inert: '' })}
      >
        <header className={styles.head}>
          <h2 id="guide-title" className={styles.title}>{t('guide_title')}</h2>
          <div className={styles.headRight}>
            <div className={styles.search} role="search">
              <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor"
                   strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
                <circle cx="8.5" cy="8.5" r="5.5" /><path d="M12.6 12.6 L17.5 17.5" />
              </svg>
              <input
                ref={searchRef}
                className={styles.searchInput}
                type="text"
                autoComplete="off"
                spellCheck="false"
                placeholder={t('guide_search_ph')}
                aria-label={t('guide_search_aria')}
                onInput={onInput}
                onKeyDown={onSearchKeyDown}
                disabled={status !== 'ready'}
              />
              <span className={styles.searchCount} aria-live="polite">{countLabel}</span>
              <button
                type="button"
                className={styles.searchNav}
                onClick={() => { step(-1); searchRef.current?.focus() }}
                title={t('guide_prev')}
                aria-label={t('guide_prev')}
                hidden={!hasNav}
              >˄</button>
              <button
                type="button"
                className={styles.searchNav}
                onClick={() => { step(1); searchRef.current?.focus() }}
                title={t('guide_next')}
                aria-label={t('guide_next')}
                hidden={!hasNav}
              >˅</button>
            </div>
            <button
              ref={closeRef}
              type="button"
              className={styles.closeX}
              onClick={onClose}
              title={t('guide_close')}
              aria-label={t('guide_close')}
            >×</button>
          </div>
        </header>

        {status === 'loading' && <div className={styles.state}>{t('guide_loading')}</div>}
        {status === 'error' && <div className={styles.state}>{t('guide_error')}</div>}
        {status === 'ready' && (
          <div ref={bodyRef} className={styles.body} onClick={onBodyClick}>
            {guideTree}
          </div>
        )}
      </aside>
    </>
  )
}
