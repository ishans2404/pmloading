import React, { useState, useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext.jsx'
import { ToastProvider } from './context/ToastContext.jsx'
import InstallPrompt          from './components/shared/InstallPrompt.jsx'
import LoginPage              from './pages/LoginPage.jsx'
import HomePage               from './pages/HomePage.jsx'
import RakeGenerationPage     from './pages/RakeGenerationPage.jsx'
import LoadingOperationsPage  from './pages/LoadingOperationsPage.jsx'
import LoadingReportPage      from './pages/LoadingReportPage.jsx'
import AssignWagonsPage       from './pages/AssignWagonsPage.jsx'

function RequireAuth({ children }) {
  const { user, loading } = useAuth()
  if (loading) {
    return (
      <div style={{ minHeight:'100dvh', display:'flex', alignItems:'center', justifyContent:'center' }}>
        <div style={{ textAlign:'center' }}>
          <div className="spinner spinner-lg" style={{ margin:'0 auto 12px' }} />
          <div style={{ fontSize:13, color:'var(--text-muted)' }}>Initialising…</div>
        </div>
      </div>
    )
  }
  return user ? children : <Navigate to="/login" replace />
}

export default function App() {
  // const [updateReady, setUpdateReady] = useState(false)
  // const [updateSW, setUpdateSW]       = useState(null)

  // useEffect(() => {
  //   function onUpdateAvailable(e) {
  //     setUpdateReady(true)
  //     if (e.detail?.updateSW) setUpdateSW(() => e.detail.updateSW)
  //   }
  //   window.addEventListener('pwa-update-available', onUpdateAvailable)
  //   return () => window.removeEventListener('pwa-update-available', onUpdateAvailable)
  // }, [])

  return (
    <AuthProvider>
      <ToastProvider>
        <Routes>
          <Route path="/login"              element={<LoginPage />} />
          <Route path="/home"               element={<RequireAuth><HomePage /></RequireAuth>} />
          <Route path="/rake-generation"    element={<RequireAuth><RakeGenerationPage /></RequireAuth>} />
          <Route path="/loading-operations" element={<RequireAuth><LoadingOperationsPage /></RequireAuth>} />
          <Route path="/assign-wagons"      element={<RequireAuth><AssignWagonsPage /></RequireAuth>} />
          <Route path="/loading-report"     element={<RequireAuth><LoadingReportPage /></RequireAuth>} />
          <Route path="*"                   element={<Navigate to="/home" replace />} />
        </Routes>

        {/*
          PWA install banner.
          Appears automatically when Chrome / Edge fires `beforeinstallprompt`.
          On Android this typically shows after the first visit; on desktop
          after a couple of visits once the site meets all PWA criteria.
        */}
        <InstallPrompt />
        {/* <UpdateBanner
          visible={updateReady}
          onUpdate={() => { if (updateSW) updateSW(true) }}
          onDismiss={() => setUpdateReady(false)}
        /> */}
      </ToastProvider>
    </AuthProvider>
  )
}

// // ── PWA update notification banner ────────────────────────────────
// // Shown when a new service worker is waiting to activate.
// // Styled to match the existing InstallPrompt design tokens.
// function UpdateBanner({ visible, onUpdate, onDismiss }) {
//   if (!visible) return null
//   return (
//     <div
//       role="alert"
//       aria-live="polite"
//       style={{
//         position:     'fixed',
//         bottom:       24,
//         left:         '50%',
//         transform:    'translateX(-50%)',
//         zIndex:       9998,
//         background:   'var(--navy-800, #152b52)',
//         color:        '#fff',
//         borderRadius: 'var(--r-lg, 8px)',
//         boxShadow:    'var(--shadow-xl, 0 12px 40px rgba(0,0,0,.4))',
//         padding:      '12px 14px',
//         display:      'flex',
//         alignItems:   'center',
//         gap:          12,
//         minWidth:     300,
//         maxWidth:     440,
//         width:        'calc(100vw - 32px)',
//         border:       '1px solid rgba(255,255,255,0.12)',
//         animation:    'slideUp 0.28s ease',
//       }}
//     >
//       {/* Refresh icon */}
//       <div style={{
//         width: 36, height: 36, flexShrink: 0,
//         background:   'var(--orange-500, #ea6b1a)',
//         borderRadius: 'var(--r-md, 5px)',
//         display: 'flex', alignItems: 'center', justifyContent: 'center',
//       }}>
//         <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff"
//           strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
//           <polyline points="23 4 23 10 17 10"/>
//           <polyline points="1 20 1 14 7 14"/>
//           <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
//         </svg>
//       </div>

//       {/* Text */}
//       <div style={{ flex: 1, minWidth: 0 }}>
//         <div style={{ fontWeight: 700, fontSize: 13, color: '#fff', lineHeight: 1.3 }}>
//           Update Available
//         </div>
//         <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.6)', marginTop: 2, lineHeight: 1.4 }}>
//           A new version is ready. Reload to apply.
//         </div>
//       </div>

//       {/* Reload button */}
//       <button
//         onClick={onUpdate}
//         style={{
//           flexShrink:   0,
//           background:   'var(--orange-500, #ea6b1a)',
//           color:        '#fff',
//           border:       'none',
//           borderRadius: 'var(--r-md, 5px)',
//           padding:      '7px 14px',
//           fontSize:     12.5,
//           fontWeight:   600,
//           cursor:       'pointer',
//           fontFamily:   'inherit',
//           whiteSpace:   'nowrap',
//           transition:   'background 0.15s',
//         }}
//         onMouseEnter={e => e.currentTarget.style.background = 'var(--orange-600, #d05b12)'}
//         onMouseLeave={e => e.currentTarget.style.background = 'var(--orange-500, #ea6b1a)'}
//       >
//         Reload
//       </button>

//       {/* Dismiss */}
//       <button
//         onClick={onDismiss}
//         aria-label="Dismiss update notification"
//         style={{
//           flexShrink: 0,
//           background: 'none',
//           border:     'none',
//           color:      'rgba(255,255,255,0.4)',
//           cursor:     'pointer',
//           padding:    '2px 4px',
//           fontSize:   20,
//           lineHeight: 1,
//           fontFamily: 'inherit',
//           transition: 'color 0.15s',
//         }}
//         onMouseEnter={e => e.currentTarget.style.color = '#fff'}
//         onMouseLeave={e => e.currentTarget.style.color = 'rgba(255,255,255,0.4)'}
//       >
//         ×
//       </button>
//     </div>
//   )
// }
