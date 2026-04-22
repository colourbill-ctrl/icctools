import styles from './TagTable.module.css'

export default function TagTable({ tags, onTagClick, changedTagIds }) {
  if (tags.length === 0) {
    return <p className={styles.empty}>No tags found.</p>
  }

  return (
    <div className={styles.wrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th className={styles.num}>#</th>
            <th>Tag Name</th>
            <th>ID</th>
            <th className={styles.num}>Offset</th>
            <th className={styles.num}>Size</th>
            <th className={styles.num}>Pad</th>
          </tr>
        </thead>
        <tbody>
          {tags.map((tag, i) => {
            const changed = changedTagIds?.has(tag.id)
            return (
              <tr
                key={i}
                className={onTagClick ? styles.clickable : ''}
                onClick={onTagClick ? () => onTagClick(tag) : undefined}
                tabIndex={onTagClick ? 0 : undefined}
                onKeyDown={onTagClick ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onTagClick(tag)
                  }
                } : undefined}
              >
                <td className={`${styles.num} ${styles.muted}`}>{i + 1}</td>
                <td className={`${styles.name} ${changed ? styles.changed : ''}`} title={changed ? 'Bytes changed since load' : undefined}>
                  {changed && <span className={styles.changedDot} aria-hidden>●</span>}
                  {tag.name}
                </td>
                <td className={styles.id}>
                  <code>{tag.id}</code>
                </td>
                <td className={`${styles.num} ${styles.mono}`}>{tag.offset}</td>
                <td className={`${styles.num} ${styles.mono}`}>{tag.size}</td>
                <td className={`${styles.num} ${styles.mono} ${padClass(tag.pad)}`}>
                  {tag.pad}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function padClass(pad) {
  if (pad < 0) return styles.padError
  if (pad > 3) return styles.padWarning
  return ''
}
