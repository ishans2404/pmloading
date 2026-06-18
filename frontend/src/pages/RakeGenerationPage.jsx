import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import AppShell from '../components/layout/AppShell.jsx'
import { fetchDestinations, generateRakeId, updateTramsId, fetchTramsRakeids } from '../api/index.js'
import { useToast } from '../context/ToastContext.jsx'
import Modal from '../components/shared/Modal.jsx'
import { isCoarsePointer } from '../utils/device.js'

export default function RakeGenerationPage() {
  const toast = useToast()
  const navigate = useNavigate()

  const [destinations, setDestinations] = useState([])
  const [loadingDests, setLoadingDests] = useState(true)
  const [dest1, setDest1]     = useState('')
  const [dest2, setDest2]     = useState('')
  const [generating, setGen]  = useState(false)
  const [result, setResult]   = useState(null) // { rakeId }
  const [tramsModal, setTramsModal] = useState(null)
  const [tramsInput, setTramsInput] = useState('')
  const [tramsLoading, setTramsLoading] = useState(false)
  const [tramsIds, setTramsIds] = useState([])
  const [tramsIdsLoading, setTramsIdsLoading] = useState(false)
  const [tramsDropdownOpen, setTramsDropdownOpen] = useState(false)
  const [copied, setCopied]   = useState(false)
  const [history, setHistory] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('bsp_rake_history') || '[]') } catch { return [] }
  })

  useEffect(() => {
    fetchDestinations()
      .then(d => setDestinations(d))
      .catch(() => toast.error('Failed to load destinations.'))
      .finally(() => setLoadingDests(false))
  }, [])

  async function handleGenerate() {
    if (!dest1) { toast.warning('Please select the primary destination.'); return }
    setGen(true)
    setResult(null)
    try {
      const data = await generateRakeId(dest1, dest2 || null)
      setResult(data)
      const entry = {
        rakeId: data.rakeId,
        dest1:  destLabel(dest1),
        dest1Code: dest1,
        dest2:  dest2 ? destLabel(dest2) : null,
        dest2Code: dest2 || null,
        at:     new Date().toISOString(),
      }
      const next = [entry, ...history].slice(0, 10)
      setHistory(next)
      sessionStorage.setItem('bsp_rake_history', JSON.stringify(next))
      toast.success({ title: 'Rake ID Generated', message: data.rakeId })
    } catch (err) {
      toast.error('Failed to generate Rake ID. Please try again.')
    } finally {
      setGen(false)
    }
  }

  function destLabel(code) {
    const d = destinations.find(x => x.code === code)
    return d ? `${d.name} (${d.code})` : code
  }

  async function handleUpdateTramsId() {
    if (!tramsInput.trim()) return
    setTramsLoading(true)
    try {
      const result = await updateTramsId(tramsModal.rakeId, tramsInput.trim())
      const status = String(result?.STATUS || '').toUpperCase()
      const message = result?.MESSAGE || 'TRAMS ID updated successfully.'

      if (status === 'TRUE') {
        toast.success({ title: 'TRAMS ID Updated', message })
        setTramsModal(null)
        setTramsInput('')
        return
      }

      toast.error(message)
    } catch (err) {
      toast.error(err?.message || 'Failed to update TRAMS ID.')
    } finally {
      setTramsLoading(false)
    }
  }

  function handleCopy() {
    if (!result?.rakeId) return
    navigator.clipboard.writeText(result.rakeId).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
      toast.success('Rake ID copied to clipboard')
    })
  }

  function handleStartLoading() {
    if (!result?.rakeId) return
    const primaryDest = destinations.find(d => d.code === dest1)
    const secondaryDest = dest2 ? destinations.find(d => d.code === dest2) : null

    navigate('/assign-wagons', {
      state: {
        prefillRakeId: String(result.rakeId),
        prefillDest: primaryDest || null,
        prefillRakeInfo: {
          rakeId: String(result.rakeId),
          status: 'ACTIVE',
          destinations: [
            ...(primaryDest ? [primaryDest] : []),
            ...(secondaryDest ? [secondaryDest] : []),
          ],
          totalWagons: null,
          createdAt: new Date().toISOString(),
        },
      },
    })
  }

  const dest2Options = destinations.filter(d => d.code !== dest1)

  return (
    <AppShell pageTitle="Rake Generation">
      <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Page header */}
        <div className="section-header">
          <div>
            <div className="section-title">Rake Generation</div>
            <div className="section-sub">Select destination(s) and generate a new Rake ID for the dispatch.</div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/home')}>
            <HomeIcon /> Dashboard
          </button>
        </div>

        {/* Main form card */}
        <div className="card">
          <div className="card-header">
            <div className="card-icon"><TrainIcon /></div>
            <div>
              <div className="card-title">New Rake Configuration</div>
              <div className="card-subtitle">Destination 1 is mandatory. Destination 2 is optional.</div>
            </div>
          </div>
          <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

            <div className="form-row">
              {/* Destination 1 */}
              <div className="form-group">
                <label className="form-label" htmlFor="dest1">
                  Destination 1 <span className="req">*</span>
                </label>
                {loadingDests ? (
                  <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 0' }}>
                    <span className="spinner spinner-sm" />
                    <span style={{ fontSize:12, color:'var(--text-muted)' }}>Loading destinations…</span>
                  </div>
                ) : (
                  <select
                    id="dest1"
                    className="form-control"
                    value={dest1}
                    onChange={e => { setDest1(e.target.value); setDest2(''); setResult(null) }}
                  >
                    <option value="">— Select primary destination —</option>
                    {destinations.map(d => (
                      <option key={d.code} value={d.code}>{d.name} ({d.code})</option>
                    ))}
                  </select>
                )}
                <span className="form-hint">Primary dispatch destination for this rake.</span>
              </div>

              {/* Destination 2 */}
              <div className="form-group">
                <label className="form-label" htmlFor="dest2">
                  Destination 2 <span style={{ color:'var(--text-muted)', fontWeight:400, fontSize:10 }}>&nbsp;(Optional)</span>
                </label>
                <select
                  id="dest2"
                  className="form-control"
                  value={dest2}
                  onChange={e => { setDest2(e.target.value); setResult(null) }}
                  disabled={!dest1 || loadingDests}
                >
                  <option value="">— None (single destination) —</option>
                  {dest2Options.map(d => (
                    <option key={d.code} value={d.code}>{d.name} ({d.code})</option>
                  ))}
                </select>
                <span className="form-hint">Only if this rake serves two destinations.</span>
              </div>
            </div>

            {/* Summary row */}
            {dest1 && (
              <div className="alert alert-info" style={{ fontSize: 12.5 }}>
                <InfoIcon />
                <span>
                  Rake will be dispatched to{' '}
                  <strong>{destLabel(dest1)}</strong>
                  {dest2 && <> and <strong>{destLabel(dest2)}</strong></>}.
                </span>
              </div>
            )}

          </div>
          <div className="card-footer">
            <button
              className="btn btn-primary btn-lg"
              onClick={handleGenerate}
              disabled={!dest1 || generating || loadingDests}
            >
              {generating
                ? <><span className="spinner spinner-sm" /> Generating Rake ID…</>
                : <><TrainIcon size={15} /> Generate Rake ID</>
              }
            </button>
            {dest1 && (
              <button className="btn btn-ghost btn-sm" onClick={() => { setDest1(''); setDest2(''); setResult(null) }}>
                Clear
              </button>
            )}
          </div>
        </div>

        {/* Result card */}
        {result && (
          <div className="card" style={{ border: '2px solid var(--navy-200)', animation: 'scaleIn 0.22s ease' }}>
            <div className="card-header" style={{ background: 'var(--navy-50)' }}>
              <div className="card-icon" style={{ background: 'var(--green-100)', color: 'var(--green-700)' }}>
                <CheckCircleIcon />
              </div>
              <div>
                <div className="card-title" style={{ color: 'var(--green-700)' }}>Rake ID Successfully Generated</div>
                <div className="card-subtitle">Use this Rake ID in Loading Operations.</div>
              </div>
              <span className="badge badge-success" style={{ marginLeft: 'auto' }}>
                <span className="badge-dot" />
                Active
              </span>
            </div>
            <div className="card-body">
              <div className="rakeid-display">
                <div style={{ flex: 1 }}>
                  <div className="rakeid-label">Rake ID</div>
                  <div className="rakeid-value">{result.rakeId}</div>
                </div>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={e => {
                    e.stopPropagation()
                    setTramsInput('')
                    setTramsDropdownOpen(false)
                    setTramsModal({ rakeId: result.rakeId })
                    if (tramsIds.length === 0) {
                      setTramsIdsLoading(true)
                      fetchTramsRakeids().then(items => setTramsIds(items)).finally(() => setTramsIdsLoading(false))
                    }
                  }}
                >
                  Update
                </button>
                <button className="btn btn-secondary btn-sm copy-btn" onClick={handleCopy}>
                  {copied ? <><CheckIcon size={13} /> Copied!</> : <><CopyIcon size={13} /> Copy</>}
                </button>
              </div>

              <div className="info-row" style={{ marginTop: 14 }}>
                <div className="info-item">
                  <span className="info-label">Primary Dest.</span>
                  <span className="info-value">{destLabel(dest1)}</span>
                </div>
                {dest2 && (
                  <div className="info-item">
                    <span className="info-label">Secondary Dest.</span>
                    <span className="info-value">{destLabel(dest2)}</span>
                  </div>
                )}
                <div className="info-item">
                  <span className="info-label">Generated at</span>
                  <span className="info-value">{new Date().toLocaleTimeString('en-IN')}</span>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
                <button className="btn btn-primary" onClick={handleStartLoading}>
                  <LoadIcon /> Start Loading Now
                </button>
                <button className="btn btn-ghost" onClick={() => navigate('/home')}>
                  <HomeIcon /> Go to Dashboard
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Recent history */}
        {history.length > 0 && (
          <div className="card">
            <div className="card-header">
              <div className="card-icon" style={{ background: 'var(--gray-100)', color: 'var(--gray-500)' }}>
                <HistoryIcon />
              </div>
              <div>
                <div className="card-title">Recent Rake IDs</div>
                <div className="card-subtitle">Generated during this session</div>
              </div>
              <button
                className="btn btn-ghost btn-sm"
                style={{ marginLeft: 'auto' }}
                onClick={() => { setHistory([]); sessionStorage.removeItem('bsp_rake_history') }}
              >
                Clear
              </button>
            </div>
            <div className="table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Rake ID</th>
                    <th>Destination 1</th>
                    <th>Destination 2</th>
                    <th>Generated At</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h, i) => (
                    <tr key={i}>
                      <td className="td-mono" style={{ fontWeight: 600 }}>{h.rakeId}</td>
                      <td>{h.dest1}</td>
                      <td>{h.dest2 || <span style={{color:'var(--text-muted)'}}>—</span>}</td>
                      <td style={{ color:'var(--text-secondary)', fontSize:12 }}>
                        {new Date(h.at).toLocaleString('en-IN', { dateStyle:'short', timeStyle:'short' })}
                      </td>
                      <td>
                        <button
                          className="btn btn-ghost btn-sm btn-icon"
                          onClick={() => {
                            navigator.clipboard.writeText(h.rakeId)
                            toast.success('Copied: ' + h.rakeId)
                          }}
                          title="Copy Rake ID"
                        >
                          <CopyIcon size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <Modal
          open={Boolean(tramsModal)}
          onClose={() => { setTramsModal(null); setTramsInput(''); setTramsDropdownOpen(false) }}
          title={`Update TRAMS ID - Rake ${tramsModal?.rakeId || ''}`}
          size="modal-cst"
          footer={
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
              <button className="btn btn-ghost btn-sm" onClick={() => { setTramsModal(null); setTramsInput(''); setTramsDropdownOpen(false) }}>Cancel</button>
              <button
                className="btn btn-primary btn-sm"
                onClick={handleUpdateTramsId}
                disabled={!tramsInput.trim() || tramsLoading}
              >
                {tramsLoading ? <><span className="spinner spinner-sm" /> Updating...</> : 'Update'}
              </button>
            </div>
          }
        >
          <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
            <div className="form-group" style={{ position:'relative' }}>
              <label className="form-label" htmlFor="trams-id-input">TRAMS ID</label>
              <div style={{ position:'relative' }}>
                <input
                  id="trams-id-input"
                  className="form-control mono"
                  placeholder={tramsIdsLoading ? 'Loading TRAMS IDs…' : 'Type or select TRAMS ID…'}
                  value={tramsInput}
                  onChange={e => { setTramsInput(e.target.value.toUpperCase()); setTramsDropdownOpen(true) }}
                  onFocus={() => setTramsDropdownOpen(true)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { setTramsDropdownOpen(false); handleUpdateTramsId() }
                    if (e.key === 'Escape') setTramsDropdownOpen(false)
                  }}
                  autoFocus={!isCoarsePointer()}
                  autoComplete="off"
                  disabled={tramsIdsLoading}
                />
                {tramsIdsLoading && (
                  <span className="spinner spinner-sm" style={{ position:'absolute', right:10, top:'50%', transform:'translateY(-50%)' }} />
                )}
              </div>
              {tramsDropdownOpen && !tramsIdsLoading && (() => {
                const q = tramsInput.trim()
                const filtered = tramsIds.filter(item => !q || String(item.trams_rakeid).includes(q))
                if (!filtered.length) return null
                return (
                  <div style={{
                    position:'absolute', top:'100%', left:0, right:0, zIndex:1000,
                    background:'var(--bg-surface)', border:'1px solid var(--border-default)',
                    borderRadius:'var(--r-md)', boxShadow:'var(--shadow-lg)',
                    maxHeight:200, overflowY:'auto', marginTop:2,
                  }}>
                    {filtered.slice(0, 50).map(item => (
                      <div
                        key={item.trams_rakeid}
                        onMouseDown={e => { e.preventDefault(); setTramsInput(item.trams_rakeid); setTramsDropdownOpen(false) }}
                        style={{
                          padding:'8px 12px', cursor:'pointer', fontSize:12.5,
                          fontFamily:'var(--font-mono)', fontWeight:600,
                          background: tramsInput === item.trams_rakeid ? 'var(--navy-50)' : 'transparent',
                          color:'var(--text-primary)',
                        }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--navy-50)'}
                        onMouseLeave={e => e.currentTarget.style.background = tramsInput === item.trams_rakeid ? 'var(--navy-50)' : 'transparent'}
                      >
                        <span>{item.trams_rakeid}</span>
                        <span style={{ marginLeft:8, fontSize:11.5, fontWeight:400, color:'var(--navy-20)' }}>{item.dest_cd}</span>
                      </div>
                    ))}
                  </div>
                )
              })()}
            </div>
            <div style={{ fontSize:12, color:'var(--text-muted)' }}>
              Rake ID: <strong style={{ fontFamily:'var(--font-mono)' }}>{tramsModal?.rakeId}</strong>
            </div>
          </div>
        </Modal>
      </div>
    </AppShell>
  )
}

// ── Icons ────────────────────────────────────────────────────────
function TrainIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="2" width="16" height="16" rx="2"/>
      <path d="M4 10h16"/>
      <path d="M8 18l-2 4M16 18l2 4"/>
      <circle cx="8.5" cy="14.5" r="1.5"/>
      <circle cx="15.5" cy="14.5" r="1.5"/>
    </svg>
  )
}
function CheckCircleIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/>
      <polyline points="22 4 12 14.01 9 11.01"/>
    </svg>
  )
}
function CopyIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2"/>
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
    </svg>
  )
}
function CheckIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  )
}
function InfoIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{flexShrink:0}}>
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="16" x2="12" y2="12"/>
      <line x1="12" y1="8" x2="12.01" y2="8"/>
    </svg>
  )
}
function HistoryIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="1 4 1 10 7 10"/>
      <path d="M3.51 15a9 9 0 102.13-9.36L1 10"/>
    </svg>
  )
}
function HomeIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
      <polyline points="9 22 9 12 15 12 15 22"/>
    </svg>
  )
}
function LoadIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>
      <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
      <line x1="12" y1="22.08" x2="12" y2="12"/>
    </svg>
  )
}
