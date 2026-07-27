# WZDx Feed Generator (scaffold)

A minimal, tested Node/Express app that turns a simple crew intake form
into a spec-compliant [WZDx v4.2](https://github.com/usdot-jpo-ode/wzdx)
WorkZoneFeed — the standard USDOT wants navigation apps and AVs consuming
work-zone/closure data from.

## What's here

```
server.js           Express entry point
routes/events.js     POST/GET event intake + validation, GET /feed
models/store.js      JSON-file persistence (swap for Postgres later)
models/wzdxFeed.js    Internal event -> WZDx v4.2 GeoJSON translation
public/index.html    Crew-facing intake form (mobile-friendly, no build step)
data/events.json     Local data store (gitignore this in real deployment)
```

## Run it

```bash
npm install
npm start
```

- Intake form: http://localhost:3000/
- Public feed: http://localhost:3000/feed  (this is what you'd hand to a DOT or navigation partner)
- Raw API:     POST http://localhost:3000/api/events

## What's intentionally NOT here yet

- **Auth** — the intake endpoint is wide open. Fine for a local pilot,
  not fine for anything public. Add an API key or crew login before
  this touches a real road.
- **A real database** — JSON-file storage will not survive concurrent
  writes at any real scale. First upgrade: SQLite, then Postgres.
- **Map picker is basic** — click-to-drop-pin with Leaflet + OpenStreetMap
  tiles is in, including drag-to-adjust and a "my location" button. Not
  yet in: address/road-name search-to-center, snapping pins to the actual
  road centerline (right now a crew could drop a pin in the wrong lane
  or off the road entirely — nothing validates that), and the OSM tile
  server used (`tile.openstreetmap.org`) is fine for local dev but has
  a usage policy that doesn't allow production traffic at any real
  volume — swap to Mapbox/MapTiler/a paid tile provider before this
  goes further than your own testing.
- **Detours, restrictions, worker-presence** — the spec supports more
  event types and fields than this implements. This covers only the
  required subset for a valid WorkZoneFeed.
- **Lane-count business rule enforcement** — WZDx requires that if you
  report `lanes` at all, you report *every* lane in the event. This
  scaffold doesn't enforce that yet; garbage-in on lane count will
  currently pass validation.
- **Environment config** — publisher/contact info in `wzdxFeed.js`
  should move to `.env` before this leaves your machine.

## Validating your feed

Once you have events in it, run the feed through the official WZDx
JSON Schema or the self-validation checklist linked from the spec
repo before showing it to anyone at a DOT — that credibility matters
more than any feature for a first pitch.
