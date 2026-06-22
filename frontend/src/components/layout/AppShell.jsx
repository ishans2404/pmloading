import React, { useState, useEffect, useRef } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import PlateSearchWidget from '../shared/PlateSearchWidget.jsx'
import { useAuth } from '../../context/AuthContext.jsx'

const NAV_ITEMS = [
  {
    section: 'Overview',
    items: [
      { path: '/home', label: 'Dashboard', icon: IconHome },
    ]
  },
  {
    section: 'Operations',
    items: [
      { path: '/rake-generation',    label: 'Rake Generation',    icon: IconRake },
      { path: '/assign-wagons',      label: 'Assign Wagons',      icon: IconWagon },
      { path: '/loading-operations', label: 'Loading Operations', icon: IconLoad },
      { path: '/loading-report',  label: 'Loading Report',  icon: IconTable },
    ]
  }
]

export default function AppShell({ children, pageTitle }) {
  const { user, logout } = useAuth()
  const location = useLocation()
  
  // Initialize collapsed state: open only on HomePage, closed on all other pages
  const isHomePage = location.pathname === '/home'
  const [collapsed, setCollapsed] = useState(!isHomePage)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const userMenuRef = useRef(null)

  // Close mobile sidebar on route change and reset collapsed state based on page
  useEffect(() => {
    setMobileOpen(false)
    setCollapsed(!isHomePage)
  }, [location.pathname, isHomePage])

  useEffect(() => {
    if (!userMenuOpen) return
    function handleOutside(e) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) setUserMenuOpen(false)
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [userMenuOpen])

  // Detect connectivity status
  useEffect(() => {
    const handleOnline = () => setIsOnline(true)
    const handleOffline = () => setIsOnline(false)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  // Detect small screen for auto-collapse
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1024px)')
    if (mq.matches) setCollapsed(true)
    const handler = e => { if (!e.matches) setMobileOpen(false) }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  function handleLogout() {
    if (window.confirm('Sign out of BSP Plate Loading System?')) logout()
  }

  return (
    <div className="app-shell">
      {/* Mobile overlay */}
      <div
        className={`sidebar-overlay ${mobileOpen ? 'visible' : ''}`}
        onClick={() => setMobileOpen(false)}
      />

      {/* Sidebar */}
      <aside className={`sidebar ${collapsed ? 'collapsed' : ''} ${mobileOpen ? 'mobile-open' : ''}`}>
        <div className="sidebar-brand">
          <img
            src="/pmloading/sail-logo.png"
            alt="SAIL"
            style={{
              width: 30,
              height: 30,
              objectFit: 'contain',
              borderRadius: 'var(--r-sm)',
              flexShrink: 0,
              filter: 'brightness(0) invert(1)'
            }}
          />          
          {!collapsed && (
            <div className="sidebar-brand-text">
              <span className="sidebar-brand-title">BHILAI STEEL</span>
              <span className="sidebar-brand-subtitle">Plate Mill · Loading</span>
            </div>
          )}
        </div>

        <nav className="sidebar-nav">
          {NAV_ITEMS.map(({ section, items }) => (
            <div key={section}>
              <div className="sidebar-section-label">{section}</div>
              {items.map(({ path, label, icon: Icon }) => (
                <NavLink
                  key={path}
                  to={path}
                  className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`}
                  title={label}
                >
                  <Icon size={16} />
                  {!collapsed && <span>{label}</span>}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

      </aside>

      {/* Main area */}
      <div className="main-area">
        {/* Top bar */}
        <header className="topbar">
          <button
            className="topbar-toggle"
            onClick={() => {
              if (window.innerWidth <= 1024) {
                setMobileOpen(o => { if (!o) setCollapsed(false); return !o })
              } else {
                setCollapsed(c => !c)
              }
            }}
            aria-label="Toggle sidebar"
          >
            <IconMenu size={18} />
          </button>

          <div className="topbar-breadcrumb">
            <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12 }}>Plate Mill</span>
            <span className="sep">›</span>
            <span className="page-title">{pageTitle || 'Dashboard'}</span>
          </div>

          <div className="topbar-actions">
            <PlateSearchWidget />
            <div className="topbar-chip">
              <span className={`dot ${isOnline ? 'online' : 'offline'}`} />
              System {isOnline ? 'Online' : 'Offline'}
            </div>
            <div ref={userMenuRef} style={{ position: 'relative' }}>
              <button
                className="topbar-user-btn"
                onClick={() => setUserMenuOpen(o => !o)}
                aria-label="User menu"
                aria-expanded={userMenuOpen}
              >
                <div className="topbar-avatar">
                  {(user?.displayName || user?.username || 'A')[0].toUpperCase()}
                </div>
                <span>{user?.displayName || user?.username}</span>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ opacity: 0.55, marginLeft: 2, flexShrink: 0 }}>
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </button>
              {userMenuOpen && (
                <div style={{
                  position: 'absolute', right: 0, top: 'calc(100% + 6px)',
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--r-lg)',
                  boxShadow: 'var(--shadow-lg)',
                  minWidth: 186,
                  zIndex: 500,
                  overflow: 'hidden',
                  animation: 'scaleIn 0.15s ease',
                }}>
                  <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-subtle)' }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                      {user?.displayName || user?.username}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 1 }}>Operator</div>
                  </div>
                  <button
                    onClick={() => { setUserMenuOpen(false); handleLogout() }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      width: '100%', padding: '10px 14px',
                      background: 'none', border: 'none',
                      cursor: 'pointer', fontSize: 13,
                      color: 'var(--red-600)',
                      transition: 'background 0.15s',
                      fontFamily: 'inherit',
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--red-50)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'none'}
                  >
                    <IconLogout size={14} />
                    Sign Out
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="page-content">{children}</main>
      </div>
    </div>
  )
}

// ── Inline SVG icons ─────────────────────────────────────────────
function IconHome({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
      <polyline points="9 22 9 12 15 12 15 22"/>
    </svg>
  )
}
function IconRake({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="4" rx="1"/>
      <rect x="2" y="9" width="20" height="4" rx="1"/>
      <rect x="2" y="15" width="20" height="4" rx="1"/>
    </svg>
  )
}
function IconLoad({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>
      <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
      <line x1="12" y1="22.08" x2="12" y2="12"/>
    </svg>
  )
}
function IconWagon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="3" width="15" height="13" rx="1"/>
      <path d="M16 8h4l3 3v5h-7V8z"/>
      <circle cx="5.5" cy="18.5" r="2.5"/>
      <circle cx="18.5" cy="18.5" r="2.5"/>
    </svg>
  )
}
function IconTable({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
      <line x1="3" y1="9" x2="21" y2="9"/>
      <line x1="3" y1="15" x2="21" y2="15"/>
      <line x1="9" y1="9" x2="9" y2="21"/>
    </svg>
  )
}
function IconEdit({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>
  )
}
function IconLogout({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
      <polyline points="16 17 21 12 16 7"/>
      <line x1="21" y1="12" x2="9" y2="12"/>
    </svg>
  )
}
function IconMenu({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="3" y1="6" x2="21" y2="6"/>
      <line x1="3" y1="12" x2="21" y2="12"/>
      <line x1="3" y1="18" x2="21" y2="18"/>
    </svg>
  )
}
