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
| `FEED_RETENTION_MINUTES` | Minutes a closed event stays in `/feed` after `end_date` passes (default: 60) |

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

**Field capture — browser UI (device-tested and confirmed)**
Full end-to-end flow confirmed on real device (GPS, ngrok HTTPS, API key auth — Event ID `cec50aca...` published live). Specific fixes confirmed working:

- Geolocation denial message cleared on successful marker drop
- `permissions.query` prevents OS dialog at page load (no cached Android denial)
- `perm.onchange` clears denial banner when permission granted mid-session
- Retry link re-triggers Drop Marker without page reload
- Incident type selector shows/hides notice correctly
- Undo removes last marker and redraws polyline
- OSM Overpass prefill populates lanes/speed on first marker drop

**Event lifecycle**
- `PATCH /api/events/:id/close` marks an event ended (sets `end_date` to now)
- `GET /index.html` ("Mark event complete" panel) — loads active events, shows road name + direction + start time, closes selected event with one tap; requires same API key as other write operations
- `GET /feed` retention: closed events remain in the feed for 60 minutes after `end_date` passes, then drop. Window is configurable via `FEED_RETENTION_MINUTES` env var. The WZDx spec does not mandate a specific retention window — this is our operational policy.

## Merge Advisory (value-add, separate from WZDx feed)

`GET /api/events/:id/merge-advisory` computes MUTCD-based traffic control
geometry for an event.  This is our own data product derived from event data —
it is **not** a WZDx spec field and must never appear in the `/feed` output.

```bash
# Event has reduced_speed_limit_kph set
curl http://localhost:3000/api/events/<id>/merge-advisory?road_type=rural

# Event has no speed limit — supply it
curl "http://localhost:3000/api/events/<id>/merge-advisory?posted_speed_mph=55&road_type=rural"
```

**Source:** FHWA MUTCD 2009 Edition with Revisions 1 & 2, Part 6C
([mutcd.fhwa.dot.gov](https://mutcd.fhwa.dot.gov/htm/2009r1r2/part6/part6c.htm))

| MUTCD table | Used for |
|---|---|
| Table 6C-4 (Section 6C.08) | Taper length formula |
| Table 6C-1 | Advance warning sign spacing |

**Taper length formula (Table 6C-4):**
- Speed ≤ 40 mph: `L = W × S² / 60`
- Speed ≥ 45 mph: `L = W × S`

where L = taper length (ft), W = lane/offset width (ft), S = speed (mph).

**Advance warning sign spacing (Table 6C-1):**

| Road type | A (ft) | B (ft) | C (ft) | Total |
|---|---|---|---|---|
| Urban, low speed (≤ 40 mph) | 100 | 100 | 100 | 300 ft |
| Urban, high speed (> 40 mph) | 350 | 350 | 350 | 1,050 ft |
| Rural | 500 | 500 | 500 | 1,500 ft |
| Freeway / Expressway | 1,000 | 1,500 | 2,640 | 5,140 ft |

A = taper start → Sign 1 (nearest), B = Sign 1 → Sign 2, C = Sign 2 → Sign 3
(furthest upstream; first sign approaching drivers see).

**Query parameters:**

| Parameter | Required | Values | Notes |
|---|---|---|---|
| `posted_speed_mph` | If event has no `reduced_speed_limit_kph` | positive number | No silent default — endpoint returns 400 if speed is unknown |
| `road_type` | No | `urban` \| `rural` \| `freeway` | Defaults to `rural`; response flags `road_type_assumed: true` when defaulted |

**Known limitations:**
- Lane width assumed to be 12 ft (standard US lane per AASHTO Green Book).
  Real widths vary 10–14 ft; accuracy improves if lane width is captured.
- `road_type` is not auto-detected from geometry — supply it via query param
  or accept the conservative `rural` default.
- Does not account for road curvature, sight distance, or grade — MUTCD
  recommends increasing taper length when sight distance is restricted.
- Urban low/high speed threshold (40 mph) is MUTCD-delegated to the highway
  agency; the constant `URBAN_HIGH_SPEED_THRESHOLD_MPH` in
  `models/mergeAdvisory.js` can be changed to match your agency's standard.


## Crew device setup (zero-typing provisioning)

Getting the API key onto a crew phone without typing a 64-character hex string:

**Supervisor (one-time, on any device with the key already saved):**
1. Open the intake form or field capture page and tap **🔑 API key**
2. A **Generate setup link** panel appears below the key field
3. Copy the link or show the QR code to the crew member

**Crew member:**
- Scan the QR code (or open the link) — the key is saved automatically and the
  URL is cleaned immediately so the key never sits in the address bar or history
- A green **Device provisioned** banner confirms success
- From that point on, submitting events works without any further setup

The setup URL is `https://sapiowzdx.com/?setup=<KEY>` — it works on both
`/` (intake form) and `/field-capture.html`. The same QR code provisions either page.

**If a device is lost:** rotate the `API_KEY` (one SSH command, see Auth section above),
then regenerate the setup link/QR from any supervisor device and redistribute to remaining
crew. There is no separate distribution-only key — rotating the real key is the
revocation mechanism, and the process is already documented.

## What's not here yet

- **Map picker gaps** — the existing two-point picker (`index.html`) has no
  address/road search-to-center and no snapping to road centerlines. The OSM
  tile server (`tile.openstreetmap.org`) is dev-only — swap to a paid tile
  provider (Mapbox, MapTiler, etc.) before production traffic.
- **Detours, restrictions, worker-presence** — this implements only the required
  subset for a valid WorkZoneFeed. The spec supports more.
- **Incident feed** — `traffic-incident` and `accident-ems` events have no
  public output path. WZDx v4.2 has no feed type for live incidents (DeviceFeed
  covers ITS hardware, not incident response). A separate standard (GTFS-RT,
  DATEX II) would be needed for that.
