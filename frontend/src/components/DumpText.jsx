// (c) 2026 William Li
//
// Renders a (possibly very large) Describe() dump in a <pre>, but caps how much is
// laid out at once. A big CLUT tag's verbosity-100 dump can be multiple megabytes
// of text; inserting all of it as DOM blocks the main thread on layout/paint (the
// "Data tab froze" lag). We render only the first `CAP` characters and offer a
// "Show full dump" button so the user opts into the heavy render explicitly.
import { useState } from 'react'
import { useT } from '../i18n.jsx'
import styles from './DumpText.module.css'

// ~200 KB of text renders quickly; beyond that the layout cost grows noticeably.
const CAP = 200_000

export default function DumpText({ text, className }) {
  const t = useT()
  const [full, setFull] = useState(false)
  const s = text || ''

  if (full || s.length <= CAP) {
    return <pre className={className}>{s}</pre>
  }

  const totalKB = Math.round(s.length / 1024)
  const label = `${t('show_full_dump') || 'Show full dump'} (${totalKB.toLocaleString()} KB)`
  return (
    <>
      {/* Slice is cheap; only the first CAP chars are laid out until the user asks. */}
      <pre className={className}>{s.slice(0, CAP)}{'\n…'}</pre>
      <button type="button" className={styles.showFull} onClick={() => setFull(true)}>
        {label}
      </button>
      <span className={styles.truncNote}>
        {t('dump_truncated') || 'Output truncated for performance.'}
      </span>
    </>
  )
}
