import React, { useState, useRef, useEffect } from 'react'
import { fetchPlateInfoSearch } from '../../api/index.js'

export default function PlateSearchWidget() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const debounceRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const handler = e => { if (e.key === 'Escape') handleClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open])

  function handleOpen() {
    setOpen(true)
    setQuery('')
    setResults(null)
    setError('')
    setTimeout(() => inputRef.current?.focus(), 80)
  }

  function handleClose() {
    setOpen(false)
    if (debounceRef.current) clearTimeout(debounceRef.current)
  }

  async function handleSearch(val) {
    const upper = val.toUpperCase()
    setQuery(upper)
    setError('')
    setResults(null)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!upper.trim() || upper.trim().length < 6) return
    debounceRef.current = setTimeout(async () => {
      setLoading(true)
      try {
        const data = await fetchPlateInfoSearch(upper.trim())
        setResults(Array.isArray(data) ? data : [])
      } catch {
        setError('Search failed. Check your connection and try again.')
      } finally {
        setLoading(false)
      }
    }, 500)
  }

  return (
    <>
      <button
        onClick={handleOpen}
        title="Search Plates"
        aria-label="Open plate search"
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '5px 9px',
          borderRadius: 'var(--r-md, 5px)',
          background: 'none',
          border: '1px solid rgba(255,255,255,0.12)',
          color: 'rgba(255,255,255,0.8)',
          cursor: 'pointer',
          transition: 'all 150ms ease',
          flexShrink: 0,
        }}
        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; e.currentTarget.style.color = '#fff' }}
        onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'rgba(255,255,255,0.8)' }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
      </button>

      {/* Overlay + Panel */}
      {open && (
        <div
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(0,0,0,0.42)',
            zIndex: 9992,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            animation: 'fadeIn 0.18s ease',
          }}
          onClick={e => { if (e.target === e.currentTarget) handleClose() }}
        >
          <div style={{
            background: 'var(--bg-surface)',
            borderRadius: 'var(--r-xl)',
            boxShadow: 'var(--shadow-xl)',
            width: '100%',
            maxWidth: 520,
            maxHeight: '84dvh',
            display: 'flex',
            flexDirection: 'column',
            animation: 'scaleIn 0.2s ease',
          }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--border-subtle)' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              <span style={{ fontSize: 14, fontWeight: 600, flex: 1, color: 'var(--text-primary)' }}>Plate Search</span>
              <button
                onClick={handleClose}
                aria-label="Close"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4, borderRadius: 'var(--r-sm)', display: 'flex', alignItems: 'center', transition: 'color 0.15s' }}
                onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
                onMouseLeave={e => e.currentTarget.style.color = 'var(--text-muted)'}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>

            {/* Search input */}
            <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border-subtle)' }}>
              <input
                ref={inputRef}
                className="form-control mono"
                placeholder="Enter plate number (min. 6 chars)…"
                value={query}
                onChange={e => handleSearch(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                style={{ fontSize: 13.5 }}
              />
              {query.trim().length > 0 && query.trim().length < 6 && (
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 5 }}>Enter at least 6 characters to search.</div>
              )}
            </div>

            {/* Results */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '10px 18px 16px' }}>
              {loading && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '18px 0', color: 'var(--text-muted)', fontSize: 13 }}>
                  <span className="spinner spinner-sm" /> Searching…
                </div>
              )}
              {error && !loading && (
                <div style={{ color: 'var(--red-600)', fontSize: 12.5, padding: '8px 0' }}>{error}</div>
              )}
              {!loading && results !== null && results.length === 0 && (
                <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '18px 0', textAlign: 'center' }}>No plates found.</div>
              )}
              {!loading && results && results.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 4 }}>
                  {results.map((info, i) => {
                    const plateNo = String(info?.PLATE_NO || '').trim()
                    const grade = String(info?.GRADE || '').trim()
                    const heatNo = String(info?.HEAT_NO || '').trim()
                    const size = String(info?.PLATE_SIZE || '').trim()
                    const weight = info?.WGT ? parseFloat(info.WGT) : null
                    const tdc = String(info?.TDC || '').trim()
                    const mech = String(info?.MECH_RESULT || '').trim()
                    const consigneeNm = String(info?.CONSIGNEE_NM || '').trim()
                    const ordNo = String(info?.ORD_NO || '').trim()
                    const nextJob = String(info?.NEXT_JOB || '').trim()
                    const ordStatus = String(info?.ORD_STATUS || '').trim()
                    const loadingStatus = String(info?.LOADING_STATUS || '').trim()
                    const momPlateNo = String(info?.MOM_PLATE_NO || '').trim()

                    return (
                      <div key={plateNo || i} style={{
                        background: 'var(--bg-surface-2)',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: 'var(--r-md)',
                        padding: '10px 12px',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', marginBottom: 7 }}>
                          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 13.5, color: 'var(--navy-700)' }}>{plateNo || '—'}</span>
                          {mech && (
                            <span style={{
                              fontSize: 10, padding: '1px 6px', borderRadius: 'var(--r-full)', fontWeight: 700,
                              background: mech === 'OK' ? 'var(--green-100)' : 'var(--amber-100)',
                              color: mech === 'OK' ? 'var(--green-700)' : 'var(--amber-700)',
                            }}>{mech}</span>
                          )}
                          {loadingStatus && (
                            <span style={{ fontSize: 9.5, padding: '1px 5px', borderRadius: 'var(--r-full)', background: 'var(--amber-100)', color: 'var(--amber-700)', fontWeight: 600 }}>{loadingStatus}</span>
                          )}
                          {momPlateNo && momPlateNo !== plateNo && (
                            <span style={{ fontSize: 9.5, padding: '1px 5px', borderRadius: 'var(--r-full)', background: 'var(--gray-100)', color: 'var(--text-muted)', fontWeight: 500 }}>MOM: {momPlateNo}</span>
                          )}
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '4px 12px', fontSize: 12 }}>
                          {[
                            ['Grade', grade],
                            ['Heat No.', heatNo],
                            ['Size', size],
                            ['Weight', weight ? `${weight} T` : ''],
                            ['TDC', tdc],
                            ['Order', ordNo],
                            ['Consignee', consigneeNm],
                            ['Next Job', nextJob],
                            ['Status', ordStatus],
                          ].filter(([, val]) => val).map(([label, val]) => (
                            <div key={label}>
                              <span style={{ color: 'var(--text-muted)' }}>{label}: </span>
                              <span style={{ fontWeight: 600, fontFamily: ['Heat No.', 'Weight'].includes(label) ? 'var(--font-mono)' : 'inherit' }}>{val}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
              {!query && (
                <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '20px 0', textAlign: 'center', lineHeight: 1.6 }}>
                  Search any plate number to view its grade, heat info, and loading status.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}