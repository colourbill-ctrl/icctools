// (c) 2026 William Li
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { LangProvider } from './i18n.jsx'
import { NumberBaseProvider } from './numberBase.jsx'

// Render first, unconditionally. Nothing in the app's mount path may depend on
// analytics — see the dynamic import below.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <LangProvider>
      <NumberBaseProvider>
        <App />
      </NumberBaseProvider>
    </LangProvider>
  </StrictMode>
)

// Analytics is loaded lazily and defensively, AFTER render. A content blocker
// (uBlock / Brave shields / etc.) blocks lib/analytics.js with
// ERR_BLOCKED_BY_CLIENT because its path matches ad-filter lists — and a *static*
// import of it would take the whole ES-module graph down with it, so React would
// never mount (a blank "Loading the app…" page in any browser with a blocker).
// A caught dynamic import keeps that failure fully contained: if it's blocked or
// fails to load, the app simply runs without GA.
import('./lib/analytics.js')
  .then((m) => m.initAnalytics())
  .catch(() => { /* analytics blocked/unavailable — run without it */ })
