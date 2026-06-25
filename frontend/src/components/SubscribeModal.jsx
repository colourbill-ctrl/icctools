// (c) 2026 William Li
import { useEffect, useRef, useState } from 'react'
import { useT } from '../i18n.jsx'
import styles from './SubscribeModal.module.css'

// Mirrors chardata's subscribe modal (public/index.html). Same WordPress
// admin-ajax endpoint and `cb_subscribe` action; the only difference is the
// hidden `source` field, which is 'profiletool' here so colourbill.com can
// attribute the signup (the server-side handler must allow-list 'profiletool',
// the same way the contact handler already does).
function subscribeEndpoint() {
  const h = window.location.hostname
  if (h === 'localhost' || h === '127.0.0.1') {
    // Local dev: WordPress runs separately from the Vite dev server. Override
    // with window.__cbSubEndpoint before opening if your WP port differs.
    return window.__cbSubEndpoint || 'http://localhost:8000/wp-admin/admin-ajax.php'
  }
  // Post straight to www — the apex 301-redirect drops the CORS headers, so a
  // redirected request is aborted by the browser before it reaches WP.
  return 'https://www.colourbill.com/wp-admin/admin-ajax.php'
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default function SubscribeModal({ open, onClose }) {
  const t = useT()
  const formRef = useRef(null)
  const emailRef = useRef(null)
  const t0Ref = useRef(0)
  const [status, setStatus] = useState(null) // { msg, kind } | null
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)

  // Reset + stamp the time-trap whenever the modal opens, then focus the email
  // field (deferred so iOS doesn't fight the open transition).
  useEffect(() => {
    if (!open) return
    setStatus(null)
    setDone(false)
    setSubmitting(false)
    t0Ref.current = Date.now()
    const id = setTimeout(() => emailRef.current?.focus(), 50)
    return () => clearTimeout(id)
  }, [open])

  // Close on Escape while open.
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  async function handleSubmit(e) {
    e.preventDefault()
    setStatus(null)
    const email = (emailRef.current?.value || '').trim()
    if (!EMAIL_RE.test(email)) {
      setStatus({ msg: t('sub_err_email'), kind: 'error' })
      emailRef.current?.focus()
      return
    }
    setSubmitting(true)
    const data = new FormData(formRef.current)
    data.append('action', 'cb_subscribe')
    try {
      const res = await fetch(subscribeEndpoint(), {
        method: 'POST',
        body: data,
        credentials: 'omit', // public endpoint; keeps the request CORS-safelisted
      })
      let json = null
      try { json = await res.json() } catch { /* non-JSON response */ }
      if (res.ok && json && json.success) {
        setDone(true)
      } else {
        const msg = (json && json.data && json.data.message) ||
          (res.status === 429 ? t('sub_err_rate') :
           res.status === 400 ? t('sub_err_form') :
           t('sub_err_send'))
        setStatus({ msg, kind: 'error' })
        setSubmitting(false)
      }
    } catch {
      setStatus({ msg: t('sub_err_network'), kind: 'error' })
      setSubmitting(false)
    }
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}
           role="dialog" aria-modal="true" aria-labelledby="subscribe-title">
        <div className={styles.head}>
          <span id="subscribe-title" className={styles.headTitle}>{t('sub_title')}</span>
          <button type="button" className={styles.closeX} onClick={onClose}
                  aria-label={t('sub_close')}>&#10005;</button>
        </div>

        {done ? (
          <div className={styles.thanks}>
            <div className={styles.thanksCheck}>&#10003;</div>
            <div className={styles.thanksTitle}>{t('sub_thanks_title')}</div>
            <p className={styles.thanksBody}>{t('sub_thanks_body')}</p>
            <button type="button" className={styles.btnSecondary} onClick={onClose}>
              {t('sub_close_btn')}
            </button>
          </div>
        ) : (
          <form ref={formRef} className={styles.form} onSubmit={handleSubmit}>
            <input type="hidden" name="source" value="profiletool" />
            {/* Time-trap: bots that submit instantly are filtered server-side. */}
            <input type="hidden" name="t0" value={t0Ref.current} />

            <div className={styles.body}>{t('sub_body')}</div>

            <label className={styles.field}>
              <span>{t('sub_email_label')}</span>
              <input ref={emailRef} type="email" name="email" required
                     autoComplete="email" placeholder={t('sub_email_ph')} />
            </label>

            <label className={styles.field}>
              <span>{t('sub_note_label')} <span className={styles.optional}>{t('sub_optional')}</span></span>
              <input type="text" name="note" maxLength={120} placeholder={t('sub_note_ph')} />
            </label>

            {/* Honeypot — hidden from users, tempting to bots. */}
            <div aria-hidden="true" className={styles.honeypot}>
              <label>Website<input type="text" name="website" tabIndex={-1} autoComplete="off" /></label>
            </div>

            <label className={styles.consent}>
              <input type="checkbox" name="consent" required />
              <span>
                {t('sub_consent')}{' '}
                <a href="https://www.colourbill.com/privacy/" target="_blank" rel="noopener">
                  {t('sub_privacy_link')}</a>.
              </span>
            </label>

            <div className={styles.actions}>
              <button type="button" className={styles.btnSecondary} onClick={onClose}>
                {t('sub_cancel')}
              </button>
              <button type="submit" className={styles.btnPrimary} disabled={submitting}>
                {t('sub_submit')}
              </button>
            </div>

            {status && (
              <div className={`${styles.status} ${status.kind === 'error' ? styles.statusError : styles.statusOk}`}
                   role="status" aria-live="polite">
                {status.msg}
              </div>
            )}
          </form>
        )}
      </div>
    </div>
  )
}
