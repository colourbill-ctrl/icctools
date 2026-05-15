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
              <span className={styles.label}>Offset</span>
              {tag.offset}
            </span>
            <span className={`${styles.num} ${styles.mono} ${styles.colSize}`}>
              <span className={styles.label}>Size</span>
              {tag.size}
            </span>
            <span className={`${styles.num} ${styles.mono} ${styles.colPad} ${padClass(tag.pad)}`}>
              <span className={styles.label}>Pad</span>
              {tag.pad}
            </span>
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
