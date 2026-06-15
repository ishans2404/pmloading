import asyncio
import json
import re
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi_memory import (
    FmCacheManager,
    FmMemoryBackend,
    memorize,
    default_retry,
    is_retryable_httpx_error,
)

from config import config
from normalizers import (
    normalize_destinations,
    normalize_loading_data,
    normalize_rakes_list,
)

_bal_update_clients: list = []
_plate_lock_clients: list = []
_plate_locks: dict = {}  # plateNo -> full lock payload


# ---------------------------------------------------------------------------
# Background cache refresh — runs BEFORE TTL expiry so the cache is always warm
# ---------------------------------------------------------------------------
async def _refresh_all_loader_report_caches():
    """Pre-warm loaderReport cache for every destination that has active rakes."""
    try:
        raw = await _upstream_get("getRakeidDet.jsp")
        if not isinstance(raw, list):
            return

        dest_codes: set[str] = set()
        for row in raw:
            for key in ("DEST_CD1", "DEST_CD2"):
                code = str(row.get(key) or "").strip()
                if code:
                    dest_codes.add(code)

        for dest_cd in dest_codes:
            try:
                await _fetch_and_cache_loader_report(dest_cd)
            except Exception:
                pass
    except Exception:
        pass


async def _cache_refresh_loop():
    # First pre-warm immediately on startup, then refresh every REFRESH_INTERVAL.
    # Because REFRESH_INTERVAL < LOADING_REPORT_CACHE_TTL the cache is always warm
    # when entries expire.
    while True:
        await _refresh_all_loader_report_caches()
        await asyncio.sleep(config.REFRESH_INTERVAL)


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    # 1. Persistent HTTP client with connection pooling
    app.state.http_client = httpx.AsyncClient(
        timeout=config.REQUEST_TIMEOUT,
        verify=False,
        limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
    )

    # 2. Cache backend (in-memory by default)
    FmCacheManager.init(FmMemoryBackend(), prefix="bsp-cache")

    # 3. Start background refresh (pre-warms cache on first iteration)
    refresh_task = asyncio.create_task(_cache_refresh_loop())

    yield

    # Shutdown
    refresh_task.cancel()
    await app.state.http_client.aclose()


app = FastAPI(title="BSP Plate Loading API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Upstream HTTP helpers — persistent client + retries
# ---------------------------------------------------------------------------
@default_retry()
async def _upstream_get_raw(path: str, params: Optional[dict] = None):
    """Fetch from upstream with automatic retries (uses persistent client)."""
    url = f"{config.UPSTREAM_BASE}/{path}"
    resp = await app.state.http_client.get(url, params=params)
    resp.raise_for_status()
    try:
        return resp.json()
    except ValueError:
        return resp.text or ""


async def _upstream_get(path: str, params: Optional[dict] = None):
    """Public wrapper — converts httpx errors to HTTPException after retries exhausted."""
    try:
        return await _upstream_get_raw(path, params)
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=exc.response.status_code, detail="Upstream request failed") from exc
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail="Upstream request error") from exc


# ---------------------------------------------------------------------------
# Loader report cache helper
# ---------------------------------------------------------------------------
async def _fetch_and_cache_loader_report(dest_cd: str):
    """Fetch loader report from upstream, normalise, store in cache, and return."""
    raw = await _upstream_get(
        "loaderReport.jsp",
        {"dest_cd": dest_cd, "dispatch_mode": "RAIL", "ord_status": "O"},
    )
    normalized = normalize_loading_data(raw if isinstance(raw, list) else [], dest_cd)
    await FmCacheManager.set(
        f"loaderReport:{dest_cd}", normalized, expire=config.LOADING_REPORT_CACHE_TTL
    )
    return normalized


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@app.get("/api/health")
async def health():
    return {"status": "ok", "upstream": config.UPSTREAM_BASE}


@app.get("/api/destData")
@memorize(expire=config.DESTINATION_CACHE_TTL)
async def dest_data():
    raw = await _upstream_get("destData.jsp")
    return normalize_destinations(raw)


@app.get("/api/loaderReport")
async def loader_report(dest_cd: str = Query(...)):
    cache_key = f"loaderReport:{dest_cd}"
    cached = await FmCacheManager.get(cache_key)
    if cached is not None:
        return cached
    return await _fetch_and_cache_loader_report(dest_cd)


@app.get("/api/plateInfo")
async def plate_info(plateNo: str = Query(...)):
    p_str = str(plateNo)
    full_plate_no = p_str if re.search(r"/\d+$", p_str) else f"{p_str}/1"
    raw = await _upstream_get("plateInfo.jsp", {"plateNo": full_plate_no})
    if isinstance(raw, list) and raw:
        return raw[0]
    return None


@app.get("/api/getRakeidDet")
async def get_rakeid_det(rakeid: Optional[str] = None):
    params = {"rakeid": rakeid} if rakeid else None
    raw = await _upstream_get("getRakeidDet.jsp", params)
    normalized = normalize_rakes_list(raw)
    if rakeid:
        if normalized:
            return normalized[0]
        return {
            "rakeId": str(rakeid),
            "status": "ACTIVE",
            "destinations": [],
            "totalWagons": None,
            "createdAt": datetime.now().isoformat(),
        }
    return normalized


@app.get("/api/genRakeid")
async def gen_rakeid(destCd1: str = Query(...), destCd2: Optional[str] = None):
    params = {"destCd1": destCd1}
    if destCd2:
        params["destCd2"] = destCd2

    raw = await _upstream_get("genRakeid.jsp", params)
    if isinstance(raw, list) and raw and "RakeId" in raw[0]:
        return {"rakeId": raw[0]["RakeId"]}
    raise HTTPException(status_code=500, detail="Invalid rake response: RakeId not found")


