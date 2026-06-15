# BSP Plate Mill Loading System

An internal web-based MES (Manufacturing Execution System) application for **Bhilai Steel Plant (SAIL)** that manages rail dispatch operations — covering rake generation, wagon assignment, and plate loading workflows for the Plate Mill Division.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Features](#features)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Local Development Setup](#local-development-setup)
- [Production Deployment](#production-deployment)
- [Development → Production Config Changes](#development--production-config-changes)
- [Environment & Configuration](#environment--configuration)
- [Application Workflow](#application-workflow)
- [API Reference](#api-reference)
- [Tech Stack](#tech-stack)

---

## Overview

The BSP Plate Loading System provides a streamlined interface for loading operators at Bhilai Steel Plant to:

- Generate Rake IDs for rail dispatches
- Assign wagons to rakes
- Load plates into wagons by consignee
- Export completion reports as PDF or JSON
- Track session state across browser reloads

The application is served under the `/pmloading/` path and proxies all API calls through nginx to a FastAPI backend, which in turn communicates with the upstream MES system.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                     Browser                         │
│         React SPA  (/pmloading/)                    │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP
┌──────────────────────▼──────────────────────────────┐
│              nginx  (port 8705)                     │
│   /pmloading/api/*  ──────────► backend:8706/api/*  │
│   /pmloading/*      ──────────► SPA index.html      │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP
┌──────────────────────▼──────────────────────────────┐
│           FastAPI Backend  (port 8706)              │
│   • Proxies to upstream MES                         │
│   • Normalizes API responses                        │
│   • Caches destinations & loading reports           │
└──────────────────────┬──────────────────────────────┘
                       │ HTTPS
┌──────────────────────▼──────────────────────────────┐
│       Upstream MES  (bspapp.sail-bhilaisteel.com)   │
│       JSP endpoints (getRakeidDet, loaderReport…)   │
└─────────────────────────────────────────────────────┘
```

Both `frontend` and `backend` are containerized and orchestrated with Docker Compose.

---

## Features

### Rake Generation
- Select primary (mandatory) and secondary (optional) destination codes
- Generate a unique Rake ID via the upstream MES
- Copy Rake ID to clipboard
- Navigate directly to wagon assignment after generation
- Session history stored in `sessionStorage` (up to 10 recent entries)

### Wagon Assignment (`/assign-wagons`)
- Enter or prefill a Rake ID
- Add wagon numbers manually (Enter key or Add button)
- Fetch already-linked wagons from the backend
- Remove wagons (with API unlinking for previously saved wagons)
- Confirm and proceed to loading operations

### Loading Operations (`/loading-operations`)
- Multi-destination support — switch between destinations without losing state
- Per-consignee plate lists with type classification: **OK**, **RA**, **TPI**, **MTI**, **DIV**
- Select wagon, then mark plates as loaded with a single click
- Quick entry bar: type a plate number to find it in the list or look it up via the API
- Balance (BAL) updates in real-time as plates are marked loaded
- Session auto-saved to `localStorage` for crash/refresh recovery
- Save progress mid-session (status 1) or complete selected wagons (status 2)
- Export as **PDF** (landscape, multi-page, per-consignee tables + wagon summary + signature block) or **JSON**
- Retry failed API submissions

### Loading Report (`/loading-report`)
- Fetch consignee-level data for any destination
- Filter by Grade or TDC
- Sort by OK plates, RA plates, order count, or name
- Expand each consignee to view orders, plate lists, and heat info
- Order info modal with per-type plate breakdown
- Summary stats: consignees, orders, OK plates, RA plates, TPI plates, balance qty

### Dashboard (`/home`)
- Live table of all rakes with status (Active / In Progress / Completed)
- Wagon count per rake (fetched in parallel, non-blocking)
- Resume or start loading from any active rake
- Update TRAMS ID for any rake
- Restore an in-progress session that was saved to `localStorage`
- Search and sort by Rake ID, destination, or created-by

---

## Project Structure

```
.
├── docker-compose.yml
├── frontend/
│   ├── Dockerfile
│   ├── nginx.conf              # nginx reverse-proxy + SPA config
│   ├── index.html
│   ├── package.json
│   ├── vite.config.js
│   └── src/
│       ├── main.jsx            # React entry point (basename: /pmloading)
│       ├── App.jsx             # Route definitions + auth guard
│       ├── index.css           # Global design-system stylesheet
│       ├── api/
│       │   └── index.js        # All fetch calls to /api
│       ├── context/
│       │   ├── AuthContext.jsx  # Session auth (sessionStorage)
│       │   └── ToastContext.jsx # Global toast notifications
│       ├── components/
│       │   ├── layout/
│       │   │   └── AppShell.jsx # Sidebar + topbar shell
│       │   └── shared/
│       │       └── Modal.jsx
│       ├── pages/
│       │   ├── LoginPage.jsx
│       │   ├── HomePage.jsx
│       │   ├── RakeGenerationPage.jsx
│       │   ├── AssignWagonsPage.jsx
│       │   ├── LoadingOperationsPage.jsx
│       │   └── LoadingReportPage.jsx
│       └── utils/
│           └── export.js       # PDF (jsPDF + autotable) and JSON export
└── backend/
    ├── Dockerfile
    ├── requirements.txt
    ├── config.py               # UPSTREAM_BASE, timeouts, CORS, cache TTLs
    ├── main.py                 # FastAPI app + all route handlers
    └── normalizers.py          # Response normalization & plate parsing logic
```

---

## Prerequisites

- **Docker** ≥ 24 and **Docker Compose** ≥ 2.20
- Node.js ≥ 22 (only needed for local frontend development without Docker)
- Python ≥ 3.12 (only needed for local backend development without Docker)
- Network access to the upstream MES server

---

## Local Development Setup

### 1. Clone the repository

```bash
git clone <repo-url>
cd bsp-plate-loading
```

### 2. Start the backend

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8706 --reload
```

The backend will be available at `http://localhost:8706`.

### 3. Start the frontend

```bash
cd frontend
npm install
npm run dev     # Vite dev server on port 8705
```

Open `http://localhost:8705/pmloading/` in your browser.

> **Note:** In development, `src/api/index.js` uses `const PROXY = 'http://localhost:8706/api'` (direct call to the backend). This avoids nginx during local development.

---

## Production Deployment

Both services are built and run as Docker containers behind nginx.

```bash
docker compose up --build -d
```

- Frontend served at: `http://<host>:8705/pmloading/`
- Backend API at: `http://<host>:8706/api/` (internal; not directly exposed to users)

The nginx config (`frontend/nginx.conf`) proxies `/pmloading/api/*` to the backend container and serves the React SPA for all other `/pmloading/*` paths.

---

## Development → Production Config Changes

Three files need to be updated when switching from local development to production deployment:

### `frontend/nginx.conf`

```nginx
# Development
proxy_pass http://backend:8706/api/;

# Production (internal network IP)
proxy_pass http://10.145.8.23:8706/api/;
```

### `frontend/src/api/index.js`

```js
// Development (direct call to local backend)
const PROXY = 'http://localhost:8706/api'

// Production (nginx-proxied, same origin)
const PROXY = '/pmloading/api'
```

### `backend/config.py`

```python
# Development (public HTTPS endpoint)
UPSTREAM_BASE: str = "https://bspapp.sail-bhilaisteel.com/MES_MOB/APP"

# Production (internal network MES server)
UPSTREAM_BASE: str = "http://10.145.2.248:8181/MES_MOB/APP"
```

---

## Environment & Configuration

### Backend (`backend/config.py`)

| Parameter | Default | Description |
|---|---|---|
| `UPSTREAM_BASE` | `https://bspapp.sail-bhilaisteel.com/MES_MOB/APP` | Upstream MES base URL |
| `LOADING_REPORT_CACHE_TTL` | `21600` (6 h) | Seconds before loading report cache expires |
| `DESTINATION_CACHE_TTL` | `43200` (12 h) | Seconds before destination list cache expires |
| `REQUEST_TIMEOUT` | `900.0` | HTTP timeout (seconds) for upstream calls |
| `ALLOWED_ORIGINS` | `["*"]` | CORS allowed origins (restrict in production) |

### Frontend (`frontend/src/api/index.js`)

| Variable | Dev Value | Prod Value |
|---|---|---|
| `PROXY` | `http://localhost:8706/api` | `/pmloading/api` |

---

## Application Workflow

```
Login
  │
  ▼
Dashboard (/home)
  │
  ├── Generate New Rake (/rake-generation)
  │       │
  │       └── Select Destination(s) → Generate Rake ID → Copy / Proceed
  │
  └── Start / Resume Loading
          │
          ▼
      Assign Wagons (/assign-wagons)
          │   Add wagon numbers, confirm
          ▼
      Loading Operations (/loading-operations)
          │
          ├── Select Destination (if multi-dest rake)
          ├── Select Consignee
          ├── Select Wagon
          ├── Mark Plates as Loaded (click or quick-entry)
          ├── Save Progress (mid-session, status=1)
          └── Complete Wagons → Export PDF / JSON
```

---

## API Reference

All endpoints are served by the FastAPI backend at `/api/`.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/destData` | List of all dispatch destinations (cached) |
| `GET` | `/api/loaderReport?dest_cd=` | Consignees + plates for a destination (cached) |
| `GET` | `/api/plateInfo?plateNo=` | Plate details from MES |
| `GET` | `/api/getRakeidDet` | All rakes list |
| `GET` | `/api/getRakeidDet?rakeid=` | Single rake details |
| `GET` | `/api/genRakeid?destCd1=&destCd2=` | Generate a new Rake ID |
| `GET` | `/api/postPlatesData?status=&jsonB64=` | Submit loaded plate data |
| `GET` | `/api/getLoadedDet?rakeid=` | Previously loaded plate details for a rake |
| `GET` | `/api/getWagonRakeidDet?rakeid=` | Wagons linked to a rake |
| `GET` | `/api/postWagonRakeid?rakeid=&wagon=&status=` | Link/unlink a wagon to a rake |
| `GET` | `/api/mesappLogin?userid=&password=` | Authenticate an operator |
| `GET` | `/api/updateTramsId?rakeid=&tramsid=` | Update TRAMS ID for a rake |
| `GET` | `/api/cache/status` | View backend cache state (debug) |

---

## Tech Stack

### Frontend
- **React 18** with React Router v6
- **Vite 8** (build tool)
- **jsPDF + jsPDF-AutoTable** — PDF report generation
- **IBM Plex Sans / Mono** — typography
- Pure CSS design system (no Tailwind or component library)

### Backend
- **FastAPI** — async Python web framework
- **httpx** — async HTTP client for upstream MES calls
- **Gunicorn + Uvicorn workers** — production ASGI server
- In-memory caching (destinations + loading reports)

### Infrastructure
- **Docker + Docker Compose** — containerization
- **nginx** — static file serving + API reverse proxy

---

## Notes

- Session state (active loading session) is persisted to `localStorage` and restored automatically on navigation to `/loading-operations`. Sessions can be discarded from the Dashboard.
- Failed wagon submissions are stored in `localStorage` under `bsp_failed_submissions` and can be retried.
- The PDF report is generated entirely client-side using jsPDF — no server-side rendering required.
- All API calls to the upstream MES are proxied through the FastAPI backend, which handles SSL certificate verification bypass (`verify=False`) for the internal MES server.
- This application is **for internal use only** — Bhilai Steel Plant, Plate Mill Division, SAIL.

---

*© 2026 Steel Authority of India Limited. All Rights Reserved.*