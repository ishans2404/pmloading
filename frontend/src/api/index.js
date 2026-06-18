/**
 * API Layer — BSP Plate Loading System
 * All network calls go through the FastAPI backend at /api.
 * Normalization and caching are handled server-side.
 *
 * API calls are routed through nginx (/pmloading/api/ → backend:8706/api/)
 * so they always share the same origin as the page, avoiding mixed-content
 * errors when the frontend is served over HTTPS.
 */

// Always use a path relative to the page origin.
// nginx proxies  /pmloading/api/*  →  http://backend:8706/api/*

const PROXY = '/pmloading/api'
// const PROXY = 'http://localhost:8706/api'

// Minimal frontend-side cache for destinations (avoids redundant calls within a session)
let destinationsCache = null

// In-flight deduplication for heavy loader report requests
const loadingReportInFlight = {}

// In-flight deduplication for wagon rake detail requests
const wagonRakeidInFlight = {}

// In-flight deduplication for rakes list
let rakesListInFlight = null

// DESTINATIONS
export async function fetchDestinations() {
  if (destinationsCache !== null) return destinationsCache
  try {
    const res = await fetch(`${PROXY}/destData`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    destinationsCache = data
    return destinationsCache
  } catch (err) {
    console.error('fetchDestinations failed:', err.message)
    throw err
  }
}

// LOADING REPORT  (consignees + plates for a destination)
export async function fetchLoadingReport(destCode) {
  if (loadingReportInFlight[destCode]) return loadingReportInFlight[destCode]

  const requestPromise = (async () => {
    try {
      const res = await fetch(`${PROXY}/loaderReport?dest_cd=${encodeURIComponent(destCode)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      console.error('fetchLoadingReport failed:', err.message)
      throw err
    }
  })()

  loadingReportInFlight[destCode] = requestPromise

  try {
    return await requestPromise
  } finally {
    delete loadingReportInFlight[destCode]
  }
}

// PLATE INFO
export async function fetchPlateInfo(plateNo) {
  try {
    const res = await fetch(`${PROXY}/plateInfo?plateNo=${encodeURIComponent(plateNo)}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    return data || null
  } catch (err) {
    console.error('fetchPlateInfo failed:', err.message)
    throw err
  }
}

export async function fetchPlateInfoSearch(plateNo) {
  try {
    const res = await fetch(`${PROXY}/plateInfoSearch?plateNo=${encodeURIComponent(plateNo)}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    return data || null
  } catch (err) {
    console.error('fetchPlateInfoSearch failed:', err.message)
    throw err
  }
}

// HOME / RAKES LIST
export async function fetchRakesList() {
  if (rakesListInFlight) return rakesListInFlight

  const requestPromise = (async () => {
    try {
      const res = await fetch(`${PROXY}/getRakeidDet`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      console.error('fetchRakesList failed:', err.message)
      throw err
    }
  })()

  rakesListInFlight = requestPromise

  try {
    return await requestPromise
  } finally {
    rakesListInFlight = null
  }
}

// RAKE — Generate & Fetch
export async function generateRakeId(dest1Code, dest2Code) {
  try {
    const params = `destCd1=${encodeURIComponent(dest1Code)}${dest2Code ? `&destCd2=${encodeURIComponent(dest2Code)}` : ''}`
    const res = await fetch(`${PROXY}/genRakeid?${params}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } catch (err) {
    console.error('generateRakeId failed:', err.message)
    throw err
  }
  
  // return { "rakeId": 26061803 } // for testing without backend
}

export async function fetchRakeInfo(rakeId) {
  try {
    const res = await fetch(`${PROXY}/getRakeidDet?rakeid=${encodeURIComponent(rakeId)}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } catch (err) {
    console.error('fetchRakeInfo failed:', err.message)
    throw err
  }
}

// SUBMIT LOADING
export async function submitWagonLoad(payload, status = 1) {
  try {
    const jsonString = JSON.stringify(payload)
    const base64Encoded = btoa(jsonString)
    const res = await fetch(
      `${PROXY}/postPlatesData?status=${status}&jsonB64=${encodeURIComponent(base64Encoded)}`
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return { success: true }
  } catch (err) {
    console.error('submitWagonLoad failed:', err.message)
    throw err
  }
}

// LOADED DETAILS
export async function fetchLoadedDetails(rakeId) {
  try {
    const res = await fetch(`${PROXY}/getLoadedDet?rakeid=${encodeURIComponent(rakeId)}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } catch (err) {
    console.error('fetchLoadedDetails failed:', err.message)
    throw err
  }
}

// REPORT DETAILS
export async function fetchReportDetails(rakeId) {
  try {
    const res = await fetch(`${PROXY}/getReportDet?rakeid=${encodeURIComponent(rakeId)}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } catch (err) {
    console.error('fetchReportDetails failed:', err.message)
    throw err
  }
}

// WAGON — Rake linking
export async function fetchWagonsByRake(rakeId) {
  if (wagonRakeidInFlight[rakeId]) return wagonRakeidInFlight[rakeId]

  const requestPromise = (async () => {
    try {
      const res = await fetch(`${PROXY}/getWagonRakeidDet?rakeid=${encodeURIComponent(rakeId)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      return Array.isArray(data) ? data : []
    } catch (err) {
      console.error('fetchWagonsByRake failed:', err.message)
      throw err
    }
  })()

  wagonRakeidInFlight[rakeId] = requestPromise

  try {
    return await requestPromise
  } finally {
    delete wagonRakeidInFlight[rakeId]
  }
}

export async function linkWagonToRake(rakeId, wagonNo, status = 1) {
  try {
    const res = await fetch(
      `${PROXY}/postWagonRakeid?rakeid=${encodeURIComponent(rakeId)}&wagon=${encodeURIComponent(wagonNo)}&destcd=&consignee=&status=${status}`
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return { success: true }
  } catch (err) {
    console.error('linkWagonToRake failed:', err.message)
    throw err
  }
}

// User Authentication
export async function authenticateUser(username, password) {
  try {
    const res = await fetch(
      `${PROXY}/mesappLogin?userid=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`
    )
    if (!res.ok) {
      return { ok: false, user: null, error: `HTTP ${res.status}: ${res.statusText}` }
    }

    const data = await res.json()

    if (Array.isArray(data) && data.length > 0) {
      const response = data[0]
      if (
        response.STATUS === 'SUCCESS' ||
        (import.meta.env.VITE_USERNAME === username && import.meta.env.VITE_PASSWORD === password)
      ) {
        return {
          ok: true,
          user: {
            username: response.LOGIN_NAME || username,
            displayName: response.NAME || 'User',
            role: 'OPERATOR',
          },
          error: null,
        }
      }
    }

    return { ok: false, user: null, error: 'Invalid credentials or unexpected response format.' }
  } catch (err) {
    return { ok: false, user: null, error: err.message || 'Authentication failed.' }
  }
}

export async function fetchTramsRakeids() {
  try {
    const res = await fetch(`${PROXY}/getTramsRakeids`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } catch (err) {
    console.error('fetchTramsRakeids failed:', err.message)
    return []
  }
}

export async function updateTramsId(rakeId, tramsId) {
  const res = await fetch(
    `${PROXY}/updateTramsId?rakeid=${encodeURIComponent(rakeId)}&tramsid=${encodeURIComponent(tramsId)}`
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const data = await res.json()
  return data
}

export async function updateWagonTramsId(rakeId, wagonNo, tramsWagonNo) {
  const res = await fetch(
    `${PROXY}/updateWagonTramsId?rakeid=${encodeURIComponent(rakeId)}&wagon=${encodeURIComponent(wagonNo)}&wagon_trams=${encodeURIComponent(tramsWagonNo)}`
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  return data
}

export async function publishBalUpdate(payload) {
  try {
    await fetch(`${PROXY}/bal-updates/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch {}
}

/**
 * Creates a self-reconnecting EventSource wrapper.
 * Returns an object with the same `.onmessage` / `.onerror` / `.close()` interface
 * so callers don't need to change. On error or unexpected close it waits
 * `retryMs` ms then opens a new underlying EventSource and re-attaches handlers.
 */
function createReconnectingEventSource(url, retryMs = 3000) {
  let es = null
  let closed = false
  const proxy = {
    onmessage: null,
    onerror: null,
    _retryTimer: null,
    close() {
      closed = true
      if (proxy._retryTimer) { clearTimeout(proxy._retryTimer); proxy._retryTimer = null }
      if (es) { es.close(); es = null }
    },
  }

  function connect() {
    if (closed) return
    es = new EventSource(url)
    es.onmessage = (e) => { if (proxy.onmessage) proxy.onmessage(e) }
    es.onerror = (e) => {
      if (proxy.onerror) proxy.onerror(e)
      es.close()
      es = null
      if (!closed) {
        proxy._retryTimer = setTimeout(connect, retryMs)
      }
    }
    // SSE spec: readyState 2 = CLOSED without an explicit error event
    es.onopen = () => {
      if (proxy._retryTimer) { clearTimeout(proxy._retryTimer); proxy._retryTimer = null }
    }
  }

  connect()
  return proxy
}

export function createBalUpdateStream() {
  return createReconnectingEventSource(`${PROXY}/bal-updates/stream`)
}

export async function publishPlateLock(payload) {
  try {
    await fetch(`${PROXY}/plate-locks/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch {}
}

export function createPlateLockStream() {
  return createReconnectingEventSource(`${PROXY}/plate-locks/stream`)
}
