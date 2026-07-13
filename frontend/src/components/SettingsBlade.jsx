// (c) 2026 William Li
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLang, LANG_OPTIONS, systemLangNative } from '../i18n.jsx'
import { useNumberBase } from '../numberBase.jsx'
import styles from './SettingsBlade.module.css'

// Help opens the in-app guide pane (GuidePanel), which renders the same content
// generated from MANUAL.md into help.html by scripts/generate-help.js. The opener
// is passed down from App as onOpenHelp.
// Contact opens colourbill.com's modal with profiletool as the source, so
// submissions are attributed to profiletool in the form's hidden source field.
// The colourbill.com handler allow-lists 'chardata' and 'profiletool'.
const CONTACT_URL = 'https://www.colourbill.com/?contact=profiletool'

// Detect mobile by viewport width. The threshold matches the 720 px media
// query used across the rest of profiletool (layout, header table, tag table,
// profile viewer) and chardata's own ICC viewer breakpoint. The blade
// defaults to collapsed on mobile so the main content isn't covered.
function isMobile() {
  return typeof window !== 'undefined' && window.innerWidth <= 720
}

function readTheme() {
  return localStorage.getItem('profiletool.bgTheme') || 'system'
}

function applyTheme(theme) {
  let dark
  if (theme === 'system') {
    dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  } else {
    dark = theme === 'dark'
  }
  document.body.classList.toggle('dark', dark)
  // Also set an explicit `light` marker so the in-app user-guide diagrams (whose
  // <style> keys dark off `body.dark` and guards the OS media query with
  // `body:not(.light)`) follow the app theme, not the OS — a light app on a
  // dark-OS machine keeps light diagrams. index.css itself only reads body.dark,
  // so this class is otherwise inert.
  document.body.classList.toggle('light', !dark)
}

export default function SettingsBlade({ onOpenHelp }) {
  const { lang, setLang, t } = useLang()
  const { base, setBase }    = useNumberBase()
  const [theme, setTheme]       = useState(readTheme)
  const [collapsed, setCollapsed] = useState(() =>
    isMobile() || localStorage.getItem('profiletool.bladeCollapsed') === '1'
  )

  // Theme: apply on mount + whenever it changes; subscribe to system theme
  // changes only while the user has picked "system" (matches chardata).
  useEffect(() => {
    applyTheme(theme)
    if (theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])

  // Body padding adapts to blade width so the centered .layout never slides
  // under the floating tab buttons or the open panel. Mobile drawer skips
  // this (it overlays on top of dimmed content).
  useEffect(() => {
    document.body.classList.toggle('blade-open', !collapsed)
    document.body.classList.toggle('blade-collapsed', collapsed)
    return () => {
      document.body.classList.remove('blade-open', 'blade-collapsed')
    }
  }, [collapsed])

  const onThemeChange = useCallback((v) => {
    setTheme(v)
    localStorage.setItem('profiletool.bgTheme', v)
  }, [])

  const toggleBlade = useCallback(() => {
    setCollapsed(c => {
      const next = !c
      localStorage.setItem('profiletool.bladeCollapsed', next ? '1' : '0')
      return next
    })
  }, [])

  // The "System default (…)" option label shows which OS locale System would
  // resolve to — recomputed each render so a navigator.language change picks up.
  const systemLabel = useMemo(() => `${t('system_default')} (${systemLangNative()})`, [t])

  // Mobile drawer: tapping outside should close. Implement with a backdrop div
  // that mounts only while expanded on mobile.
  const dialogRef = useRef(null)
  const isExpandedMobile = !collapsed && isMobile()

  return (
    <>
      <aside
        className={`${styles.blade} ${collapsed ? styles.collapsed : ''}`}
        aria-label={t('settings')}
        ref={dialogRef}
      >
        <div className={styles.tabs}>
          <button
            className={styles.tabBtn}
            onClick={toggleBlade}
            title={t('settings')}
            aria-label={t('settings')}
            aria-expanded={!collapsed}
            type="button"
          >
            <span className={styles.tabArrow}>{collapsed ? '‹' : '›'}</span>
            <span className={styles.tabIcon}>{'⚙︎'}</span>
          </button>
          <button
            className={styles.tabBtn}
            onClick={onOpenHelp}
            title={t('help')}
            aria-label={t('help')}
            type="button"
          >
            ?
          </button>
          <button
            className={styles.tabBtn}
            onClick={() => window.open(CONTACT_URL, '_blank', 'noopener')}
            title={t('contact')}
            aria-label={t('contact')}
            type="button"
          >
            {'✉'}
          </button>
        </div>

        <div className={styles.content}>
          <div className={styles.heading}>{t('settings')}</div>

          <div className={styles.sectionLabel}>{t('display')}</div>

          <div className={styles.section}>
            <div className={styles.label}>{t('background')}</div>
            <select
              className={styles.select}
              value={theme}
              onChange={(e) => onThemeChange(e.target.value)}
            >
              <option value="system">{t('system')}</option>
              <option value="light">{t('light')}</option>
              <option value="dark">{t('dark')}</option>
            </select>
          </div>

          <div className={styles.section}>
            <div className={styles.label}>{t('number_format')}</div>
            <select
              className={styles.select}
              value={base}
              onChange={(e) => setBase(e.target.value)}
            >
              <option value="hex">{t('hex')}</option>
              <option value="dec">{t('decimal')}</option>
            </select>
          </div>

          <div className={styles.section}>
            <div className={styles.label}>{t('language')}</div>
            <select
              className={styles.select}
              value={lang}
              onChange={(e) => setLang(e.target.value)}
            >
              <option value="system">{systemLabel}</option>
              <option disabled>──────────────</option>
              {LANG_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        </div>
      </aside>

      {isExpandedMobile && (
        <div
          className={styles.mobileBackdrop}
          onClick={toggleBlade}
          aria-hidden="true"
        />
      )}

      <button
        className={styles.mobileHamburger}
        onClick={toggleBlade}
        title={t('settings')}
        aria-label={t('settings')}
        type="button"
      >
        {'⚙︎'}
      </button>
      <button
        className={styles.mobileHelp}
        onClick={onOpenHelp}
        title={t('help')}
        aria-label={t('help')}
        type="button"
      >
        ?
      </button>
      <button
        className={styles.mobileContact}
        onClick={() => window.open(CONTACT_URL, '_blank', 'noopener')}
        title={t('contact')}
        aria-label={t('contact')}
        type="button"
      >
        {'✉'}
      </button>
    </>
  )
}
