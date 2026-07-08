import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Dev-only store-write tracer (Phase 4.1a diagnostics). Dynamic import
// keeps it out of the production bundle entirely.
if (import.meta.env.DEV) {
  import('./utils/devStoreTrace.js').then((m) => m.installDevStoreTrace())
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
