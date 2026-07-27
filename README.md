# WZDx Feed Generator

A minimal, tested Node/Express app that turns a simple crew intake form
into a spec-compliant [WZDx v4.2](https://github.com/usdot-jpo-ode/wzdx)
WorkZoneFeed — the standard USDOT wants navigation apps and AVs consuming
work-zone/closure data from.

## What's here

```
server.js             Express entry point — loads .env, mounts routes
routes/events.js       POST/GET /api/events (intake + validation), GET /feed
models/store.js        SQLite persistence (better-sqlite3)
models/wzdxFeed.js      Internal event → WZDx v4.2 GeoJSON translation
public/index.html       Crew-facing intake form (mobile-friendly, no build step)
data/events.db          SQLite database (created on first run, gitignored)
schemas/4.2/            Official WZDx v4.2 JSON Schema files (for validation)
test-schema.js          Schema validation test (posts real events, cleans up)
.env.example            All supported environment variables with descriptions
```

## Run it

```bash
npm install
cp .env.example .env   # fill in your values
npm start
```

- Intake form: http://localhost:3000/
- Public feed: http://localhost:3000/feed  (hand this URL to a DOT or navigation partner)
- Raw API:     POST http://localhost:3000/api/events

## Validate the feed

Requires the server to be running:

```bash
node test-schema.js
```

Posts two test events (one with full lane data, one open-ended), validates the
feed output against the official WZDx v4.2 JSON Schema, spot-checks key fields,
then cleans up the test rows. All verified working.

## Auth

Write endpoints (`POST /api/events`, `PATCH /api/events/:id/close`) require an
`X-Api-Key` header matching the `API_KEY` env var. `GET /feed` is public — that's
the point of a WZDx feed.

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

- POST /api/events validates required fields and rejects bad lane statuses
- Lane business rule: if any lanes are reported, `total_lanes` is required and
  the lanes array must cover every lane (WZDx spec requirement)
- `location_method` field required by the spec — intake form exposes all five
  enum values; defaults to `channel-device-method`
- Open-ended events (no `end_date`) emit an estimated end 8 hours after start
  with `is_end_date_verified: false` — satisfies the spec's date-time type
  requirement while being honest about the estimate
- GET /feed returns a FeatureCollection that passes the official WZDx v4.2
  JSON Schema (tested against local copies of the spec schema files)
- SQLite storage — no concurrent-write corruption risk
- Map picker: click-to-drop pins, drag-to-adjust, auto-advance to end-point
  mode after setting start, geolocate button

## What's not here yet

- **Map picker gaps** — no address/road search-to-center, no snapping to road
  centerlines (a crew could drop a pin off the road). The OSM tile server
  (`tile.openstreetmap.org`) is dev-only — swap to a paid tile provider
  (Mapbox, MapTiler, etc.) before production traffic.
- **Event lifecycle UI** — `PATCH /api/events/:id/close` exists but there's no
  UI for it. The WZDx recommendation that a closed event stay in the feed for
  at least an hour (marked ended, not just gone) is also not implemented.
- **Detours, restrictions, worker-presence** — this implements only the required
  subset for a valid WorkZoneFeed. The spec supports more.
