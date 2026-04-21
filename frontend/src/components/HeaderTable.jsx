import styles from './HeaderTable.module.css'

export default function HeaderTable({ header, profileId }) {
  const rows = Object.entries(header)

  return (
    <div className={styles.wrapper}>
      {profileId && (
        <div className={styles.profileId}>
          <span className={styles.idLabel}>Profile ID</span>
          <code className={styles.idValue}>{profileId}</code>
        </div>
      )}
      <table className={styles.table}>
        <tbody>
          {rows.map(([key, value]) => (
            <tr key={key}>
              <td className={styles.key}>{key}</td>
              <td className={styles.value}>{value || <em className={styles.empty}>—</em>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
