// (c) William Li 2026
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { LangProvider } from './i18n.jsx'
import { NumberBaseProvider } from './numberBase.jsx'
import { initAnalytics } from './lib/analytics.js'

initAnalytics()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <LangProvider>
      <NumberBaseProvider>
        <App />
      </NumberBaseProvider>
    </LangProvider>
  </StrictMode>
)
