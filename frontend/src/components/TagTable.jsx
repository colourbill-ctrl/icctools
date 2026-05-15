import styles from './TagTable.module.css'

export default function TagTable({ tags, onTagClick, changedTagIds }) {
  if (tags.length === 0) {
    return <p className={styles.empty}>No tags found.</p>
  }

  return (
    <div className={styles.wrapper}>
      <div className={`${styles.row} ${styles.head}`} role="row">
        <span className={`${styles.num} ${styles.colNum}`}>#</span>
        <span className={styles.colName}>Tag Name</span>
        <span className={styles.colId}>ID</span>
        <span className={`${styles.num} ${styles.colOffset}`}>Offset</span>
        <span className={`${styles.num} ${styles.colSize}`}>Size</span>
        <span className={`${styles.num} ${styles.colPad}`}>Pad</span>
      </div>
      {tags.map((tag, i) => {
        const changed = changedTagIds?.has(tag.id)
        const clickProps = onTagClick ? {
          role: 'button',
          tabIndex: 0,
          onClick: () => onTagClick(tag),
          onKeyDown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onTagClick(tag)
            }
          },
        } : {}
        return (
          <div
            key={i}
            className={`${styles.row} ${onTagClick ? styles.clickable : ''}`}
            {...clickProps}
          >
            <span className={`${styles.num} ${styles.colNum} ${styles.muted}`}>{i + 1}</span>
            <span className={`${styles.colName} ${styles.name} ${changed ? styles.changed : ''}`} title={changed ? 'Bytes changed since load' : undefined}>
              {changed && <span className={styles.changedDot} aria-hidden>●</span>}
              {tag.name}
            </span>
            <span className={styles.colId}>
              <code>{tag.id}</code>
            </span>
            <span className={`${styles.num} ${styles.mono} ${styles.colOffset}`}>
              {tag.offset}
            </span>
            <span className={`${styles.num} ${styles.mono} ${styles.colSize}`}>
              {tag.size}
            </span>
            <span className={`${styles.num} ${styles.mono} ${styles.colPad} ${padClass(tag.pad)}`}>
              {tag.pad}
            </span>
            {/*
              Mobile-only meta line + tap caret. Both elements are display:none
              on desktop (TagTable.module.css). On ≤720 px the CSS swaps the row
              into a 3-col grid (num · name+meta · caret) so the offset/size/pad
              cells collapse into a single monospace summary line — matches the
              chardata ICC viewer's mobile reflow.
            */}
            <span className={styles.meta} aria-hidden>
              <code className={styles.idInline}>{tag.id}</code>
              {' · '}{tag.size?.toLocaleString?.() ?? tag.size}B
              {' · off '}{tag.offset?.toLocaleString?.() ?? tag.offset}
              {' · pad '}<span className={padMetaClass(tag.pad)}>{tag.pad}</span>
            </span>
            <span className={styles.caret} aria-hidden>›</span>
          </div>
        )
      })}
    </div>
  )
}

function padClass(pad) {
  if (pad < 0) return styles.padError
  if (pad > 3) return styles.padWarning
  return ''
}

function padMetaClass(pad) {
  if (pad < 0) return styles.padMetaError
  if (pad > 3) return styles.padMetaWarning
  return ''
}
