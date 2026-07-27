// test-schema.js
//
// Validates GET /feed output against the official WZDx v4.2 JSON Schema.
// Run with: node test-schema.js
//
// Requires the server to be running on localhost:3000.
// Schemas are in schemas/4.2/ (downloaded from the usdot-jpo-ode/wzdx repo).
// If API_KEY is set in the environment, it is forwarded on write requests.

require('dotenv').config();

const http = require('http');
const path = require('path');
const fs = require('fs');
const Ajv = require('ajv');

const BASE = 'http://localhost:3000';
const API_KEY = process.env.API_KEY || null;

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (API_KEY) headers['X-Api-Key'] = API_KEY;
    const req = http.request(BASE + urlPath, { method, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(new Error('Non-JSON response: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function loadSchema(filename) {
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, 'schemas', '4.2', filename), 'utf8')
  );
}

function buildValidator() {
  // formats: true tells AJV to accept but not enforce format keywords (email,
  // date-time, uri) — suppresses the "unknown format ignored" warnings while
  // still validating structure.
  const ajv = new Ajv({ strict: false, formats: { email: true, 'date-time': true, uri: true } });
  for (const file of ['BoundingBox.json', 'Direction.json', 'FeedInfo.json',
                      'RoadEventFeature.json', 'LineString.json', 'MultiPoint.json']) {
    ajv.addSchema(loadSchema(file));
  }
  return ajv.compile(loadSchema('WorkZoneFeed.json'));
}

function assertValid(validate, feed, label) {
  if (validate(feed)) {
    console.log(`PASS [${label}]: schema valid — ${feed.features.length} feature(s)`);
  } else {
    console.error(`FAIL [${label}]: schema validation errors:`);
    (validate.errors || []).forEach((e) => {
      console.error(`  • ${e.instancePath || '(root)'}: ${e.message}`);
    });
    process.exit(1);
  }
}

async function main() {
  const validate = buildValidator();

  // ── Test 1: empty feed ──────────────────────────────────────────────────
  let res = await request('GET', '/feed');
  assertValid(validate, res.body, 'empty feed');

  // ── Test 2: post an event, re-validate feed ─────────────────────────────
  const posted = await request('POST', '/api/events', {
    road_name: 'SR-150',
    direction: 'eastbound',
    start_coords: [-86.81, 33.51],
    end_coords: [-86.79, 33.52],
    start_date: '2026-07-28T06:00:00Z',
    end_date: '2026-07-28T14:00:00Z',
    total_lanes: 2,
    lanes: [
      { order: 1, status: 'closed' },
      { order: 2, status: 'open' },
    ],
    vehicle_impact: 'some-lanes-closed',
    location_method: 'channel-device-method',
  });

  if (posted.status !== 201) {
    console.error('FAIL [post event]: expected 201, got', posted.status, posted.body);
    process.exit(1);
  }
  const eventId = posted.body.id;
  console.log(`PASS [post event]: created ${eventId}`);

  res = await request('GET', '/feed');
  assertValid(validate, res.body, 'feed with one event');

  // Spot-check that the feature looks right
  const feature = res.body.features.find((f) => f.id === eventId);
  if (!feature) {
    console.error('FAIL [feature present]: posted event not found in feed');
    process.exit(1);
  }
  console.log(`PASS [feature present]: event appears in feed`);
  console.log(`      road: ${feature.properties.core_details.road_names[0]}`);
  console.log(`      direction: ${feature.properties.core_details.direction}`);
  console.log(`      lanes: ${feature.properties.lanes.length}`);
  console.log(`      location_method: ${feature.properties.location_method}`);

  // ── Test 3: post open-ended event (no end_date), re-validate ───────────
  const open = await request('POST', '/api/events', {
    road_name: 'I-20 W',
    direction: 'westbound',
    start_coords: [-86.90, 33.50],
    end_coords: [-86.92, 33.50],
    start_date: '2026-07-27T14:00:00Z',
    vehicle_impact: 'all-lanes-closed',
    location_method: 'sign-method',
  });

  if (open.status !== 201) {
    console.error('FAIL [open-ended event]: expected 201, got', open.status, open.body);
    process.exit(1);
  }
  console.log(`PASS [open-ended event]: created ${open.body.id} (no end_date)`);

  res = await request('GET', '/feed');
  assertValid(validate, res.body, 'feed with open-ended event');

  // ── Cleanup ─────────────────────────────────────────────────────────────
  const Database = require('better-sqlite3');
  const db = new Database(path.join(__dirname, 'data', 'events.db'));
  db.prepare('DELETE FROM events WHERE id IN (?, ?)').run(eventId, open.body.id);
  db.close();
  console.log('     (test events cleaned up)');
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
