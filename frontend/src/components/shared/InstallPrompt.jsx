import React, { useState, useEffect } from 'react'

/**
 * Listens for the browser's `beforeinstallprompt` event and renders a
 * bottom banner giving the user a one-tap "Install" action.
 *
 * Dismiss state is persisted to localStorage so the banner does not
 * reappear after the user explicitly declines.
 */
export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null)
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem('bsp_pwa_dismissed') === '1' } catch { return false }
  })
  const [installed, setInstalled] = useState(false)

  useEffect(() => {
    // Hide if already running as a standalone PWA
    if (window.matchMedia('(display-mode: standalone)').matches) {
      setInstalled(true)
      return
    }

    const onPrompt = (e) => {
      e.preventDefault()        // suppress Chrome's automatic mini-infobar
      setDeferredPrompt(e)
    }

    const onInstalled = () => {
      setInstalled(true)
      setDeferredPrompt(null)
    }

    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  if (!deferredPrompt || dismissed || installed) return null

  async function handleInstall() {
    deferredPrompt.prompt()
    const { outcome } = await deferredPrompt.userChoice
    setDeferredPrompt(null)
    if (outcome === 'dismissed') handleDismiss()
  }

  function handleDismiss() {
    setDismissed(true)
    try { localStorage.setItem('bsp_pwa_dismissed', '1') } catch {}
  }

  return (
    <div
      role="dialog"
      aria-label="Install app"
      style={{
        position:     'fixed',
        bottom:       24,
        left:         '50%',
        transform:    'translateX(-50%)',
        zIndex:       9998,
        background:   'var(--navy-900, #0f1f3d)',
        color:        '#fff',
        borderRadius: 'var(--r-lg, 8px)',
        boxShadow:    'var(--shadow-xl, 0 12px 40px rgba(0,0,0,.4))',
        padding:      '12px 14px',
        display:      'flex',
        alignItems:   'center',
        gap:          12,
        minWidth:     300,
        maxWidth:     420,
        width:        'calc(100vw - 32px)',
        animation:    'slideUp 0.28s ease',
        border:       '1px solid rgba(255,255,255,0.1)',
      }}
    >
      {/* Brand mark */}
      <div style={{
        width:        40,
        height:       40,
        flexShrink:   0,
        background:   'var(--orange-500, #ea6b1a)',
        borderRadius: 'var(--r-md, 5px)',
        display:      'flex',
        alignItems:   'center',
        justifyContent: 'center',
        fontWeight:   800,
        fontSize:     11,
        letterSpacing: '-0.02em',
        color:        '#fff',
        fontFamily:   'var(--font-mono, monospace)',
        userSelect:   'none',
      }}>
        BSP
      </div>

      {/* Text */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13, lineHeight: 1.3, color: '#fff' }}>
          Install BSP Loading App
        </div>
        <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.55)', marginTop: 3, lineHeight: 1.4 }}>
          Works offline · quick home-screen access
        </div>
      </div>

      {/* Install button */}
      <button
        onClick={handleInstall}
        style={{
          flexShrink:   0,
          background:   'var(--orange-500, #ea6b1a)',
          color:        '#fff',
          border:       'none',
          borderRadius: 'var(--r-md, 5px)',
          padding:      '8px 16px',
          fontSize:     12.5,
          fontWeight:   600,
          cursor:       'pointer',
          fontFamily:   'inherit',
          whiteSpace:   'nowrap',
          transition:   'background 0.15s',
        }}
        onMouseEnter={e => e.currentTarget.style.background = 'var(--orange-600, #d05b12)'}
        onMouseLeave={e => e.currentTarget.style.background = 'var(--orange-500, #ea6b1a)'}
      >
        Install
      </button>

      {/* Dismiss */}
      <button
        onClick={handleDismiss}
        aria-label="Dismiss install prompt"
        style={{
          flexShrink:  0,
          background:  'none',
          border:      'none',
          color:       'rgba(255,255,255,0.4)',
          cursor:      'pointer',
          padding:     '2px 4px',
          fontSize:    20,
          lineHeight:  1,
          fontFamily:  'inherit',
          transition:  'color 0.15s',
        }}
        onMouseEnter={e => e.currentTarget.style.color = '#fff'}
        onMouseLeave={e => e.currentTarget.style.color = 'rgba(255,255,255,0.4)'}
      >
        ×
      </button>
    </div>
  )
}