@app.get("/api/postPlatesData")
async def post_plates_data(status: int = Query(...), jsonB64: str = Query(...)):
    await _upstream_get("postPlatesData.jsp", {"status": status, "jsonB64": jsonB64})
    return {"success": True}


@app.get("/api/getLoadedDet")
async def get_loaded_det(rakeid: str = Query(...)):
    raw = await _upstream_get("getLoadedDet.jsp", {"rakeid": rakeid})
    return raw


@app.get("/api/getWagonRakeidDet")
async def get_wagon_rakeid_det(rakeid: str = Query(...)):
    raw = await _upstream_get("getWagonRakeidDet.jsp", {"rakeid": rakeid})
    return raw if isinstance(raw, list) else []


@app.get("/api/postWagonRakeid")
async def post_wagon_rakeid(
    rakeid: str = Query(...),
    wagon: str = Query(...),
    destcd: str = Query(default=""),
    consignee: str = Query(default=""),
    status: int = Query(default=1),
):
    await _upstream_get(
        "postWagonRakeid.jsp",
        {
            "rakeid": rakeid,
            "wagon": wagon,
            "destcd": destcd,
            "consignee": consignee,
            "status": status,
        },
    )
    return {"success": True}


@app.get("/api/mesappLogin")
async def mesapp_login(userid: str = Query(...), password: str = Query(...)):
    raw = await _upstream_get("mesappLogin.jsp", {"userid": userid, "password": password})
    return raw


@app.get("/api/cache/status")
async def cache_status():
    return {"status": "ok", "backend": "InMemoryBackend", "prefix": "bsp-cache"}


@app.post("/api/cache/invalidate")
async def invalidate_cache(key: str):
    if key != config.CACHE_INVALIDATION_KEY:
        raise HTTPException(status_code=403, detail="Invalid key")

    await FmCacheManager.clear()
    return {"ok": True}


@app.get("/api/updateTramsId")
async def update_trams_id(rakeid: str = Query(...), tramsid: str = Query(...)):
    raw = await _upstream_get("updRakeid.jsp", {"rakeid": rakeid, "rakeid_trams": tramsid})
    if isinstance(raw, list) and raw:
        return raw[0]
    return raw


@app.get("/api/getTramsRakeids")
async def get_trams_rakeids():
    raw = await _upstream_get("getTramsRakeid.jsp")
    if isinstance(raw, str):
        match = re.search(r'\[.*\]', raw, re.DOTALL)
        if match:
            try:
                raw = json.loads(match.group(0))
            except Exception:
                return []
    if isinstance(raw, list):
        items = []
        for item in raw:
            if item.get("TRAMS_RAKEID") is not None and str(item.get("TRAMS_RAKEID", "")).strip():
                items.append({
                    "trams_rakeid": str(item["TRAMS_RAKEID"]),
                    "dest_cd": item.get("DEST_CD", ""),
                })
        items.sort(key=lambda x: x["trams_rakeid"], reverse=True)
        return items
    return []


@app.get("/api/updateWagonTramsId")
async def update_wagon_trams_id(rakeid: str = Query(...), wagon: str = Query(...), wagon_trams: str = Query(...)):
    raw = await _upstream_get("updWagon.jsp", {"rakeid": rakeid, "wagon_fr": wagon, "wagon_to": wagon_trams})
    if isinstance(raw, list) and raw:
        return raw[0]
    return raw


@app.post("/api/bal-updates/publish")
async def publish_bal_update(payload: dict):
    data = json.dumps(payload)
    dead = []
    for q in list(_bal_update_clients):
        try:
            await q.put(data)
        except Exception:
            dead.append(q)
    for q in dead:
        if q in _bal_update_clients:
            _bal_update_clients.remove(q)
    return {"ok": True}


@app.get("/api/bal-updates/stream")
async def bal_updates_stream():
    q: asyncio.Queue = asyncio.Queue()
    _bal_update_clients.append(q)

    async def event_gen():
        try:
            yield "data: connected\n\n"
            while True:
                try:
                    data = await asyncio.wait_for(q.get(), timeout=25)
                    yield f"data: {data}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        except (asyncio.CancelledError, GeneratorExit):
            pass
        finally:
            if q in _bal_update_clients:
                _bal_update_clients.remove(q)

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
            "Transfer-Encoding": "chunked",
        },
    )


@app.post("/api/plate-locks/publish")
async def publish_plate_lock(payload: dict):
    plate_no = str(payload.get("plateNo") or "").strip()
    if not plate_no:
        return {"ok": False, "error": "plateNo is required"}
    if payload.get("locked"):
        _plate_locks[plate_no] = payload
    else:
        _plate_locks.pop(plate_no, None)

    data = json.dumps(payload)
    dead = []
    for q in list(_plate_lock_clients):
        try:
            await q.put(data)
        except Exception:
            dead.append(q)
    for q in dead:
        if q in _plate_lock_clients:
            _plate_lock_clients.remove(q)
    return {"ok": True}


@app.get("/api/plate-locks/stream")
async def plate_locks_stream():
    q: asyncio.Queue = asyncio.Queue()
    _plate_lock_clients.append(q)

    async def event_gen():
        try:
            # Send full current lock state immediately on connect so late-joiners
            # see locks that were set before they subscribed.
            init = json.dumps({"type": "init", "locks": list(_plate_locks.values())})
            yield f"data: {init}\n\n"
            while True:
                try:
                    data = await asyncio.wait_for(q.get(), timeout=25)
                    yield f"data: {data}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        except (asyncio.CancelledError, GeneratorExit):
            pass
        finally:
            if q in _plate_lock_clients:
                _plate_lock_clients.remove(q)

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
            "Transfer-Encoding": "chunked",
        },
    )
