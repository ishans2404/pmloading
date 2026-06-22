import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import './index.css'
// import { registerSW } from 'virtual:pwa-register'

// // Register the service worker with manual update control.
// // onNeedRefresh fires when a new SW version is waiting to activate.
// // We broadcast a plain DOM event so App.jsx can show a non-blocking
// // banner without coupling this module to React state.
// let updateSWFn

// updateSWFn = registerSW({
//   onNeedRefresh() {
//     window.dispatchEvent(
//       new CustomEvent('pwa-update-available', { detail: { updateSW: updateSWFn } })
//     )
//   },
//   onOfflineReady() {
//     // App cached for offline use — silent, no UI needed here.
//   },
//   onRegistered(registration) {
//     if (!registration) return
//     // TWAs run as long-lived SPAs with no full page navigations, so the
//     // browser never naturally re-fetches sw.js.  Poll every 30 min to
//     // catch new builds while the app is open.
//     setInterval(() => { registration.update() }, 30 * 60 * 1000)
//     // Check immediately whenever the TWA is brought back to the foreground.
//     document.addEventListener('visibilitychange', () => {
//       if (document.visibilityState === 'visible') registration.update()
//     }, { passive: true })
//   },
//   onRegisterError(error) {
//     console.error('SW registration failed:', error)
//   },
// })

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter basename="/pmloading">
      <App />
    </BrowserRouter>
  </React.StrictMode>
)
