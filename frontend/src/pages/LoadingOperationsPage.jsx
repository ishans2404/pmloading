import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useLocation } from 'react-router-dom'
import AppShell from '../components/layout/AppShell.jsx'
import Modal from '../components/shared/Modal.jsx'
import { fetchRakeInfo, fetchLoadingReport, fetchPlateInfo, fetchPlateInfoSearch, submitWagonLoad, fetchLoadedDetails, fetchWagonsByRake, publishBalUpdate, createBalUpdateStream, publishPlateLock, createPlateLockStream } from '../api/index.js'
import { generateLoadingPdf, generateProgressReport, buildWagonPayloads, submitWagonRequests } from '../utils/export.js'
import { useToast } from '../context/ToastContext.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { isCoarsePointer } from '../utils/device.js'

const SESSION_KEY      = 'bsp_loading_session'
const SESSIONS_MAP_KEY = 'bsp_sessions_map'

function loadSavedSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null') } catch { return null }
}

function loadSavedSessionsMap() {
  try { return JSON.parse(localStorage.getItem(SESSIONS_MAP_KEY) || 'null') } catch { return null }
}

function saveSession(s) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)) } catch {}
}

const PLATE_TYPE_CFG = {
  OK: { label: 'OK', bg: null, color: null, desc: 'Ready to load' },
  RA: { label: 'RA', bg: 'var(--amber-100)', color: 'var(--amber-700)', desc: 'Result Awaited' },
  TPI: { label: 'TPI', bg: 'var(--sky-100)', color: 'var(--sky-600)', desc: 'Third Party Inspection' },
  MTI: { label: 'MTI', bg: 'var(--orange-100)', color: 'var(--orange-700)', desc: 'MTI Hold' },
  DIV: { label: 'DIV', bg: 'var(--gray-100)', color: 'var(--gray-700)', desc: 'Diversion' },
  ZCMO: { label: 'ZCMO', bg: 'var(--navy-100)', color: 'var(--navy-700)', desc: 'ZCMO Plates' },
}

function cleanCode(value) {
  return String(value ?? '').trim().toUpperCase()
}

function cleanPlateNo(value) {
  const plateNo = cleanCode(value)
  return plateNo.startsWith('OK-') ? plateNo.slice(3) : plateNo
}

function getLoadedDetailDestCode(row) {
  return cleanCode(row?.WAGON_DEST_CD ?? row?.destinationCode ?? row?.destCode ?? row?.DEST_CD ?? row?.DESTCD)
}

function getLoadedDetailConsigneeCode(row) {
  return cleanCode(row?.DISPATCH_CD ?? row?.consigneeCode ?? row?.consigneeCd ?? row?.CONSIGNEE_CD ?? row?.CONSIGNEE_CODE)
}

function getLoadedDetailPlateNo(row) {
  return cleanPlateNo(row?.CHILD_PLATE_NO ?? row?.childPlateNo ?? row?.plateNo ?? row?.PLATE_NO)
}

function getLoadedDetailWagonNo(row) {
  return cleanCode(row?.DISPATCH_NM ?? row?.wagonNo ?? row?.wagon ?? row?.WAGON_NO)
}

function loadedDetailKey(destCode, consigneeCode, plateNo) {
  const dest = cleanCode(destCode)
  const consignee = cleanCode(consigneeCode)
  const plate = cleanPlateNo(plateNo)
  return dest && consignee && plate ? `${dest}|${consignee}|${plate}` : null
}

function applyLoadedDetails(consignees, destCode, loadedRaw) {
  if (!Array.isArray(loadedRaw) || loadedRaw.length === 0) return consignees

  // Use plateNo as the sole map key — plate numbers are unique physical identifiers.
  // A composite key including destCode/consigneeCode fails silently whenever
  // WAGON_DEST_CD is absent or formatted differently, causing the early-return
  // guard (map.size === 0) to skip all injection.
  const loadedMap = new Map() // plateNo -> { wagonNo, consigneeCode }
  for (const row of loadedRaw) {
    const rowDest  = cleanCode(row?.WAGON_DEST_CD ?? row?.destinationCode ?? row?.destCode ?? row?.DEST_CD ?? '')
    const rowCons  = cleanCode(row?.DISPATCH_CD   ?? row?.consigneeCode   ?? row?.CONSIGNEE_CD ?? '')
    const rowPlate = cleanPlateNo(row?.CHILD_PLATE_NO ?? row?.childPlateNo ?? row?.plateNo ?? row?.PLATE_NO ?? '')
    const rowWagon = cleanCode(row?.DISPATCH_NM   ?? row?.wagonNo ?? row?.WAGON_NO ?? '')

    if (!rowPlate || !rowWagon) continue
    // Skip rows that explicitly belong to a different destination
    if (rowDest && destCode && rowDest !== destCode) continue
    if (!loadedMap.has(rowPlate)) {
      loadedMap.set(rowPlate, { wagonNo: rowWagon, consigneeCode: rowCons })
    }
  }

  if (loadedMap.size === 0) return consignees

  const handledPlates = new Set()

  // Pass 1: mark plates that exist in the loaderReport list as loaded
  const result = consignees.map(c => ({
    ...c,
    plates: c.plates.map(p => {
      const info = loadedMap.get(p.plateNo)
      if (info) {
        handledPlates.add(p.plateNo)
        return { ...p, loaded: true, loadedAt: new Date().toISOString(), wagonNo: info.wagonNo }
      }
      return p
    }),
  }))

  // Pass 2: inject plates from getLoadedDet that were not in the loaderReport list at all
  for (const [plateNo, info] of loadedMap) {
    if (handledPlates.has(plateNo)) continue

    const { wagonNo, consigneeCode } = info
    if (!consigneeCode) continue

    const consignee = result.find(c => c.consigneeCode === consigneeCode)
    if (!consignee) continue

    if (!consignee.plates.some(p => p.plateNo === plateNo)) {
      consignee.plates.push({
        plateNo,
        heatNo:    '',
        plateType: 'OK',
        ordNo:     '',
        grade:     '',
        tdc:       '',
        colourCd:  '',
        ordSize:   '',
        pcWgt:     null,
        loaded:    true,
        loadedAt:  new Date().toISOString(),
        wagonNo,
        _external: true,
      })
    }
  }

  return result
}

function sanitizeSessionForWagons(sess, wagonList) {
  if (!sess || !Array.isArray(wagonList) || wagonList.length === 0) return sess

  const ownerByWagon = new Map(
    wagonList
      .filter(w => w?.wagonNo && w?.consigneeCode)
      .map(w => [cleanCode(w.wagonNo), cleanCode(w.consigneeCode)])
  )

  if (ownerByWagon.size === 0) return sess

  return {
    ...sess,
    consignees: (sess.consignees || []).map(c => ({
      ...c,
      plates: (c.plates || []).map(p => {
        const owner = p.loaded && p.wagonNo ? ownerByWagon.get(cleanCode(p.wagonNo)) : null
        if (owner && owner !== cleanCode(c.consigneeCode)) {
          return { ...p, loaded: false, loadedAt: null, wagonNo: null }
        }
        return p
      }),
    })),
  }
}

function sanitizeSessionsForWagons(sessionsMap, wagonList) {
  return Object.fromEntries(
    Object.entries(sessionsMap || {}).map(([destCode, sess]) => [
      destCode,
      sanitizeSessionForWagons(sess, wagonList),
    ])
  )
}

