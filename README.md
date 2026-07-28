# WZDx Feed Generator

A minimal, tested Node/Express app that turns a simple crew intake form
into a spec-compliant [WZDx v4.2](https://github.com/usdot-jpo-ode/wzdx)
WorkZoneFeed — the standard USDOT wants navigation apps and AVs consuming
work-zone/closure data from.

## What's here

```
server.js               Express entry point — loads .env, mounts routes
routes/events.js         POST/GET /api/events (intake + validation), GET /feed
models/store.js          SQLite persistence (better-sqlite3)
models/wzdxFeed.js        Internal event → WZDx v4.2 GeoJSON translation
public/index.html         Crew-facing intake form (map picker, mobile-friendly)
public/field-capture.html GPS perimeter capture for field crews (mobile-first)
data/events.db            SQLite database (created on first run, gitignored)
schemas/4.2/              Official WZDx v4.2 JSON Schema files (for validation)
test-schema.js            Schema validation test (posts real events, cleans up)
.env.example              All supported environment variables with descriptions
```

## Run it

```bash
npm install
cp .env.example .env   # fill in your values
npm start
```

- Intake form:     http://localhost:3000/
- Field capture:   http://localhost:3000/field-capture.html
- Public feed:     http://localhost:3000/feed  (hand this URL to a DOT or navigation partner)
- Raw API:         POST http://localhost:3000/api/events

## Validate the feed

```bash
npm test
```

Starts the server, posts test events covering all major code paths, validates
the feed output against the official WZDx v4.2 JSON Schema, then cleans up.
Can also run `node test-schema.js` against an already-running server.

## Auth

Write endpoints (`POST /api/events`, `PATCH /api/events/:id/close`) require an
`X-Api-Key` header matching the `API_KEY` env var. `GET /feed` is public.

If `API_KEY` is unset, the server warns at startup and skips enforcement. Fine
for local dev; set it before exposing the server beyond localhost.

```bash
curl -X POST http://localhost:3000/api/events \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your-key-here" \
  -d '{ ... }'
```

## Environment variables

See `.env.example` for the full list. Key ones:

| Variable | Purpose |
|---|---|
| `API_KEY` | Protects write endpoints |
| `WZDX_PUBLISHER` | Organization name in feed_info |
| `WZDX_CONTACT_NAME` | Contact name in feed_info |
| `WZDX_CONTACT_EMAIL` | Contact email in feed_info |
| `PORT` | Server port (default: 3000) |

## What's verified working

**Intake and validation**
- `POST /api/events` validates required fields and rejects bad lane statuses
- Lane business rule: if any lanes are reported, `total_lanes` is required and
  the lanes array must cover every lane (WZDx spec requirement)
- `location_method` required by the spec — both forms expose all five enum
  values; defaults to `channel-device-method`
- Geometry options: `start_coords` + `end_coords` (two-point) or
  `perimeter_points` (ordered array of 2+ `[lng, lat]` pairs from field
  capture); one or the other required
- `obstruction_type`: `construction`, `road-maintenance`, `traffic-incident`,
  `accident-ems` — validated and stored
- `duration_type`: `short-term` or `long-term`
- `reduced_speed_limit_kph`: stored and emitted to feed when present

**Feed output (GET /feed)**
- Returns a WZDx v4.2 FeatureCollection that passes the official JSON Schema
- `traffic-incident` and `accident-ems` events are filtered out — WZDx
  WorkZoneFeed is spec-scoped to planned work zones, not live incidents.
  Incident events are stored internally but never appear in `/feed`
- Perimeter events use `perimeter_points` as the LineString geometry directly
- `types_of_work` emitted per schema-verified mapping:
  - `construction` → `surface-work` (with `is_architectural_change: true`)
  - `road-maintenance` → `maintenance`
- Estimated `end_date` when none provided: `+8h` for short-term, `+7 days`
  for long-term; `is_end_date_verified: false` signals it's an estimate
- SQLite storage — no concurrent-write corruption risk

**Field capture — server side (exercised by `npm test`)**
- `POST /api/events` accepts `perimeter_points` geometry submitted by the page
- Obstruction type, duration, and speed limit stored and routed correctly
- Incident filtering, types_of_work mapping, end_date estimation all covered
  by the same test assertions as the rest of the feed

**Field capture — browser UI (code-reviewed, not yet tested on a real device)**
The following have been verified by reading the code but have not been walked
through on a physical phone with GPS. Treat as believed-correct until
device-tested:
- GPS marker drop and accuracy circle display
- Numbered markers + polyline rendering on map
- Undo behavior
- OSM Overpass prefill on first marker
- Geolocation permission denial and timeout error messages
- Full submit-to-server flow from the mobile UI

## What's not here yet

- **Map picker gaps** — the existing two-point picker (`index.html`) has no
  address/road search-to-center and no snapping to road centerlines. The OSM
  tile server (`tile.openstreetmap.org`) is dev-only — swap to a paid tile
  provider (Mapbox, MapTiler, etc.) before production traffic.
- **Event lifecycle UI** — `PATCH /api/events/:id/close` exists but there's no
  UI for it. The WZDx recommendation that a closed event stay in the feed for
  at least an hour after closing is also not implemented.
- **Detours, restrictions, worker-presence** — this implements only the required
  subset for a valid WorkZoneFeed. The spec supports more.
- **Incident feed** — `traffic-incident` and `accident-ems` events have no
  public output path. WZDx v4.2 has no feed type for live incidents (DeviceFeed
  covers ITS hardware, not incident response). A separate standard (GTFS-RT,
  DATEX II) would be needed for that.