export default function LoadingOperationsPage() {
  const toast = useToast()
  const { user } = useAuth()
  const location = useLocation()

  const [step, setStep] = useState('RAKE_ENTRY')
  const [rakeInput, setRakeInput] = useState('')
  const [rakeLoading, setRakeLoading] = useState(false)
  const [rakeInfo, setRakeInfo] = useState(null)
  const [selectedDest, setSelectedDest] = useState(null)
  const [session, setSession] = useState(null)
  const [sessions, setSessions] = useState({})   // keyed by destination code
  const [consLoading, setConsLoading] = useState(false)

  const [activeCode, setActiveCode] = useState(null)
  const [plateFilter, setPlateFilter] = useState('')
  const [gradeFilter, setGradeFilter] = useState('')
  const [tdcFilter, setTdcFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [showLoaded, setShowLoaded] = useState(false)
  const [consigneeSearch, setConsigneeSearch] = useState('')
  const [wagonSearch, setWagonSearch]         = useState('')
  const [isFetchingPlate, setIsFetchingPlate] = useState(false)
  const [quickEntry, setQuickEntry] = useState('')
  const [quickError, setQuickError] = useState('')

  const [wagons, setWagons] = useState([])
  const [activeWagon, setActiveWagon] = useState(null)
  const [plateDetail, setPlateDetail] = useState(null)
  const [exporting, setExporting] = useState(false)
  const [submission, setSubmission] = useState({ status: 'idle', succeeded: 0, failed: 0, total: 0, failedPayloads: [], submissionType: 1 })
  const [showCompleteModal, setShowCompleteModal] = useState(false)
  const [wagonsToComplete, setWagonsToComplete] = useState(new Set())
  const [loadingDestCode, setLoadingDestCode] = useState(null)
  const [balUpdateOrdNo, setBalUpdateOrdNo] = useState(null) // Track which order's BAL is updating
  const [lockedPlates, setLockedPlates] = useState({})       // plateNo -> { lockedBy, rakeId, destCode, consigneeCode }

  const quickEntryRef = useRef(null)
  const quickDebounceRef = useRef(null)
  const loadConsigneesInProgressRef = useRef({})
  const loadedDetailsRef = useRef(null)
  const prefillHandledRef = useRef(false)
  const [quickResult, setQuickResult] = useState(null) // { type: 'list'|'api', plate?, apiInfo? }

  useEffect(() => {
    const es = createBalUpdateStream()
    es.onmessage = (e) => {
      if (!e.data || e.data === 'connected' || e.data.startsWith(':')) return
      try {
        const update = JSON.parse(e.data)
        setSession(prev => {
          if (!prev || prev.rakeId !== update.rakeId) return prev
          if (prev.destination?.code !== update.destCode) return prev
          return {
            ...prev,
            consignees: prev.consignees.map(c => ({
              ...c,
              orders: c.orders.map(o =>
                o.ordNo === update.ordNo ? { ...o, bal: update.balValue } : o
              ),
            })),
          }
        })
        setSessions(prev => {
          const sess = prev[update.destCode]
          if (!sess || sess.rakeId !== update.rakeId) return prev
          return {
            ...prev,
            [update.destCode]: {
              ...sess,
              consignees: sess.consignees.map(c => ({
                ...c,
                orders: c.orders.map(o =>
                  o.ordNo === update.ordNo ? { ...o, bal: update.balValue } : o
                ),
              })),
            },
          }
        })
      } catch {}
    }
    return () => { es.close() }
  }, [])

  useEffect(() => {
    const es = createPlateLockStream()
    es.onmessage = (e) => {
      if (!e.data || e.data.startsWith(':')) return
      try {
        const msg = JSON.parse(e.data)
        if (msg.type === 'init') {
          const map = {}
          ;(msg.locks || []).forEach(l => { if (l.plateNo) map[l.plateNo] = l })
          setLockedPlates(map)
          return
        }
        const { plateNo, locked } = msg
        if (!plateNo) return
        setLockedPlates(prev => {
          if (locked) return { ...prev, [plateNo]: msg }
          const next = { ...prev }
          delete next[plateNo]
          return next
        })
      } catch {}
    }
    return () => { es.close() }
  }, [])

  useEffect(() => {
    if (prefillHandledRef.current) return

    // Priority 1: explicit navigation prefill (from Dashboard / Assign Wagons)
    const state = location.state
    if (state?.prefillRakeId) {
      prefillHandledRef.current = true
      const id = String(state.prefillRakeId).toUpperCase()
      setRakeInput(id)

      const info = state.prefillRakeInfo ? { ...state.prefillRakeInfo, rakeId: id } : null
      setRakeInfo(info)

      // Check for existing saved session in localStorage for this rake
      const saved = loadSavedSession()
      const savedMap = loadSavedSessionsMap()

      if (saved && saved.rakeId === id && saved.step === 'LOADING') {
        // === Restore from saved session ===
        setSelectedDest(saved.destination || null)
        setSession(saved)
        if (savedMap && Object.keys(savedMap).length > 0) {
          setSessions(savedMap)
        } else if (saved.destination?.code) {
          setSessions({ [saved.destination.code]: saved })
        }

        // Fetch wagon mapping AND loaded details concurrently so restored sessions
        // always show plates that were loaded (by this or another client) since the
        // session was last saved to localStorage.
        Promise.all([
          fetchWagonsByRake(id),
          fetchLoadedDetails(id).catch(() => []),
        ]).then(([raw, loadedRaw]) => {
          if (Array.isArray(loadedRaw) && loadedRaw.length > 0) {
            loadedDetailsRef.current = loadedRaw
          }

          const byWagon = new Map()
          raw.forEach(r => {
            const wagonNo = cleanCode(r.DISPATCH_NM)
            if (!wagonNo) return
            byWagon.set(wagonNo, cleanCode(r.DISPATCH_CD) || null)
          })

          const savedWagonConsMap = {}
          const baseSessions = savedMap && Object.keys(savedMap).length > 0
            ? Object.values(savedMap)
            : [saved]
          baseSessions.forEach(sess => (sess?.consignees || []).forEach(c => {
            c.plates?.forEach(p => {
              const wagonNo = cleanCode(p.wagonNo)
              if (p.loaded && wagonNo && !savedWagonConsMap[wagonNo]) savedWagonConsMap[wagonNo] = c.consigneeCode
            })
          }))

          const wNos = [...byWagon.keys()]
          const nextWagons = wNos.map(wNo => ({
            wagonNo: wNo,
            consigneeCode: savedWagonConsMap[wNo] || byWagon.get(wNo) || null,
          }))

          const baseSessionMap = savedMap && Object.keys(savedMap).length > 0
            ? savedMap
            : (saved.destination?.code ? { [saved.destination.code]: saved } : {})
          const sanitizedMap = sanitizeSessionsForWagons(baseSessionMap, nextWagons)
          const sanitizedSession = saved.destination?.code
            ? (sanitizedMap[saved.destination.code] || sanitizeSessionForWagons(saved, nextWagons))
            : sanitizeSessionForWagons(saved, nextWagons)

          // Merge getLoadedDet data into the restored sessions: marks plates loaded
          // on the server side and injects any plates missing from the saved session.
          // applyLoadedDetails only adds loaded=true, never removes it, so the user's
          // manually-loaded (unsaved) plates are preserved.
          const lrToApply = Array.isArray(loadedRaw) && loadedRaw.length > 0 ? loadedRaw : []
          const mergedMap = {}
          for (const [dc, sess] of Object.entries(sanitizedMap)) {
            mergedMap[dc] = { ...sess, consignees: applyLoadedDetails(sess.consignees, dc, lrToApply) }
          }
          const currentDest = sanitizedSession.destination?.code
          const mergedSession = (currentDest && mergedMap[currentDest])
            ? mergedMap[currentDest]
            : {
                ...sanitizedSession,
                consignees: applyLoadedDetails(sanitizedSession.consignees, currentDest || '', lrToApply),
              }

          setWagons(nextWagons)
          setSession(mergedSession)
          setSessions(mergedMap)
          saveSession(mergedSession)
          try { localStorage.setItem(SESSIONS_MAP_KEY, JSON.stringify(mergedMap)) } catch {}
        }).catch(() => {})

        setStep('LOADING')
        return
      }

      // No saved session — proceed with fresh session setup
      if (Array.isArray(state.prefillWagons) && state.prefillWagons.length > 0) {
        setWagons(prev => {
          const existingMap = Object.fromEntries(prev.map(w => [w.wagonNo, w.consigneeCode]))
          return state.prefillWagons.map(w => ({
            wagonNo: w,
            consigneeCode: existingMap[w] ?? null,
          }))
        })
      }

      if (!info) return
      if (Array.isArray(info.destinations) && info.destinations.length === 1) {
        const onlyDest = info.destinations[0]
        setSelectedDest(onlyDest)
        void loadConsignees(id, onlyDest, info)
        return
      }
      if (Array.isArray(info.destinations) && info.destinations.length > 1) {
        setStep('DEST_SELECT')
      }
      return
    }

    // Priority 2: silent auto-restore of a saved session.
    // Triggered when user navigates directly to /loading-operations.
    const saved = loadSavedSession()
    const savedMap = loadSavedSessionsMap()
    if (saved?.step === 'LOADING') {
      prefillHandledRef.current = true
      setRakeInput(String(saved.rakeId || ''))
      setRakeInfo(saved.rakeInfo || null)
      setSelectedDest(saved.destination || null)
      setSession(saved)
      if (savedMap && Object.keys(savedMap).length > 0) {
        setSessions(savedMap)
      } else if (saved.destination?.code) {
        setSessions({ [saved.destination.code]: saved })
      }
      const restoreRakeId = String(saved.rakeId || '')
      Promise.all([
        fetchWagonsByRake(restoreRakeId),
        fetchLoadedDetails(restoreRakeId).catch(() => []),
      ]).then(([raw, loadedRaw]) => {
        if (Array.isArray(loadedRaw) && loadedRaw.length > 0) {
          loadedDetailsRef.current = loadedRaw
        }

        const byWagon = new Map()
        raw.forEach(r => {
          const wagonNo = cleanCode(r.DISPATCH_NM)
          if (!wagonNo) return
          byWagon.set(wagonNo, cleanCode(r.DISPATCH_CD) || null)
        })

        const wNos = [...byWagon.keys()]
        if (wNos.length) {
          const savedWagonConsMap = {}
          const savedSessions = savedMap && Object.keys(savedMap).length > 0 ? Object.values(savedMap) : [saved]
          savedSessions.forEach(sess => (sess?.consignees || []).forEach(c => {
            c.plates?.forEach(p => {
              const wagonNo = cleanCode(p.wagonNo)
              if (p.loaded && wagonNo && !savedWagonConsMap[wagonNo]) savedWagonConsMap[wagonNo] = c.consigneeCode
            })
          }))

          const nextWagons = wNos.map(wNo => ({
            wagonNo: wNo,
            consigneeCode: savedWagonConsMap[wNo] || byWagon.get(wNo) || null,
          }))
          const baseSessions = savedMap && Object.keys(savedMap).length > 0
            ? savedMap
            : (saved.destination?.code ? { [saved.destination.code]: saved } : {})
          const sanitizedMap = sanitizeSessionsForWagons(baseSessions, nextWagons)
          const sanitizedSession = saved.destination?.code
            ? (sanitizedMap[saved.destination.code] || sanitizeSessionForWagons(saved, nextWagons))
            : sanitizeSessionForWagons(saved, nextWagons)

          const lrToApply = Array.isArray(loadedRaw) && loadedRaw.length > 0 ? loadedRaw : []
          const mergedMap = {}
          for (const [dc, sess] of Object.entries(sanitizedMap)) {
            mergedMap[dc] = { ...sess, consignees: applyLoadedDetails(sess.consignees, dc, lrToApply) }
          }
          const currentDest = sanitizedSession.destination?.code
          const mergedSession = (currentDest && mergedMap[currentDest])
            ? mergedMap[currentDest]
            : {
                ...sanitizedSession,
                consignees: applyLoadedDetails(sanitizedSession.consignees, currentDest || '', lrToApply),
              }

          setWagons(nextWagons)
          setSession(mergedSession)
          setSessions(mergedMap)
          saveSession(mergedSession)
          try { localStorage.setItem(SESSIONS_MAP_KEY, JSON.stringify(mergedMap)) } catch {}
        }
      }).catch(() => {})
      setStep('LOADING')
    }
  }, [location.state]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (activeCode && quickEntryRef.current && !isCoarsePointer()) {
      setTimeout(() => quickEntryRef.current?.focus(), 100)
    }
  }, [activeCode])

  // Auto-clear submission status after toast disappears
  useEffect(() => {
    if (submission.status === 'saved') {
      const timer = setTimeout(() => {
        setSubmission(prev => ({ ...prev, status: 'idle' }))
      }, 4000)
      return () => clearTimeout(timer)
    }
  }, [submission.status])

  async function handleFetchRake() {
    const id = rakeInput.trim().toUpperCase()
    if (!id) {
      toast.warning('Please enter a Rake ID.')
      return
    }

    loadedDetailsRef.current = null
    setRakeLoading(true)
    try {
      const info = await fetchRakeInfo(id)
      const merged = { ...info, rakeId: id }
      setRakeInfo(merged)

      if (merged.destinations.length === 1) {
        const dest = merged.destinations[0]
        setSelectedDest(dest)
        await loadConsignees(id, dest, merged)
      } else {
        setStep('DEST_SELECT')
      }
    } catch {
      toast.error('Could not fetch Rake info. Check the Rake ID and try again.')
    } finally {
      setRakeLoading(false)
    }
  }

  async function handleSelectDest(dest) {
    setSelectedDest(dest)
    await loadConsignees(rakeInput.trim().toUpperCase(), dest, rakeInfo)
  }

  function handleSwitchDest(dest) {
    if (dest.code === selectedDest?.code) return
    setActiveCode(null)
    setActiveWagon(null)
    setPlateFilter('')
    setQuickEntry(''); setQuickError('')
    setQuickResult(null)
    setSelectedDest(dest)

    // If already loaded, just restore it
    if (sessions[dest.code]) {
      const nextSession = sanitizeSessionForWagons(sessions[dest.code], wagons)
      setSession(nextSession)
      setSessions(prev => ({ ...prev, [dest.code]: nextSession }))
      saveSession(nextSession)
      try {
        const currentMap = JSON.parse(localStorage.getItem(SESSIONS_MAP_KEY) || '{}')
        currentMap[dest.code] = nextSession
        localStorage.setItem(SESSIONS_MAP_KEY, JSON.stringify(currentMap))
      } catch {}
      return
    }

    // Cache miss: fetch in background while keeping destination switch UI interactive.
    loadConsignees(rakeInput.trim().toUpperCase(), dest)
  }

  async function loadConsignees(rakeId, dest, info) {
    if (loadConsigneesInProgressRef.current[dest.code]) return
    loadConsigneesInProgressRef.current[dest.code] = true
    setLoadingDestCode(dest.code)
    setConsLoading(true)

    try {
      if (!loadedDetailsRef.current) {
        loadedDetailsRef.current = await fetchLoadedDetails(rakeId).catch(() => [])
      }
      const loadedRaw = loadedDetailsRef.current
      const rawConsignees = await fetchLoadingReport(dest.code)
      const consignees = applyLoadedDetails(rawConsignees, dest.code, loadedRaw)
      setWagons(prev => {
        const wagonConsMap = {}
        consignees.forEach(c => {
          c.plates.forEach(p => {
            if (p.loaded && p.wagonNo && !wagonConsMap[p.wagonNo]) wagonConsMap[p.wagonNo] = c.consigneeCode
          })
        })
        return prev.map(w => ({ ...w, consigneeCode: w.consigneeCode || wagonConsMap[w.wagonNo] || null }))
      })

      // Also fetch wagon-to-consignee mapping from API to populate
      // consigneeCode for wagons without loaded plates yet (DISPATCH_CD fallback)
      fetchWagonsByRake(rakeId).then(raw => {
        const wagonConsMapApi = {}
        raw.forEach(r => {
          const wagonNo = cleanCode(r.DISPATCH_NM)
          const dispatchCd = cleanCode(r.DISPATCH_CD)
          if (wagonNo && dispatchCd && !wagonConsMapApi[wagonNo]) wagonConsMapApi[wagonNo] = dispatchCd
        })
        if (Object.keys(wagonConsMapApi).length > 0) {
          setWagons(prev => prev.map(w => ({
            ...w,
            consigneeCode: w.consigneeCode || wagonConsMapApi[w.wagonNo] || null,
          })))
        }
      }).catch(() => {})

      const newSession = {
        rakeId,
        rakeInfo: info || rakeInfo,
        destination: dest,
        consignees,
        loadingLog: [],
        step: 'LOADING',
        startedAt: new Date().toISOString(),
        operatedBy: user?.username,
      }
      setSession(newSession)
      setSessions(prev => ({ ...prev, [dest.code]: newSession }))
      saveSession(newSession)
      try {
        const currentMap = JSON.parse(localStorage.getItem(SESSIONS_MAP_KEY) || '{}')
        currentMap[dest.code] = newSession
        localStorage.setItem(SESSIONS_MAP_KEY, JSON.stringify(currentMap))
      } catch {}
      setStep('LOADING')

      const okCount = consignees.reduce((s, c) => s + (c.okPlateCount || 0), 0)
      toast.success({
        title: 'Session Ready',
        message: `${consignees.length} consignees · ${okCount} OK plates · ${dest.name}`,
      })

      // Pre-warm cache for other destinations so switching is instant.
      const allDests = (info || rakeInfo)?.destinations || []
      allDests
        .filter(d => d.code !== dest.code)
        .forEach(d => fetchLoadingReport(d.code).catch(() => {}))
    } catch {
      toast.error('Failed to load consignee data. Please try again.')
    } finally {
      delete loadConsigneesInProgressRef.current[dest.code]
      setLoadingDestCode(null)
      setConsLoading(false)
    }
  }

  const updateSession = useCallback((updater) => {
    setSession(prev => {
      const next = updater(prev)
      saveSession(next)
      setSessions(s => ({ ...s, [next.destination.code]: next }))
      try {
        const currentMap = JSON.parse(localStorage.getItem(SESSIONS_MAP_KEY) || '{}')
        currentMap[next.destination.code] = next
        localStorage.setItem(SESSIONS_MAP_KEY, JSON.stringify(currentMap))
      } catch {}
      return next
    })
  }, [])

  function handleSelectConsignee(code) {
    const c = session.consignees.find(x => x.consigneeCode === code)
    if (!c) return

    setActiveCode(code)
    setPlateFilter('')
    setGradeFilter('')
    setTdcFilter('')
    setTypeFilter('')
    setQuickEntry('')
    setQuickError('')
    setQuickResult(null)
    if (quickDebounceRef.current) clearTimeout(quickDebounceRef.current)

    // Auto-select first wagon already assigned to this consignee
    const cWagon = wagons.find(w => w.consigneeCode === code)
    setActiveWagon(cWagon ? cWagon.wagonNo : null)
  }

  function handleSelectWagon(wagonNo) {
    if (!activeCode) {
      toast.warning('Select a consignee first.')
      return
    }
    const wagon = wagons.find(w => w.wagonNo === wagonNo)
    if (!wagon) return

    if (wagon.consigneeCode && wagon.consigneeCode !== activeCode) {
      const ownerName = session.consignees.find(c => c.consigneeCode === wagon.consigneeCode)?.consigneeName || wagon.consigneeCode
      toast.error(`Wagon ${wagonNo} is already assigned to ${ownerName}.`)
      return
    }

    if (!wagon.consigneeCode) {
      // Wagon is unassigned - ask for confirmation
      const consName = session.consignees.find(c => c.consigneeCode === activeCode)?.consigneeName
      const msg = `Assign wagon ${wagonNo} to ${consName}?`
      if (!window.confirm(msg)) {
        return
      }

      setWagons(prev => prev.map(w =>
        w.wagonNo === wagonNo ? { ...w, consigneeCode: activeCode } : w
      ))
      toast.success({ title: 'Wagon Assigned', message: `${wagonNo} → ${consName}`, duration: 2000 })
    }

    setActiveWagon(wagonNo)
    if (!isCoarsePointer()) setTimeout(() => quickEntryRef.current?.focus(), 100)
  }

  function handleUnlinkWagon(wagonNo) {
    const loadedCount = session.consignees
      .find(c => c.consigneeCode === activeCode)
      ?.plates.filter(p => p.wagonNo === wagonNo && p.loaded).length ?? 0

    const msg = loadedCount > 0
      ? `Unlink wagon ${wagonNo}? ${loadedCount} plate(s) will be marked as not loaded.`
      : `Unlink wagon ${wagonNo} from this consignee?`
    if (!window.confirm(msg)) return

    setWagons(prev => prev.map(w =>
      w.wagonNo === wagonNo ? { ...w, consigneeCode: null } : w
    ))

    updateSession(prev => ({
      ...prev,
      consignees: prev.consignees.map(c =>
        c.consigneeCode === activeCode
          ? {
            ...c,
            plates: c.plates.map(p =>
              p.wagonNo === wagonNo && p.loaded
                ? { ...p, loaded: false, loadedAt: null, wagonNo: null }
                : p
            ),
          }
          : c
      ),
      loadingLog: prev.loadingLog.concat({
        timestamp: new Date().toISOString(),
        wagonNo,
        consigneeCode: activeCode,
        action: 'WAGON_UNLINKED',
      }),
    }))

    if (activeWagon === wagonNo) setActiveWagon(null)
    toast.info({
      message: `Wagon ${wagonNo} unlinked${loadedCount > 0 ? `. ${loadedCount} plate(s) reset.` : '.'}`,
      duration: 2800,
    })
  }

  function togglePlate(consigneeCode, plateNo) {
    const now = new Date().toISOString()
    const c = session.consignees.find(x => x.consigneeCode === consigneeCode)
    if (!c) return

    const plate = c.plates.find(p => p.plateNo === plateNo)
    if (!plate) return

    if (!plate.loaded && !activeWagon && wagons.length > 0) {
      toast.warning('Select a wagon from the panel on the left before marking plates as loaded.')
      return
    }

    const action  = plate.loaded ? 'UNLOADED' : 'LOADED'
    const wagonNo = plate.loaded ? null : activeWagon
    const isLoading = !plate.loaded // true if marking as loaded, false if unloading
    const weightDelta = plate.pcWgt ? parseFloat(plate.pcWgt) : 0

    // Compute new BAL for broadcasting to concurrent users
    const currentOrder = c.orders?.find(o => o.ordNo === plate.ordNo)
    const currentBal = currentOrder?.bal ?? 0
    const newBal = plate.ordNo
      ? Number(Math.max(0, currentBal - (isLoading ? weightDelta : -weightDelta)).toFixed(3))
      : null

    // Track which order's BAL is updating for visual feedback
    if (plate.ordNo) {
      setBalUpdateOrdNo(plate.ordNo)
      setTimeout(() => setBalUpdateOrdNo(null), 600)
    }

    updateSession(prev => ({
      ...prev,
      consignees: prev.consignees.map(cons =>
        cons.consigneeCode === consigneeCode
          ? {
            ...cons,
            plates: cons.plates.map(p =>
              p.plateNo === plateNo
                ? { ...p, loaded: !p.loaded, loadedAt: !p.loaded ? now : null, wagonNo }
                : p
            ),
            // Update the order's bal when plate loading status changes
            orders: cons.orders.map(o =>
              o.ordNo === plate.ordNo
                ? {
                    ...o,
                    bal: Number(
                      Math.max(
                        0,
                        (o.bal || 0) - (isLoading ? weightDelta : -weightDelta)
                      ).toFixed(3)
                    )
                  }
                : o
            ),
          }
          : cons
      ),
      loadingLog: prev.loadingLog.concat({
        timestamp: now,
        plateNo,
        consigneeCode,
        wagonNo: activeWagon,
        action,
      }),
    }))

    if (plate.ordNo && newBal !== null && session?.rakeId) {
      publishBalUpdate({
        ordNo: plate.ordNo,
        rakeId: session.rakeId,
        destCode: session.destination?.code,
        balValue: newBal,
      })
    }

    // ZCMO plates: lock on load, unlock on unload so concurrent users cannot
    // double-load the same physical plate.
    // Capture values from the closure before the async boundary.
    const zcmoPlateNo   = plate.plateNo
    const zcmoPlateType = plate.plateType
    const zcmoRakeId    = session?.rakeId
    const zcmoDestCode  = session?.destination?.code
    const zcmoLockedBy  = user?.username || 'unknown'
    if (zcmoPlateType === 'ZCMO' && zcmoRakeId) {
      publishPlateLock({
        plateNo:       zcmoPlateNo,
        rakeId:        zcmoRakeId,
        destCode:      zcmoDestCode,
        consigneeCode,
        lockedBy:      zcmoLockedBy,
        locked:        isLoading,
      })
    }
  }

  function handleQuickInputChange(val) {
    const upper = val.toUpperCase()
    setQuickEntry(upper)
    setQuickError('')
    setQuickResult(null)

    if (quickDebounceRef.current) clearTimeout(quickDebounceRef.current)

    const q = upper.trim()
    if (!q || !activeCode || !session) return

    // Only fire API search when input is at least 6 characters long
    if (q.length < 6) return

    quickDebounceRef.current = setTimeout(async () => {
      const cons = session.consignees.find(c => c.consigneeCode === activeCode)
      if (!cons) return

      const plate = cons.plates
        .find(p =>
          p.plateNo.toUpperCase() === q ||
          p.plateNo.toUpperCase() === `OK-${q}` ||
          p.plateNo.toUpperCase().endsWith(q)
        )

      if (plate) {
        setQuickResult({ type: 'list', plate })
        return
      }

      setIsFetchingPlate(true)
      try {
        const results = await fetchPlateInfoSearch(q)
        if (results && results.length > 0) {
          setQuickResult({ type: 'api', apiInfo: results })
        } else {
          setQuickError(`Plate "${q}" not found in list or system.`)
        }
      } catch {
        setQuickError(`Could not fetch plate info for "${q}".`)
      } finally {
        setIsFetchingPlate(false)
      }
    }, 550)
  }

  function handleQuickLoad(apiItem) {
    if (!quickResult) return

    if (quickResult.type === 'list') {
      const { plate } = quickResult
      if (plate.loaded) {
        setQuickError(`${plate.plateNo} is already marked as loaded.`)
        return
      }
      if (!activeWagon && wagons.length > 0) {
        toast.warning('Select a wagon before loading.')
        return
      }
      togglePlate(activeCode, plate.plateNo)
      toast.success({ message: `${plate.plateNo} → Loaded`, duration: 1800 })
      setQuickEntry('')
      setQuickResult(null)
      setQuickError('')
      if (!isCoarsePointer()) quickEntryRef.current?.focus()
      return
    }

    // API search result — use the selected item or fall back to first result
    if (!activeWagon && wagons.length > 0) {
      toast.warning('Select a wagon before loading.')
      return
    }

    const apiInfo = apiItem || (Array.isArray(quickResult.apiInfo) ? quickResult.apiInfo[0] : quickResult.apiInfo)
    if (!apiInfo) return

    // Prevent duplicate loading: check if plate already exists in this consignee
    const apiPlateNo = apiInfo.PLATE_NO || quickEntry.trim()
    if (apiPlateNo) {
      const existingPlate = session.consignees
        .find(c => c.consigneeCode === activeCode)
        ?.plates.find(p => p.plateNo === apiPlateNo)
      if (existingPlate?.loaded) {
        setQuickError(`${apiPlateNo} is already marked as loaded.`)
        return
      }
      if (existingPlate && !existingPlate.loaded) {
        // Plate exists but unloaded — toggle it back to loaded
        togglePlate(activeCode, apiPlateNo)
        toast.success({ message: `${apiPlateNo} → Loaded`, duration: 1800 })
        setQuickEntry('')
        setQuickResult(null)
        setQuickError('')
        if (!isCoarsePointer()) quickEntryRef.current?.focus()
        return
      }
    }

    const now = new Date().toISOString()
    const inferredPlateType = (() => {
      const raw = String(apiInfo.MECH_RESULT || apiInfo.PLATE_TYPE || '').toUpperCase()
      return ['OK', 'RA', 'DIV', 'MTI', 'TPI'].includes(raw) ? raw : 'OK'
    })()
    const newPlate = {
      plateNo:  apiInfo.PLATE_NO  || quickEntry.trim(),
      heatNo:   apiInfo.HEAT_NO   || '',
      plateType: inferredPlateType,
      ordNo:    apiInfo.ORD_NO    || '',
      grade:    apiInfo.GRADE     || '',
      tdc:      apiInfo.TDC       || '',
      colourCd: apiInfo.COLOUR_CD || '',
      ordSize:  apiInfo.PLATE_SIZE || '',
      pcWgt:    apiInfo.WGT ? parseFloat(apiInfo.WGT) : null,
      loaded:   true,
      loadedAt: now,
      wagonNo:  activeWagon,
      _manual:  true,
    }
    updateSession(prev => ({
      ...prev,
      consignees: prev.consignees.map(c =>
        c.consigneeCode === activeCode
          ? {
            ...c,
            plates: [...c.plates, newPlate],
            okPlateCount: inferredPlateType === 'OK' ? (c.okPlateCount ?? 0) + 1 : (c.okPlateCount ?? 0),
          }
          : c
    ),
      loadingLog: prev.loadingLog.concat({
        timestamp: now,
        plateNo:   newPlate.plateNo,
        consigneeCode: activeCode,
        wagonNo:   activeWagon,
        action:    'LOADED',
      }),
    }))
    toast.success({ message: `${newPlate.plateNo} → Loaded (added manually)`, duration: 2200 })

    setQuickEntry('')
    setQuickResult(null)
    setQuickError('')
    if (!isCoarsePointer()) quickEntryRef.current?.focus()
  }

  async function handlePlateDetail(p) {
    setPlateDetail(p)
    try {
      const info = await fetchPlateInfo(p.plateNo)
      if (info) setPlateDetail(prev => prev?.plateNo === p.plateNo ? { ...prev, _apiInfo: info } : prev)
    } catch { /* show existing data only */ }
  }

  async function handleSaveProgress() {
    const allSessions = { ...sessions, [session.destination.code]: session }
    const payloads = buildWagonPayloads({ ...session, allSessions, wagons })
    if (!payloads.length) {
      toast.warning('No loaded plates to save.')
      return
    }
    if (!window.confirm(`Save progress for Rake ${session.rakeId}?`)) return

    setSubmission({ status: 'submitting', succeeded: 0, failed: 0, total: payloads.length, failedPayloads: [], submissionType: 1 })

    const results = await submitWagonRequests(payloads, submitWagonLoad, ({ succeeded, failed, total }) => {
      setSubmission(prev => ({ ...prev, succeeded, failed, total }))
    }, 1)

    if (results.failed.length === 0) {
      toast.success({ title: 'Progress Saved', message: `${results.succeeded.length} wagon record(s) saved successfully.` })
      setSubmission({ status: 'saved', succeeded: results.succeeded.length, failed: 0, total: payloads.length, failedPayloads: [], submissionType: 1 })
      try {
        const loadedRaw = await fetchLoadedDetails(session.rakeId)
        loadedDetailsRef.current = loadedRaw
        updateSession(prev => ({
          ...prev,
          savedAt: new Date().toISOString(),
          consignees: applyLoadedDetails(prev.consignees, prev.destination?.code, loadedRaw),
        }))
      } catch {
        // Silent by design; save succeeded already.
      }
      return
    }

    setSubmission({
      status: 'partial',
      succeeded: results.succeeded.length,
      failed: results.failed.length,
      total: payloads.length,
      failedPayloads: results.failed.map(f => f.payload),
      submissionType: 1,
    })
  }

  async function submitMixedCompletionRequests(payloads, completedWagonNos, onProgress) {
    const completedSet = new Set(completedWagonNos)
    const queued = payloads.map(payload => ({
      payload,
      status: completedSet.has(payload.wagonNo) ? 2 : 1,
    }))
    const results = { succeeded: [], failed: [] }

    await Promise.allSettled(
      queued.map(async (entry) => {
        try {
          await submitWagonLoad(entry.payload, entry.status)
          results.succeeded.push(entry)
        } catch (err) {
          results.failed.push({ ...entry, error: err.message })
        }
        onProgress?.({
          succeeded: results.succeeded.length,
          failed: results.failed.length,
          total: queued.length,
        })
      })
    )

    return results
  }

  async function handleCompleteWagons() {
    if (wagonsToComplete.size === 0) {
      toast.warning('Select at least one wagon to complete.')
      return
    }

    const allSessions = { ...sessions, [session.destination.code]: session }
    const allPayloads = buildWagonPayloads({ ...session, allSessions, wagons })
    const selectedPayloads = allPayloads.filter(p => wagonsToComplete.has(p.wagonNo))
    if (!selectedPayloads.length) {
      toast.warning('No loaded plates found for the selected wagons.')
      return
    }
    const completedWagonNos = [...wagonsToComplete]

    setShowCompleteModal(false)
    const done = {
      ...session,
      allSessions,
      wagons,
      completedWagons: completedWagonNos,
      completedAt: new Date().toISOString(),
      step: 'COMPLETED',
    }
    setSession(done)
    setSessions(allSessions)
    saveSession(done)
    setStep('COMPLETED')
    localStorage.removeItem(SESSION_KEY)
    localStorage.removeItem(SESSIONS_MAP_KEY)

    setSubmission({ status: 'submitting', succeeded: 0, failed: 0, total: allPayloads.length, failedPayloads: [], submissionType: 2 })

    const results = await submitMixedCompletionRequests(allPayloads, completedWagonNos, ({ succeeded, failed, total }) => {
      setSubmission(prev => ({ ...prev, succeeded, failed, total }))
    })

    setSubmission({
      status: results.failed.length === 0 ? 'done' : 'partial',
      succeeded: results.succeeded.length,
      failed: results.failed.length,
      total: allPayloads.length,
      failedPayloads: results.failed.map(f => ({ payload: f.payload, status: f.status })),
      submissionType: 2,
    })
  }

  async function handleRetrySubmission() {
    const payloads = submission.failedPayloads
    if (!payloads.length) return
    const retryType = submission.submissionType ?? 2
    setSubmission(prev => ({ ...prev, status: 'submitting', succeeded: 0, failed: 0, total: payloads.length, failedPayloads: [] }))

    if (retryType === 2) {
      const queued = payloads.map(item => (
        item?.payload && typeof item.status === 'number'
          ? item
          : { payload: item, status: 2 }
      ))
      const results = { succeeded: [], failed: [] }

      await Promise.allSettled(
        queued.map(async (entry) => {
          try {
            await submitWagonLoad(entry.payload, entry.status)
            results.succeeded.push(entry)
          } catch (err) {
            results.failed.push({ ...entry, error: err.message })
          }
          setSubmission(prev => ({
            ...prev,
            succeeded: results.succeeded.length,
            failed: results.failed.length,
            total: queued.length,
          }))
        })
      )

      setSubmission({
        status:         results.failed.length === 0 ? 'done' : 'partial',
        succeeded:      results.succeeded.length,
        failed:         results.failed.length,
        total:          queued.length,
        failedPayloads: results.failed.map(f => ({ payload: f.payload, status: f.status })),
        submissionType: retryType,
      })
      return
    }

    const results = await submitWagonRequests(payloads, submitWagonLoad, ({ succeeded, failed, total }) => {
      setSubmission(prev => ({ ...prev, succeeded, failed, total }))
    }, retryType)

    const successStatus = retryType === 1 ? 'saved' : 'done'

    setSubmission({
      status:         results.failed.length === 0 ? successStatus : 'partial',
      succeeded:      results.succeeded.length,
      failed:         results.failed.length,
      total:          payloads.length,
      failedPayloads: results.failed.map(f => f.payload),
      submissionType: retryType,
    })
  }

  async function handleGenerateReport() {
    setExporting(true)
    try {
      const allSessions = { ...sessions, [session.destination.code]: session }
      await generateProgressReport({ ...session, allSessions, wagons })
    } catch (e) { toast.error('PDF failed: ' + e.message) }
    finally { setExporting(false) }
  }

  async function handleExportPdf() {
    setExporting(true)
    try {
      const allSessions = { ...sessions, [session.destination.code]: session }
      await generateLoadingPdf({ ...session, allSessions, wagons }, step === 'COMPLETED' ? 'completion' : 'progress')
    } catch (e) { toast.error('PDF failed: ' + e.message) }
    finally { setExporting(false) }
  }

  const activeConsignee = session?.consignees.find(c => c.consigneeCode === activeCode)

  const filteredConsignees = (session?.consignees ?? [])
    .filter(c => {
      if (!consigneeSearch) return true
      const q = consigneeSearch.toLowerCase()
      return c.consigneeName.toLowerCase().includes(q) || c.consigneeCode.toLowerCase().includes(q)
    })
    .sort((a, b) => {
      const aCount = wagons.filter(w => w.consigneeCode === a.consigneeCode).length
      const bCount = wagons.filter(w => w.consigneeCode === b.consigneeCode).length
      return bCount - aCount
    })

  const filteredWagons = wagons
    .filter(w => {
      if (!wagonSearch) return true
      const q = wagonSearch.toLowerCase()
      return w.wagonNo.toLowerCase().includes(q) ||
        (w.consigneeCode || '').toLowerCase().includes(q)
    })
    .sort((a, b) => {
      // Check if active consignee has any assigned wagons
      const activeConsigneeHasWagons = activeCode ? wagons.some(w => w.consigneeCode === activeCode) : false
      
      // If no wagons assigned to this consignee, prioritize unassigned wagons
      if (!activeConsigneeHasWagons && activeCode) {
        const aIsUnassigned = a.consigneeCode === null
        const bIsUnassigned = b.consigneeCode === null
        if (aIsUnassigned && !bIsUnassigned) return -1
        if (!aIsUnassigned && bIsUnassigned) return 1
        return 0
      }
      
      // Default: Prioritize wagons assigned to the currently selected consignee
      const aIsActive = a.consigneeCode === activeCode
      const bIsActive = b.consigneeCode === activeCode
      if (aIsActive && !bIsActive) return -1
      if (!aIsActive && bIsActive) return 1
      return 0
    })

  const allActivePlates = activeConsignee?.plates ?? []
  const okPlates = allActivePlates.filter(p => p.plateType === 'OK')
  const nonOkPlates = allActivePlates.filter(p => p.plateType !== 'OK')

  // Combine all plates and sort: loaded first (all types), then unloaded (all types)
  // Within each group, sort by wagon number
  const gradeOptions = [...new Set(allActivePlates.map(p => p.grade).filter(Boolean))].sort()
  const tdcOptions = [...new Set(allActivePlates.map(p => p.tdc).filter(Boolean))].sort()

  const visibleAllPlates = [...okPlates, ...nonOkPlates]
    .filter(p => {
      if (!plateFilter) return true
      const q = plateFilter.toLowerCase()
      return (
        p.plateNo.toLowerCase().includes(q) ||
        (p.ordNo || '').toLowerCase().includes(q) ||
        (p.heatNo || '').toLowerCase().includes(q)
      )
    })
    .filter(p => !gradeFilter || p.grade === gradeFilter)
    .filter(p => !tdcFilter || p.tdc === tdcFilter)
    .filter(p => !typeFilter || p.plateType === typeFilter)
    .filter(p => showLoaded || !p.loaded)
    .sort((a, b) => {
      // Primary sort: loaded status (loaded first)
      if (a.loaded !== b.loaded) {
        return a.loaded ? -1 : 1
      }
      // Secondary sort: wagon number (for grouping)
      const wagonA = a.wagonNo || ''
      const wagonB = b.wagonNo || ''
      if (wagonA !== wagonB) return wagonA.localeCompare(wagonB)
      // Tertiary sort: plate type (OK first)
      if (a.plateType !== b.plateType) {
        return a.plateType === 'OK' ? -1 : 1
      }
      return 0
    })

  const loadedPlates = session?.consignees.reduce((s, c) => s + c.plates.filter(p => p.loaded).length, 0) ?? 0

  // All-destination totals (used in COMPLETED step)
  const completedConsignees = (() => {
    if (step === 'COMPLETED' && session?.allSessions) {
      return Object.values(session.allSessions).flatMap(s =>
        s.consignees.map(c => ({ ...c, _destination: s.destination }))
      )
    }
    return (session?.consignees ?? []).map(c => ({ ...c, _destination: session?.destination }))
  })()

  const completedLoaded = completedConsignees.reduce((s, c) => s + c.plates.filter(p => p.loaded).length, 0)
  const completedLoadedWeight = completedConsignees.reduce((s, c) =>
    s + c.plates.filter(p => p.loaded && p.pcWgt).reduce((ws, p) => ws + (parseFloat(p.pcWgt) || 0), 0), 0)
  const completedConsigneesWithLoads = completedConsignees.filter(c => c.plates.some(p => p.loaded)).length
  const completedWagonSet = new Set(step === 'COMPLETED' ? (session?.completedWagons || []) : [])

  // Build wagon-wise summary (one row per wagon)
  const wagonSummary = (() => {
    const wagonMap = {}
    const allSessions = step === 'COMPLETED' && session?.allSessions
      ? session.allSessions
      : session ? { [session.destination?.code]: session } : {}
    
    Object.values(allSessions).forEach(sess => {
      if (!sess) return
      sess.consignees?.forEach(consignee => {
        consignee.plates?.forEach(plate => {
          if (plate.loaded && plate.wagonNo) {
            if (!wagonMap[plate.wagonNo]) {
              wagonMap[plate.wagonNo] = {
                wagonNo: plate.wagonNo,
                consigneeCode: consignee.consigneeCode,
                consigneeName: consignee.consigneeName,
                destination: sess.destination,
                platesCount: 0,
                totalWeight: 0,
                isCompleted: completedWagonSet.has(plate.wagonNo),
              }
            }
            wagonMap[plate.wagonNo].platesCount++
            if (plate.pcWgt) {
              wagonMap[plate.wagonNo].totalWeight += parseFloat(plate.pcWgt) || 0
            }
          }
        })
      })
    })
    
    return Object.values(wagonMap)
      .map(w => ({ ...w, isCompleted: completedWagonSet.has(w.wagonNo) }))
      .sort((a, b) => a.wagonNo.localeCompare(b.wagonNo))
  })()

  return (
    <AppShell pageTitle="Loading Operations">
      {step === 'RAKE_ENTRY' && (
        <div style={{ maxWidth: 600, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="section-header">
            <div>
              <div className="section-title">Loading Operations</div>
              <div className="section-sub">Enter the Rake ID to begin the plate loading session.</div>
            </div>
          </div>
          <div className="card">
            <div className="card-header">
              <div className="card-icon"><LoadIcon /></div>
              <div>
                <div className="card-title">Initiate Loading Session</div>
                <div className="card-subtitle">Rake ID is generated in the Rake Generation module.</div>
              </div>
            </div>
            <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="form-group">
                <label className="form-label" htmlFor="rakeId">Rake ID <span className="req">*</span></label>
                <input
                  id="rakeId"
                  className="form-control lg mono"
                  placeholder="e.g. 2026032701"
                  value={rakeInput}
                  onChange={e => setRakeInput(e.target.value.toUpperCase())}
                  onKeyDown={e => e.key === 'Enter' && handleFetchRake()}
                  autoFocus={!isCoarsePointer()}
                  disabled={rakeLoading || consLoading}
                />
                <span className="form-hint">Press Enter or click Proceed to fetch rake details.</span>
              </div>
            </div>
            <div className="card-footer">
              <button
                className="btn btn-primary btn-lg"
                onClick={handleFetchRake}
                disabled={!rakeInput.trim() || rakeLoading || consLoading}
              >
                {(rakeLoading || consLoading)
                  ? <><span className="spinner spinner-sm" /> {rakeLoading ? 'Fetching Rake...' : 'Loading Consignees...'}</>
                  : <><ArrowRightIcon /> Proceed</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {step === 'DEST_SELECT' && rakeInfo && (
        <div style={{ maxWidth: 600, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <StepBar steps={['Rake ID', 'Destination', 'Loading']} active={1} />
          <div className="card">
            <div className="card-header">
              <div className="card-icon"><DestIcon /></div>
              <div>
                <div className="card-title">Select Loading Destination</div>
                <div className="card-subtitle">Rake {rakeInfo.rakeId} serves multiple destinations.</div>
              </div>
            </div>
            <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="alert alert-info">
                <InfoIcon />
                <span>This rake serves <strong>{rakeInfo.destinations.length}</strong> destination(s). Choose the one you are loading for.</span>
              </div>
              <div className="dest-choice-group">
                {rakeInfo.destinations.map(d => (
                  <button
                    key={d.code}
                    className={`dest-choice-chip ${selectedDest?.code === d.code ? 'selected' : ''}`}
                    onClick={() => setSelectedDest(d)}
                  >
                    {d.name} ({d.code})
                  </button>
                ))}
              </div>
            </div>
            <div className="card-footer">
              <button className="btn btn-ghost btn-sm" onClick={() => setStep('RAKE_ENTRY')}><BackIcon /> Back</button>
              <button
                className="btn btn-primary"
                onClick={() => selectedDest && handleSelectDest(selectedDest)}
                disabled={!selectedDest || consLoading}
              >
                {consLoading
                  ? <><span className="spinner spinner-sm" /> Loading Consignees...</>
                  : <>Confirm Destination <ArrowRightIcon /></>}
              </button>
            </div>
          </div>
        </div>
      )}

      {step === 'LOADING' && session && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
            <div className="info-row" style={{ flex: 1, gap: 10, fontSize: 12 }}>
              <div className="info-item">
                <span className="info-label">Rake</span>
                <span className="info-value mono" style={{ fontSize: 12 }}>{session.rakeId}</span>
              </div>
              <div className="info-item">
                <span className="info-label">Dest.</span>
                <span className="dest-chip" style={{ fontSize: 11, padding: '2px 7px 2px 5px' }}><DestIcon size={10} />{session.destination.name} ({session.destination.code})</span>
              </div>
              <div className="info-item">
                <span className="info-label">Loaded:</span>
                <span className="info-value">{loadedPlates} Plates</span>
              </div>
            </div>
            {rakeInfo?.destinations?.length > 1 && (
              <div style={{ display:'flex', gap:4, alignItems:'center' }}>
                {rakeInfo.destinations.map(d => {
                  const ds = sessions[d.code]
                  const dLoaded = ds ? ds.consignees.reduce((a, c) => a + c.plates.filter(p => p.loaded).length, 0) : 0
                  return (
                    <button key={d.code}
                      className={`btn btn-sm ${selectedDest?.code === d.code ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => handleSwitchDest(d)}
                      disabled={loadingDestCode === d.code}
                      title={`Switch to ${d.name}`}
                      style={{ fontSize: 11.5 }}
                    >
                      {d.name}
                      {ds && (
                        <span style={{ marginLeft: 5, fontFamily: 'var(--font-mono)', fontSize: 10, opacity: 0.8 }}>
                          {dLoaded}
                        </span>
                      )}
                      {loadingDestCode === d.code && (
                        <span className="spinner spinner-sm" style={{ marginLeft: 5 }} />
                      )}
                    </button>
                  )
                })}
              </div>
            )}
            <div style={{ display: 'flex', gap: 6 }}>
              <button 
                className="btn btn-ghost btn-sm" 
                onClick={() => window.history.back()}
                title="Go back to Assign Wagons"
                style={{ padding: '5px 10px', fontSize: 12 }}
              >
                <BackIcon /> Back
              </button>
              <button className="btn btn-secondary btn-sm" onClick={handleGenerateReport} disabled={exporting} style={{ padding: '5px 10px', fontSize: 12 }}>
                <PdfIcon /> Generate Report
              </button>
              <button className="btn btn-secondary btn-sm" onClick={handleSaveProgress} style={{ padding: '5px 10px', fontSize: 12 }}>
                <SaveIcon /> Save Progress
              </button>
              <button className="btn btn-success" style={{ padding: '5px 14px', fontSize: 12 }} onClick={() => {
                const allSess = { ...sessions, [session.destination.code]: session }
                const wagonsWithPlates = wagons.filter(w =>
                  Object.values(allSess).some(s => s?.consignees?.some(c => c.plates.some(p => p.loaded && p.wagonNo === w.wagonNo)))
                )
                if (!wagonsWithPlates.length) {
                  toast.warning('No wagons with loaded plates to complete.')
                  return
                }
                setWagonsToComplete(new Set())
                setShowCompleteModal(true)
              }}>
                <CompleteIcon /> Complete
              </button>
            </div>
          </div>

          {submission.status !== 'idle' && submission.submissionType === 1 && (
            <div style={{ marginBottom: 4 }}>
              {submission.status === 'submitting' && (
                <div className="alert alert-info" style={{ alignItems: 'center', gap: 10 }}>
                  <span className="spinner spinner-sm" />
                  <span>Saving progress... {submission.succeeded + submission.failed} / {submission.total}</span>
                </div>
              )}

              {submission.status === 'partial' && (
                <div className="alert alert-danger" style={{ flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <WarnIcon size={15} />
                    {submission.failed} of {submission.total} save request{submission.failed !== 1 ? 's' : ''} failed. {submission.succeeded} succeeded.
                  </span>
                  <button className="btn btn-danger btn-sm" onClick={handleRetrySubmission}>
                    Retry Failed ({submission.failed})
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="loading-layout" style={{ flex: 1, minHeight: 0 }}>
            <div className="card consignee-panel" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0, flexDirection: 'row', height: '100%' }} className="consignee-wagons-layout">

                {/* ── Consignees column ── */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0, borderRight: '1px solid var(--border-subtle)' }} className="consignee-column">
                <div style={{ padding: '5px 8px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>
                      Consignees ({filteredConsignees.length})
                    </div>
                    <div className="search-input-wrapper">
                      <span className="search-icon"><SearchIcon size={12} /></span>
                      <input
                        className="form-control"
                        placeholder="Search…"
                        value={consigneeSearch}
                        onChange={e => setConsigneeSearch(e.target.value)}
                        style={{ fontSize: 11.5, padding: '4px 8px 4px 26px' }}
                      />
                    </div>
                  </div>

                  <div className="consignee-list" style={{ flex: 1, overflowY: 'auto', padding: '6px 8px' }}>
                    {filteredConsignees.map(c => {
                      const loadedCount = c.plates.filter(p => p.loaded).length
                      const loadedWeight = c.plates.filter(p => p.loaded && p.pcWgt).reduce((sum, p) => sum + (parseFloat(p.pcWgt) || 0), 0)
                      const hasOkPlates = c.plates.some(p => p.plateType === 'OK')
                      const nonOkCount = c.plates.filter(p => p.plateType !== 'OK').length
                      const hasLoaded = loadedCount > 0

                      return (
                        <div
                          key={c.consigneeCode}
                          className={`consignee-card ${activeCode === c.consigneeCode ? 'active' : ''} ${hasLoaded ? 'done' : ''}`}
                          onClick={() => handleSelectConsignee(c.consigneeCode)}
                        >
                          {/* Row 1: code badge + name + status badges */}
                          <div className="consignee-card-top">
                            <span className="consignee-code-badge">{c.consigneeCode}</span>
                            <span className="consignee-name">{c.consigneeName}</span>
                            <div style={{ display: 'flex', gap: 4, flexShrink: 0, marginLeft: 'auto' }}>
                              {!hasOkPlates && <span className="badge badge-neutral" style={{ fontSize: 9.5, padding: '1px 6px' }}>No OK</span>}
                              {hasLoaded && <span className="badge badge-success" style={{ fontSize: 9.5, padding: '1px 6px' }}><span className="badge-dot" />Loaded</span>}
                            </div>
                          </div>

                          {/* Row 2: load count + weight (left) • non-OK type pills (right) */}
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                            {loadedCount > 0 ? (
                              <span className="consignee-count">
                                <strong>{loadedCount}</strong> loaded{loadedWeight > 0 ? <> • <strong style={{ color: 'var(--navy-600)', fontFamily: 'var(--font-mono)' }}>{loadedWeight.toFixed(1)}T</strong></> : ''}
                              </span>
                            ) : (
                              <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>No plates loaded</span>
                            )}
                            {nonOkCount > 0 && (
                              <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
                                {['RA', 'TPI', 'MTI', 'DIV', 'ZCMO'].map(type => {
                                  const cnt = c.plates.filter(p => p.plateType === type).length
                                  if (!cnt) return null
                                  const cfg = PLATE_TYPE_CFG[type]
                                  return (
                                    <span key={type} style={{ fontSize: 9.5, padding: '1px 5px', borderRadius: 'var(--r-full)', background: cfg.bg, color: cfg.color, fontWeight: 700 }}>
                                      {type}:{cnt}
                                    </span>
                                  )
                                })}
                              </div>
                            )}
                          </div>

                          {/* Row 3: wagon chips */}
                          {(() => {
                            const cWagons = wagons.filter(w => w.consigneeCode === c.consigneeCode)
                            return (
                              <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'center', marginTop: 2 }}>
                                <WagonIcon size={10} />
                                {cWagons.length > 0
                                  ? cWagons.map(w => (
                                    <span key={w.wagonNo} style={{ fontSize: 9.5, padding: '1px 5px', borderRadius: 'var(--r-full)', background: 'var(--navy-100)', color: 'var(--navy-700)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                                      {w.wagonNo}
                                    </span>
                                  ))
                                  : <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>No wagon</span>
                                }
                              </div>
                            )
                          })()}
                        </div>
                      )
                    })}
                  </div>
                </div>

                {/* ── Wagons column ── */}
                <div style={{ width: 170, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }} className="wagons-column">
                  <div style={{ padding: '5px 8px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span>Wagons ({wagons.length})</span>
                      {activeWagon && (
                        <span style={{ fontSize: 9.5, color: 'var(--navy-600)', fontFamily: 'var(--font-mono)', fontWeight: 700, maxWidth: 72, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          ◉ {activeWagon}
                        </span>
                      )}
                    </div>
                    <div className="search-input-wrapper">
                      <span className="search-icon"><SearchIcon size={12} /></span>
                      <input
                        className="form-control"
                        placeholder="Search…"
                        value={wagonSearch}
                        onChange={e => setWagonSearch(e.target.value)}
                        style={{ fontSize: 11.5, padding: '4px 8px 4px 26px' }}
                      />
                    </div>
                  </div>
                  <div style={{ flex: 1, overflowY: 'auto', padding: '4px 8px 8px' }}>
                    {filteredWagons.length === 0 ? (
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', textAlign: 'center', padding: '12px 0' }}>
                        {wagonSearch ? 'No matches.' : 'No wagons in this rake.'}
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 4 }}>
                        {filteredWagons.map(w => {
                          const isActive = activeWagon === w.wagonNo
                          const assignedCons = w.consigneeCode
                            ? (session.consignees.find(c => c.consigneeCode === w.consigneeCode) ||
                               Object.values(sessions).flatMap(s => s.consignees).find(c => c.consigneeCode === w.consigneeCode))
                            : null
                          const isForActiveCons = w.consigneeCode === activeCode
                          const canSelect = !w.consigneeCode || w.consigneeCode === activeCode
                          const platesLoaded = session.consignees.flatMap(c => c.plates).filter(p => p.wagonNo === w.wagonNo && p.loaded).length
                          const totalLoadedWeight = session.consignees.flatMap(c => c.plates).filter(p => p.wagonNo === w.wagonNo && p.loaded && p.pcWgt).reduce((sum, p) => sum + (parseFloat(p.pcWgt) || 0), 0)
                          return (
                            <div
                              key={w.wagonNo}
                              style={{
                                display: 'flex', gap: 4, alignItems: 'stretch',
                                borderRadius: 'var(--r-md)',
                                overflow: 'hidden',
                              }}
                            >
                              {/* Wagon Content - 80% */}
                              <div
                                onClick={() => canSelect
                                  ? handleSelectWagon(w.wagonNo)
                                  : toast.error(`Wagon ${w.wagonNo} is assigned to ${assignedCons?.consigneeName || w.consigneeCode}`)
                                }
                                style={{
                                  flex: '0 0 calc(100% - 32px)',
                                  display: 'flex', flexDirection: 'column', gap: 5,
                                  padding: '7px 8px',
                                  borderRadius: 'var(--r-md)',
                                  border: `${isActive ? '2px' : '1.5px'} solid ${isActive ? 'var(--navy-600)' : canSelect ? 'var(--border-subtle)' : 'var(--border-default)'}`,
                                  background: isActive ? 'var(--navy-100)' : canSelect ? 'var(--bg-surface)' : 'var(--gray-50)',
                                  boxShadow: isActive ? '0 0 0 3px rgba(59,110,196,0.2), var(--shadow-md)' : 'none',
                                  cursor: canSelect ? 'pointer' : 'not-allowed',
                                  opacity: !canSelect ? 0.55 : 1,
                                  userSelect: 'none',
                                }}
                              >
                                {/* Header: Wagon# and Load Stats */}
                                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, width: '100%' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 3, flex: 1, minWidth: 0 }}>
                                    <WagonIcon size={11} style={{ flexShrink: 0 }} />
                                    <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 11.5, color: isActive ? 'var(--navy-700)' : 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                      {w.wagonNo}
                                    </span>
                                  </div>
                                  {platesLoaded > 0 && (
                                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 3, flexShrink: 0 }}>
                                      <span style={{ fontSize: 9.5, color: 'var(--green-700)', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
                                        {platesLoaded} Plates /
                                      </span>
                                      {totalLoadedWeight > 0 && (
                                        <span style={{ fontSize: 9, color: 'var(--green-700)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
                                          {totalLoadedWeight.toFixed(1)}T
                                        </span>
                                      )}
                                    </div>
                                  )}
                                </div>

                                {/* Consignee Info */}
                                <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                                  {assignedCons ? (
                                    <div style={{ fontSize: 10, color: isForActiveCons ? 'var(--navy-600)' : 'var(--text-muted)', fontWeight: isForActiveCons ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
                                      {assignedCons.consigneeName}
                                    </div>
                                  ) : (
                                    <div style={{ fontSize: 9.5, color: 'var(--text-muted)', fontStyle: 'italic' }}>Unassigned</div>
                                  )}
                                  {isActive && (
                                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--navy-500)', flexShrink: 0 }} />
                                  )}
                                </div>
                              </div>

                              {/* Unlink Button - 20% */}
                              {isForActiveCons && (
                                <button
                                  title="Unlink wagon from this consignee"
                                  onClick={e => { e.stopPropagation(); handleUnlinkWagon(w.wagonNo) }}
                                  style={{
                                    flex: '0 0 32px',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    background: 'var(--red-50)',
                                    border: '1.5px solid var(--red-200)',
                                    borderRadius: 'var(--r-md)',
                                    cursor: 'pointer',
                                    color: 'var(--red-600)',
                                    padding: 0,
                                    transition: 'all 0.15s ease',
                                  }}
                                  onMouseEnter={e => {
                                    e.currentTarget.style.background = 'var(--red-100)'
                                    e.currentTarget.style.borderColor = 'var(--red-300)'
                                  }}
                                  onMouseLeave={e => {
                                    e.currentTarget.style.background = 'var(--red-50)'
                                    e.currentTarget.style.borderColor = 'var(--red-200)'
                                  }}
                                >
                                  <span style={{ fontSize: 16, fontWeight: 600, lineHeight: 1 }}>×</span>
                                </button>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </div>

              </div>
            </div>

            <div className="card active-panel" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
              {!activeConsignee ? (
                <div className="empty-state" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                  <div className="empty-state-icon"><SelectIcon size={22} /></div>
                  <div className="empty-state-title">Select a Consignee</div>
                  <div className="empty-state-text">Click a consignee on the left to begin loading its plates into the assigned wagon.</div>
                </div>
              ) : (
                <>
                  <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-surface-2)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                      <span className="consignee-code-badge" style={{ fontSize: 13 }}>{activeConsignee.consigneeCode}</span>
                      <span style={{ fontWeight: 700, fontSize: 15.5, flex: 1 }}>{activeConsignee.consigneeName}</span>
                      {activeWagon ? (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', background: 'var(--navy-100)', borderRadius: 'var(--r-full)', fontSize: 12, fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--navy-700)' }}>
                          <WagonIcon size={12} /> {activeWagon}
                        </span>
                      ) : (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', border: '1px dashed var(--border-default)', borderRadius: 'var(--r-full)', fontSize: 12, color: 'var(--text-muted)' }}>
                          <WagonIcon size={12} /> Select wagon
                        </span>
                      )}
                    </div>

                    {okPlates.length == 0 ? (
                      <div className="alert alert-warning" style={{ padding: '8px 12px', fontSize: 12 }}>
                        <WarnIcon size={13} />
                        No OK plates for this consignee yet.
                      </div>
                    ) : (
                      <div>
                      </div>
                    )}

                    {!activeWagon && allActivePlates.length > 0 && (
                      <div className="flag-row" style={{ marginTop: 8 }}>
                        <WarnIcon size={13} />
                        <span>No wagon selected. Select a wagon from the left panel before marking plates as loaded.</span>
                      </div>
                    )}

                    {nonOkPlates.length > 0 && (
                      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Other plate types:</span>
                        {['RA', 'TPI', 'MTI', 'DIV', 'ZCMO'].map(type => {
                          const cnt = nonOkPlates.filter(p => p.plateType === type).length
                          if (!cnt) return null
                          const cfg = PLATE_TYPE_CFG[type]
                          return (
                            <span
                              key={type}
                              title={cfg.desc}
                              style={{ fontSize: 10.5, padding: '2px 8px', borderRadius: 'var(--r-full)', background: cfg.bg, color: cfg.color, fontWeight: 600 }}
                            >
                              {cnt} {cfg.label} - {cfg.desc}
                            </span>
                          )
                        })}
                      </div>
                    )}
                  </div>

                  <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', gap: 8, alignItems: 'center' }}>
                    <div className="search-input-wrapper" style={{ flex: '1 1 36%', minWidth: 120 }}>
                      <span className="search-icon"><SearchIcon size={13} /></span>
                      <input
                        className="form-control"
                        placeholder="Filter by plate no., heat, order no..."
                        value={plateFilter}
                        onChange={e => setPlateFilter(e.target.value)}
                        style={{ fontSize: 12.5 }}
                      />
                    </div>
                    <select
                      className="form-control"
                      value={gradeFilter}
                      onChange={e => setGradeFilter(e.target.value)}
                      style={{ fontSize: 12, flex: '1 1 14%', minWidth: 70 }}
                    >
                      <option value="">All Grades</option>
                      {gradeOptions.map(g => <option key={g} value={g}>{g}</option>)}
                    </select>
                    <select
                      className="form-control"
                      value={tdcFilter}
                      onChange={e => setTdcFilter(e.target.value)}
                      style={{ fontSize: 12, flex: '1 1 14%', minWidth: 70 }}
                    >
                      <option value="">All TDC</option>
                      {tdcOptions.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <select
                      className="form-control"
                      value={typeFilter}
                      onChange={e => setTypeFilter(e.target.value)}
                      style={{ fontSize: 12, flex: '1 1 14%', minWidth: 70 }}
                    >
                      <option value="">All Types</option>
                      <option value="OK">OK</option>
                      <option value="ZCMO">ZCMO</option>
                      <option value="RA">RA</option>
                      <option value="TPI">TPI</option>
                      <option value="MTI">MTI</option>
                      <option value="DIV">DIV</option>
                    </select>
                    <label
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5,
                        color: 'var(--text-secondary)', whiteSpace: 'nowrap', cursor: 'pointer',
                        flex: '0 0 auto', userSelect: 'none',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={showLoaded}
                        onChange={e => setShowLoaded(e.target.checked)}
                        style={{ cursor: 'pointer' }}
                      />
                      Show Loaded
                    </label>
                    {(plateFilter || gradeFilter || tdcFilter || typeFilter) && (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => { setPlateFilter(''); setGradeFilter(''); setTdcFilter(''); setTypeFilter('') }}
                        style={{ flex: '0 0 auto', fontSize: 11.5, color: 'var(--red-600)', whiteSpace: 'nowrap', padding: '4px 10px' }}
                      >
                        × Clear Filters
                      </button>
                    )}
                  </div>

                  <div className="plate-list" style={{ flex: 1, padding: '8px 14px', overflowY: 'auto' }}>
                    {allActivePlates.length === 0 && (
                      <div className="empty-state" style={{ padding: '20px 0' }}>
                        <div className="empty-state-icon"><PlateIcon size={20} /></div>
                        <div className="empty-state-title">No plates</div>
                        <div className="empty-state-text">Plates appear here once heat/BFD allocation is complete.</div>
                      </div>
                    )}

                    {allActivePlates.length > 0 && visibleAllPlates.length === 0 && (
                      <div className="empty-state" style={{ padding: '12px 0' }}>
                        <div className="empty-state-text">No plates match the filter.</div>
                      </div>
                    )}

                    {visibleAllPlates.length > 0 && visibleAllPlates.map((p, idx) => {
                      const cfg = p.plateType === 'OK' ? null : (PLATE_TYPE_CFG[p.plateType] || PLATE_TYPE_CFG.DIV)
                      const currentWagon = p.wagonNo || '(No Wagon)'
                      const prevWagon = idx > 0 ? (visibleAllPlates[idx - 1].wagonNo || '(No Wagon)') : null
                      const showWagonHeader = currentWagon !== prevWagon
                      const orderForPlate = activeConsignee?.orders?.find(o => o.ordNo === p.ordNo)
                      const balValue = orderForPlate?.bal ?? null
                      const remark = orderForPlate?.remark || ''
                      const lockInfo = p.plateType === 'ZCMO' ? lockedPlates[p.plateNo] : null
                      const isLockedByOther = Boolean(
                        lockInfo && lockInfo.lockedBy !== (user?.username || 'unknown')
                      )

                      return (
                        <React.Fragment key={p.plateNo}>
                          {showWagonHeader && (
                            <div style={{
                              margin: '10px 0 5px',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              paddingLeft: 4,
                              borderLeft: `3px solid ${p.wagonNo ? 'var(--navy-400)' : 'var(--border-subtle)'}`
                            }}>
                              <WagonIcon size={13} style={{ color: p.wagonNo ? 'var(--navy-600)' : 'var(--text-muted)' }} />
                              <span style={{
                                fontSize: 11.5,
                                fontFamily: 'var(--font-mono)',
                                fontWeight: 700,
                                color: p.wagonNo ? 'var(--navy-700)' : 'var(--text-muted)',
                                minWidth: 60
                              }}>
                                {currentWagon}
                              </span>
                            </div>
                          )}
                          <div
                            className={`plate-item ${p.loaded ? 'loaded' : ''}`}
                            onClick={() => isLockedByOther ? undefined : togglePlate(activeCode, p.plateNo)}
                            title={isLockedByOther ? `Locked by ${lockInfo.lockedBy}` : undefined}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 6,
                              opacity: isLockedByOther ? 0.52 : 1,
                              cursor: isLockedByOther ? 'not-allowed' : 'pointer',
                              background: isLockedByOther ? 'var(--gray-100)' : undefined,
                              borderColor: isLockedByOther ? 'var(--border-subtle)' : undefined,
                              pointerEvents: isLockedByOther ? 'none' : undefined,
                            }}
                          >
                            <div className="plate-check">{p.loaded && <CheckIcon size={11} />}</div>
                            {cfg && (
                              <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 'var(--r-full)', background: cfg.bg, color: cfg.color, fontWeight: 700, flexShrink: 0 }}>
                                {cfg.label}
                              </span>
                            )}
                            {isLockedByOther && (
                              <span style={{
                                display: 'inline-flex', alignItems: 'center', gap: 3,
                                fontSize: 9, padding: '1px 6px', borderRadius: 'var(--r-full)',
                                background: 'var(--gray-200)', color: 'var(--gray-700)',
                                fontWeight: 700, flexShrink: 0,
                              }}>
                                <LockIcon size={9} /> {lockInfo.lockedBy}
                              </span>
                            )}
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: 'flex', alignItems: 'baseline', gap: 2, marginBottom: 2 }}>
                                <span className="plate-no" style={{ fontSize: 12.5, fontWeight: 600 }}>{p.plateNo}</span>
                                {p._external && (
                                  <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 'var(--r-full)', background: 'var(--amber-100)', color: 'var(--amber-700)', fontWeight: 600, flexShrink: 0 }}>
                                    DSP
                                  </span>
                                )}
                              </div>
                              <div style={{ fontSize: 10.5, color: 'var(--text-secondary)', display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
                                <span className="plate-grade" style={{ fontWeight: 700, color: 'var(--navy-700)' }}>{p.grade}</span>
                                {p.ordSize && <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{p.ordSize}</span>}
                                {p.tdc && <span style={{ fontWeight: 700, color: 'var(--navy-700)' }}>{p.tdc}</span>}
                                {p.pcWgt && <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{p.pcWgt}T </span>}
                                {p.ordNo && <span style={{ fontWeight: 650, color: 'var(--text-secondary)' }}>{p.ordNo}</span>}
                                {remark && <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>  {remark}</span>}
                                {balValue !== null && (
                                  <span
                                    style={{
                                      color: 'var(--navy-700)',
                                      fontWeight: 670,
                                      marginLeft: 2,
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: 4,
                                      animation: balUpdateOrdNo === p.ordNo ? 'pulse 0.6s ease-in-out' : 'none',
                                      transition: 'all 0.15s ease',
                                    }}
                                    title="Balance updates dynamically as you load plates"
                                  >
                                    BAL:
                                    <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>
                                      {balValue}
                                    </span>
                                    {balUpdateOrdNo === p.ordNo && (
                                      <span
                                        style={{
                                          display: 'inline-block',
                                          width: 3,
                                          height: 3,
                                          borderRadius: '50%',
                                          background: 'var(--navy-700)',
                                          animation: 'blink 0.6s ease-in-out',
                                        }}
                                      />
                                    )}
                                  </span>
                                )}
                              </div>
                            </div>
                            {p.colourCd && (
                              <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 'var(--r-full)', background: 'var(--gray-100)', color: 'var(--text-secondary)', whiteSpace: 'nowrap', fontWeight: 500, flexShrink: 0 }}>
                                {p.colourCd}
                              </span>
                            )}
                            {p.loaded && p.wagonNo && (
                              <span style={{ fontSize: 9, color: 'var(--green-700)', fontFamily: 'var(--font-mono)', fontWeight: 600, flexShrink: 0 }}>
                                {p.wagonNo}
                              </span>
                            )}
                            {p.loaded && <span style={{ fontSize: 10, color: 'var(--green-700)', fontWeight: 700, flexShrink: 0 }}>✓</span>}
                            <button
                              className="btn btn-ghost btn-icon"
                              style={{ padding: '2px 3px', flexShrink: 0 }}
                              onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(p.plateNo); toast.success({ message: `Copied: ${p.plateNo}`, duration: 1500 }) }}
                              title="Copy plate number"
                            >
                              <CopyIcon size={12} />
                            </button>
                            <button
                              className="btn btn-ghost btn-icon"
                              style={{ padding: '2px 3px', flexShrink: 0 }}
                              onClick={e => { e.stopPropagation(); handlePlateDetail(p) }}
                              title="Details"
                            >
                              <InfoIcon size={12} />
                            </button>
                          </div>
                        </React.Fragment>
                      )
                    })}
                  </div>

                  {allActivePlates.length > 0 && (
                    <div className="quick-entry" style={{ flexDirection: 'column', gap: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                        <input
                          ref={quickEntryRef}
                          className="form-control mono"
                          placeholder="Type plate number to find & load…"
                          value={quickEntry}
                          onChange={e => handleQuickInputChange(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter' && quickResult) { e.preventDefault(); handleQuickLoad() } }}
                          style={{ fontSize: 13, flex: 1 }}
                        />
                        {quickEntry && (
                          <button
                            className="btn btn-ghost btn-sm btn-icon"
                            onClick={() => { setQuickEntry(''); setQuickResult(null); setQuickError(''); if (!isCoarsePointer()) quickEntryRef.current?.focus() }}
                            title="Clear"
                          >
                            ×
                          </button>
                        )}
                      </div>

                      {isFetchingPlate && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-muted)' }}>
                          <span className="spinner spinner-sm" /> Searching…
                        </div>
                      )}

                      {quickError && (
                        <div className="form-error">{quickError}</div>
                      )}

                      {quickResult && !quickError && (() => {
                        // ── List match (from consignee's own plates) ──
                        if (quickResult.type === 'list') {
                          const p = quickResult.plate
                          return (
                            <div style={{
                              background: p.loaded ? 'var(--green-50)' : 'var(--navy-50)',
                              border: `1px solid ${p.loaded ? 'var(--green-200)' : 'var(--navy-200)'}`,
                              borderRadius: 'var(--r-md)',
                              padding: '8px 10px',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 10,
                              width: '100%',
                            }}>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 13, color: 'var(--navy-700)' }}>{p.plateNo}</span>
                                  {p.loaded && (
                                    <span style={{ fontSize: 9.5, padding: '1px 5px', borderRadius: 'var(--r-full)', background: 'var(--green-100)', color: 'var(--green-700)', fontWeight: 600 }}>Already loaded</span>
                                  )}
                                </div>
                                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2, display: 'flex', flexWrap: 'wrap', gap: '2px 10px' }}>
                                  {p.grade  && <span><span style={{ color: 'var(--text-muted)' }}>Grade </span>{p.grade}</span>}
                                  {p.heatNo && <span style={{ fontFamily: 'var(--font-mono)' }}>{p.heatNo}</span>}
                                  {p.ordSize && <span>{p.ordSize}</span>}
                                  {p.pcWgt && <span>{p.pcWgt}T</span>}
                                  {p.tdc    && <span><span style={{ color: 'var(--text-muted)' }}>TDC </span>{p.tdc}</span>}
                                  {p.ordNo  && <span><span style={{ color: 'var(--text-muted)' }}>Order </span>{p.ordNo}</span>}
                                </div>
                              </div>
                              {!p.loaded ? (
                                <button className="btn btn-success btn-sm" onClick={handleQuickLoad} style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
                                  <CheckIcon size={12} /> Load
                                </button>
                              ) : (
                                <span style={{ fontSize: 11, color: 'var(--green-700)', fontWeight: 600, flexShrink: 0 }}>✓ Done</span>
                              )}
                            </div>
                          )
                        }

                        // ── API search results (array of plates) ──
                        const items = Array.isArray(quickResult.apiInfo) ? quickResult.apiInfo : [quickResult.apiInfo]
                        if (items.length === 0) return null

                        return (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%', maxHeight: 260, overflowY: 'auto' }}>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, padding: '2px 2px' }}>
                              {items.length} result{items.length !== 1 ? 's' : ''} found
                            </div>
                            {items.map((info, i) => {
                              const plateNo  = info?.PLATE_NO || ''
                              const grade    = info?.GRADE || ''
                              const heatNo   = info?.HEAT_NO || ''
                              const size     = info?.PLATE_SIZE || ''
                              const weight   = info?.WGT ? parseFloat(info.WGT) : null
                              const tdc      = info?.TDC || ''
                              const mech     = info?.MECH_RESULT || ''
                              const consigneeNm = info?.CONSIGNEE_NM || ''
                              const ordNo    = info?.ORD_NO || ''
                              const nextJob  = info?.NEXT_JOB || ''
                              const ordStatus = info?.ORD_STATUS || ''
                              const ordFlag  = info?.ORD_FLAG || ''
                              const loadingStatus = info?.LOADING_STATUS || ''
                              const momPlateNo = info?.MOM_PLATE_NO || ''
                              // Check if this plate already exists in the active consignee's list
                              const existingPlate = activeConsignee?.plates.find(p => p.plateNo === plateNo)
                              const alreadyLoaded = existingPlate?.loaded
                              return (
                                <div key={plateNo || i} style={{
                                  background: alreadyLoaded ? 'var(--green-50)' : 'var(--navy-50)',
                                  border: `1px solid ${alreadyLoaded ? 'var(--green-200)' : 'var(--navy-200)'}`,
                                  borderRadius: 'var(--r-md)',
                                  padding: '7px 10px',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 8,
                                  flexShrink: 0,
                                }}>
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
                                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 12.5, color: 'var(--navy-700)' }}>{plateNo}</span>
                                      {loadingStatus && (
                                        <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 'var(--r-full)', background: 'var(--amber-100)', color: 'var(--amber-700)', fontWeight: 600 }}>
                                          {loadingStatus}
                                        </span>
                                      )}
                                      {momPlateNo && momPlateNo !== plateNo && (
                                        <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 'var(--r-full)', background: 'var(--gray-100)', color: 'var(--text-muted)', fontWeight: 500 }}>
                                          MOM: {momPlateNo}
                                        </span>
                                      )}
                                      {alreadyLoaded && (
                                        <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 'var(--r-full)', background: 'var(--green-100)', color: 'var(--green-700)', fontWeight: 600 }}>
                                          Already loaded
                                        </span>
                                      )}
                                    </div>
                                    <div style={{ fontSize: 10.5, color: 'var(--text-secondary)', marginTop: 1, display: 'flex', flexWrap: 'wrap', gap: '1px 8px' }}>
                                      {grade  && <span><span style={{ color: 'var(--text-muted)' }}>Grade </span>{grade}</span>}
                                      {heatNo && <span style={{ fontFamily: 'var(--font-mono)' }}>{heatNo}</span>}
                                      {size   && <span>{size}</span>}
                                      {weight && <span>{weight}T</span>}
                                      {tdc    && <span><span style={{ color: 'var(--text-muted)' }}>TDC </span>{tdc}</span>}
                                      {mech   && <span style={{ color: mech === 'OK' ? 'var(--green-700)' : 'var(--amber-700)', fontWeight: 600 }}>{mech}</span>}
                                      {consigneeNm && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 140 }} title={consigneeNm}>{consigneeNm}</span>}
                                      {ordNo  && <span><span style={{ color: 'var(--text-muted)' }}>Order </span>{ordNo}</span>}
                                      {nextJob && <span><span style={{ color: 'var(--text-muted)' }}>Next </span>{nextJob}</span>}
                                      {ordStatus && <span><span style={{ color: 'var(--text-muted)' }}>Status </span>{ordStatus}</span>}
                                      {ordFlag && <span><span style={{ color: 'var(--text-muted)' }}>Flag </span>{ordFlag}</span>}
                                    </div>
                                  </div>
                                  {!alreadyLoaded ? (
                                    <button
                                      className="btn btn-success btn-sm"
                                      onClick={() => handleQuickLoad(info)}
                                      style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
                                    >
                                      <CheckIcon size={12} /> Load
                                    </button>
                                  ) : (
                                    <span style={{ fontSize: 11, color: 'var(--green-700)', fontWeight: 600, flexShrink: 0 }}>✓ Done</span>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        )
                      })()}

                      {/* {!quickResult && !quickError && !isFetchingPlate && (
                        <div className="form-hint">Type a plate number to search. Found plates show a Load button.</div>
                      )} */}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {step === 'COMPLETED' && session && (
        <div style={{ maxWidth: 700, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card" style={{ border: '2px solid var(--green-200)' }}>
            <div className="card-header" style={{ background: 'var(--green-50)' }}>
              <div className="card-icon" style={{ background: 'var(--green-100)', color: 'var(--green-700)' }}>
                <CheckCircleIcon />
              </div>
              <div>
                <div className="card-title" style={{ color: 'var(--green-700)' }}>Loading Session Completed</div>
                <div className="card-subtitle">Rake {session.rakeId} - {session.destination?.name}</div>
              </div>
              <span className="badge badge-success" style={{ marginLeft: 'auto' }}><span className="badge-dot" />Completed</span>
            </div>
            <div className="card-body">
              {submission.status !== 'idle' && (
                <div style={{ marginBottom: 16 }}>
                  {submission.status === 'submitting' && (
                    <div className="alert alert-info" style={{ alignItems: 'center', gap: 10 }}>
                      <span className="spinner spinner-sm" />
                      <span>Submitting wagon records… {submission.succeeded + submission.failed} / {submission.total}</span>
                    </div>
                  )}
                  {submission.status === 'done' && (
                    <div className="alert alert-success">
                      <CheckCircleIcon size={15} />
                      <span>All {submission.succeeded} wagon record{submission.succeeded !== 1 ? 's' : ''} marked as completed.</span>
                    </div>
                  )}
                  {submission.status === 'partial' && (
                    <div className="alert alert-danger" style={{ flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <WarnIcon size={15} />
                        <span>
                          <strong>{submission.failed} of {submission.total}</strong> wagon submission{submission.failed !== 1 ? 's' : ''} failed.
                          {' '}{submission.succeeded} succeeded.
                        </span>
                      </div>
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={handleRetrySubmission}
                        disabled={submission.status === 'submitting'}
                      >
                        Retry Failed ({submission.failed})
                      </button>
                    </div>
                  )}
                </div>
              )}
              <div className="stat-grid" style={{ marginBottom: 20 }}>
                <div className="stat-tile"><div className="stat-label">Total Weight (T)</div><div className="stat-value">{completedLoadedWeight.toFixed(2)}</div></div>
                <div className="stat-tile"><div className="stat-label">Plates Loaded</div><div className="stat-value" style={{ color: 'var(--green-700)' }}>{completedLoaded}</div></div>
                <div className="stat-tile"><div className="stat-label">Consignees</div><div className="stat-value">{completedConsigneesWithLoads}</div></div>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                <button className="btn btn-primary btn-lg" onClick={handleExportPdf} disabled={exporting}>
                  {exporting ? <><span className="spinner spinner-sm" />Generating...</> : <><PdfIcon /> Download PDF</>}
                </button>
                <button className="btn btn-ghost" onClick={() => {
                  setStep('RAKE_ENTRY')
                  setSession(null)
                  setSessions({})
                  setRakeInput('')
                  setRakeInfo(null)
                  setSelectedDest(null)
                  setActiveCode(null)
                  setActiveWagon(null)
                  setWagons([])
                  localStorage.removeItem(SESSION_KEY)
                  localStorage.removeItem(SESSIONS_MAP_KEY)
                  loadedDetailsRef.current = null
                }}>
                  Start New Session
                </button>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header"><div className="card-title">Wagon Summary</div></div>
            <div className="table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Wagon No.</th>
                    <th>Consignee</th>
                    <th>Destination</th>
                    <th>Plates Loaded</th>
                    <th>Weight Loaded</th>
                    <th>Marked Complete</th>
                  </tr>
                </thead>
                <tbody>
                  {wagonSummary.map(w => (
                    <tr key={w.wagonNo}>
                      <td>
                        <div className="td-mono" style={{ fontWeight: 600, fontSize: 12 }}>{w.wagonNo}</div>
                      </td>
                      <td>
                        <div style={{ fontWeight: 500 }}>{w.consigneeName}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{w.consigneeCode}</div>
                      </td>
                      <td>
                        {w.destination ? (
                          <div>
                            <div style={{ fontWeight: 500 }}>{w.destination.name}</div>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{w.destination.code}</div>
                          </div>
                        ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                      </td>
                      <td className="td-mono" style={{ color: 'var(--green-700)', fontWeight: 600 }}>{w.platesCount}</td>
                      <td className="td-mono" style={{ fontWeight: 600 }}>{w.totalWeight > 0 ? `${w.totalWeight.toFixed(1)}T` : <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                      <td>
                        {w.isCompleted ? (
                          <span className="badge badge-success" style={{ fontSize: 10.5 }}>
                            <span className="badge-dot" />Completed
                          </span>
                        ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <Modal
        open={Boolean(plateDetail)}
        onClose={() => setPlateDetail(null)}
        title={plateDetail ? `Plate — ${plateDetail.plateNo}` : 'Plate Details'}
        size="modal-sm"
      >
        {plateDetail && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {(plateDetail.plateType !== 'OK' || !plateDetail._apiInfo) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                {plateDetail.plateType !== 'OK' && (() => {
                  const cfg = PLATE_TYPE_CFG[plateDetail.plateType]
                  return <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 'var(--r-full)', background: cfg?.bg, color: cfg?.color, fontWeight: 700 }}>{cfg?.label}</span>
                })()}
                {!plateDetail._apiInfo && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                    <span className="spinner spinner-sm" /> Fetching details…
                  </span>
                )}
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {[
                ['Heat No.',    plateDetail._apiInfo?.HEAT_NO   || plateDetail.heatNo],
                ['Grade',       plateDetail._apiInfo?.GRADE     || plateDetail.grade],
                ['TDC',         plateDetail._apiInfo?.TDC       || plateDetail.tdc],
                ['Colour',      plateDetail._apiInfo?.COLOUR_CD || plateDetail.colourCd],
                ['Size',        plateDetail._apiInfo?.PLATE_SIZE || plateDetail.ordSize],
                ['Weight',      (plateDetail._apiInfo?.WGT || plateDetail.pcWgt) ? `${plateDetail._apiInfo?.WGT || plateDetail.pcWgt} T` : null],
                ['Order',       plateDetail._apiInfo?.ORD_NO    || plateDetail.ordNo],
                ['Mech Result', plateDetail._apiInfo?.MECH_RESULT || null],
                ['Loadable',    plateDetail._apiInfo?.LOADABLE  || null],
                ['Next Job',    plateDetail._apiInfo?.NEXT_JOB  || null],
                ['Consignee',   plateDetail._apiInfo?.CONSIGNEE_NM || null],
              ].map(([label, val]) => val ? (
                <div key={label} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '7px 0', borderBottom: '1px solid var(--border-subtle)' }}>
                  <span style={{ color: 'var(--text-muted)', minWidth: 88, fontSize: 12, flexShrink: 0 }}>{label}</span>
                  <span style={{ fontWeight: 600, fontSize: 13, fontFamily: ['Heat No.', 'Weight'].includes(label) ? 'var(--font-mono)' : 'inherit' }}>{val}</span>
                </div>
              ) : null)}
            </div>
          </div>
        )}
      </Modal>
      {/* developed by github.com/ishans2404 */}
      <Modal
        open={showCompleteModal}
        onClose={() => setShowCompleteModal(false)}
        title="Complete Wagons"
        size="modal-lg"
        footer={
          <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', width: '100%' }}>
            <button className="btn btn-ghost btn-sm" onClick={() => {
              const allSess = session ? { ...sessions, [session.destination.code]: session } : sessions
              const wagonsWithPlates = wagons.filter(w =>
                Object.values(allSess).some(s => s?.consignees?.some(c => c.plates.some(p => p.loaded && p.wagonNo === w.wagonNo)))
              )
              setWagonsToComplete(new Set(wagonsWithPlates.map(w => w.wagonNo)))
            }}>Select All</button>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowCompleteModal(false)}>Cancel</button>
              <button
                className="btn btn-success btn-sm"
                onClick={handleCompleteWagons}
                disabled={wagonsToComplete.size === 0}
              >
                <CompleteIcon /> Complete{wagonsToComplete.size > 0 ? ` (${wagonsToComplete.size})` : ''} Wagon{wagonsToComplete.size !== 1 ? 's' : ''}
              </button>
            </div>
          </div>
        }
      >
        {session && (() => {
          const allSess = { ...sessions, [session.destination.code]: session }
          const wagonsWithPlates = wagons.filter(w =>
            Object.values(allSess).some(s => s?.consignees?.some(c => c.plates.some(p => p.loaded && p.wagonNo === w.wagonNo)))
          )
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="alert alert-info" style={{ fontSize: 12.5 }}>
                <InfoIcon size={14} />
                Select wagons to mark as completed. This is a final action - it confirms loading is done for those wagons.
              </div>
              {wagonsWithPlates.length === 0 ? (
                <div className="empty-state" style={{ padding: '20px 0' }}>
                  <div className="empty-state-title">No wagons with loaded plates</div>
                  <div className="empty-state-text">Load plates into wagons before completing.</div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {wagonsWithPlates.map(w => {
                    const isSelected = wagonsToComplete.has(w.wagonNo)
                    const allConsignees = Object.values(allSess).flatMap(s => s?.consignees || [])
                    const cons = allConsignees.find(c => c.consigneeCode === w.consigneeCode)
                    const loadedPlatesForWagon = allConsignees
                      .flatMap(c => c.plates)
                      .filter(p => p.wagonNo === w.wagonNo && p.loaded)
                    const platesLoaded = loadedPlatesForWagon.length
                    const totalWgt = loadedPlatesForWagon
                      .filter(p => p.pcWgt)
                      .reduce((sum, p) => sum + (parseFloat(p.pcWgt) || 0), 0)
                    return (
                      <div
                        key={w.wagonNo}
                        onClick={() => setWagonsToComplete(prev => {
                          const next = new Set(prev)
                          next.has(w.wagonNo) ? next.delete(w.wagonNo) : next.add(w.wagonNo)
                          return next
                        })}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
                          border: `${isSelected ? '2px' : '1px'} solid ${isSelected ? 'var(--green-400)' : 'var(--border-subtle)'}`,
                          borderRadius: 'var(--r-md)',
                          background: isSelected ? 'var(--green-50)' : 'var(--bg-surface)',
                          cursor: 'pointer', userSelect: 'none', transition: 'all 0.15s ease',
                        }}
                      >
                        <div style={{
                          width: 18, height: 18, borderRadius: 'var(--r-sm)',
                          border: `2px solid ${isSelected ? 'var(--green-600)' : 'var(--border-default)'}`,
                          background: isSelected ? 'var(--green-600)' : 'var(--bg-surface)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: '#fff',
                        }}>
                          {isSelected && <CheckIcon size={10} />}
                        </div>
                        <WagonIcon size={14} />
                        <div style={{ flex: 1 }}>
                          <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 13 }}>{w.wagonNo}</div>
                          {cons && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>{cons.consigneeName} · {w.consigneeCode}</div>}
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--green-700)', fontWeight: 700 }}>{platesLoaded} plate{platesLoaded !== 1 ? 's' : ''}</div>
                          {totalWgt > 0 && <div style={{ fontSize: 10.5, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{totalWgt.toFixed(2)} T</div>}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })()}
      </Modal>
    </AppShell>
  )
}

function StepBar({ steps, active }) {
  return (
    <div className="steps">
      {steps.map((label, i) => (
        <React.Fragment key={label}>
          <div className={`step ${i < active ? 'done' : i === active ? 'active' : ''}`}>
            <div className="step-circle">{i < active ? <CheckIcon size={11} /> : i + 1}</div>
            <span className="step-label">{label}</span>
          </div>
          {i < steps.length - 1 && <div className={`step-connector ${i < active ? 'done' : ''}`} />}
        </React.Fragment>
      ))}
    </div>
  )
}

function LoadIcon({ size = 16 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
    <polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line x1="12" y1="22.08" x2="12" y2="12" />
  </svg>
}

function DestIcon({ size = 16 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" /><circle cx="12" cy="10" r="3" />
  </svg>
}

function SearchIcon({ size = 16 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
}

function WagonIcon({ size = 16 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="1" y="3" width="15" height="13" rx="1" /><path d="M16 8h4l3 3v5h-7V8z" />
    <circle cx="5.5" cy="18.5" r="2.5" /><circle cx="18.5" cy="18.5" r="2.5" />
  </svg>
}

function CheckIcon({ size = 14 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
}

function CheckCircleIcon({ size = 16 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 11.08V12a10 10 0 11-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
  </svg>
}

function ArrowRightIcon({ size = 15 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
  </svg>
}

function BackIcon({ size = 14 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6" /></svg>
}

function InfoIcon({ size = 15 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
    <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
  </svg>
}

function WarnIcon({ size = 14 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
    <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
}

function SelectIcon({ size = 22 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
  </svg>
}

function PlateIcon({ size = 20 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="7" width="20" height="10" rx="1" /><rect x="5" y="4" width="14" height="3" rx="1" />
  </svg>
}

function UnlinkIcon({ size = 14 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/>
    <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>
    <line x1="4" y1="4" x2="20" y2="20"/>
  </svg>
}

function CompleteIcon({ size = 14 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
}

function SaveIcon({ size = 14 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/>
    <polyline points="17 21 17 13 7 13 7 21"/>
    <polyline points="7 3 7 8 15 8"/>
  </svg>
}

function CopyIcon({ size = 14 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
  </svg>
}

function JsonIcon({ size = 14 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </svg>
}

function PdfIcon({ size = 14 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
    <polyline points="14 2 14 8 20 8" /><path d="M9 13h.01M15 13h.01M9 17h6" />
  </svg>
}

function LockIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2"/>
      <path d="M7 11V7a5 5 0 0110 0v4"/>
    </svg>
  )
}
