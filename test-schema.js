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

function waitForServer(retries = 20, intervalMs = 250) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    function try_() {
      http.get(BASE + '/feed', (res) => { res.resume(); resolve(); })
        .on('error', () => {
          if (++attempts >= retries) return reject(new Error('Server did not become ready'));
          setTimeout(try_, intervalMs);
        });
    }
    try_();
  });
}

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

  await waitForServer();

  // ── Test 1: empty feed ──────────────────────────────────────────────────
  let res = await request('GET', '/feed');
  assertValid(validate, res.body, 'empty feed');

  // ── Test 2: post an event, re-validate feed ─────────────────────────────
  const inEightHours = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
  const posted = await request('POST', '/api/events', {
    road_name: 'SR-150',
    direction: 'eastbound',
    start_coords: [-86.81, 33.51],
    end_coords: [-86.79, 33.52],
    start_date: new Date().toISOString(),
    end_date: inEightHours,
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
    start_date: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // started 1hr ago
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

  // ── Test 4: perimeter_points geometry (field-capture mode) ─────────────
  const perim = await request('POST', '/api/events', {
    road_name:        'Oak Street',
    direction:        'northbound',
    obstruction_type: 'construction',
    duration_type:    'short-term',
    perimeter_points: [
      [-86.800, 33.510],
      [-86.799, 33.512],
      [-86.797, 33.513],
      [-86.796, 33.511],
      [-86.798, 33.509],
    ],
    start_date:              new Date().toISOString(),
    vehicle_impact:          'some-lanes-closed',
    location_method:         'channel-device-method',
    total_lanes:             2,
    reduced_speed_limit_kph: 40,
  });

  if (perim.status !== 201) {
    console.error('FAIL [perimeter event]: expected 201, got', perim.status, perim.body);
    process.exit(1);
  }
  const perimId = perim.body.id;
  console.log(`PASS [perimeter event]: created ${perimId}`);

  res = await request('GET', '/feed');
  assertValid(validate, res.body, 'feed with perimeter event');

  const perimFeature = res.body.features.find((f) => f.id === perimId);
  if (!perimFeature) {
    console.error('FAIL [perimeter feature in feed]: not found');
    process.exit(1);
  }
  const coords = perimFeature.geometry.coordinates;
  if (coords.length !== 5) {
    console.error(`FAIL [perimeter geometry]: expected 5 coords, got ${coords.length}`);
    process.exit(1);
  }
  const tow = perimFeature.properties.types_of_work;
  if (!tow || tow[0].type_name !== 'surface-work') {
    console.error('FAIL [types_of_work]: expected surface-work, got', tow);
    process.exit(1);
  }
  if (perimFeature.properties.reduced_speed_limit_kph !== 40) {
    console.error('FAIL [reduced_speed_limit_kph]: expected 40');
    process.exit(1);
  }
  console.log(`PASS [perimeter feature]: 5-point LineString, types_of_work=surface-work, speed limit 40 kph`);

  // ── Test 5: incident event — saved internally, NOT in public feed ────────
  const incident = await request('POST', '/api/events', {
    road_name:        'I-65',
    direction:        'southbound',
    obstruction_type: 'traffic-incident',
    start_coords:     [-86.810, 33.500],
    end_coords:       [-86.812, 33.500],
    start_date:       new Date().toISOString(),
    vehicle_impact:   'all-lanes-closed',
    location_method:  'channel-device-method',
  });

  if (incident.status !== 201) {
    console.error('FAIL [incident event]: expected 201, got', incident.status, incident.body);
    process.exit(1);
  }
  const incidentId = incident.body.id;
  console.log(`PASS [incident event]: created ${incidentId} (traffic-incident)`);

  res = await request('GET', '/feed');
  assertValid(validate, res.body, 'feed after incident posted');

  if (res.body.features.some((f) => f.id === incidentId)) {
    console.error('FAIL [incident filtered]: traffic-incident should not appear in public feed');
    process.exit(1);
  }
  console.log(`PASS [incident filtered]: traffic-incident is NOT in public feed`);

  // ── Test 6: long-term event — road-maintenance, estimated end 7 days ────
  const longTerm = await request('POST', '/api/events', {
    road_name:        'US-280',
    direction:        'eastbound',
    obstruction_type: 'road-maintenance',
    duration_type:    'long-term',
    start_coords:     [-86.820, 33.490],
    end_coords:       [-86.818, 33.491],
    start_date:       new Date().toISOString(),
    vehicle_impact:   'some-lanes-closed',
    location_method:  'sign-method',
  });

  if (longTerm.status !== 201) {
    console.error('FAIL [long-term event]: expected 201, got', longTerm.status, longTerm.body);
    process.exit(1);
  }
  const ltId = longTerm.body.id;
  console.log(`PASS [long-term event]: created ${ltId}`);

  res = await request('GET', '/feed');
  assertValid(validate, res.body, 'feed with long-term event');

  const ltFeature = res.body.features.find((f) => f.id === ltId);
  const estEnd = new Date(ltFeature.properties.end_date);
  const ltStart  = new Date(longTerm.body.start_date);
  const diffDays = (estEnd - ltStart) / (1000 * 60 * 60 * 24);
  if (diffDays < 6.9 || diffDays > 7.1) {
    console.error(`FAIL [long-term end_date]: expected ~7 days, got ${diffDays.toFixed(2)} days`);
    process.exit(1);
  }
  const ltTow = ltFeature.properties.types_of_work;
  if (!ltTow || ltTow[0].type_name !== 'maintenance') {
    console.error('FAIL [long-term types_of_work]: expected maintenance, got', ltTow);
    process.exit(1);
  }
  console.log(`PASS [long-term end_date]: estimated end is ${diffDays.toFixed(1)} days out, types_of_work=maintenance`);

  // ── Test 7: closed event with expired end_date — must NOT appear in feed ─
  // Post an event with end_date 2 hours in the past. With the default
  // 60-minute retention window, this event is past the window and should be
  // filtered from /feed immediately. We test this without waiting by using a
  // backdated end_date in the POST — the server stores whatever date is given.
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const expiredEvent = await request('POST', '/api/events', {
    road_name:        'Test-Expired-Rd',
    direction:        'northbound',
    start_coords:     [-86.800, 33.500],
    end_coords:       [-86.801, 33.501],
    start_date:       new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), // 3 hrs ago
    end_date:         twoHoursAgo,
    vehicle_impact:   'some-lanes-closed',
    location_method:  'channel-device-method',
  });
  if (expiredEvent.status !== 201) {
    console.error('FAIL [expired event]: expected 201, got', expiredEvent.status, expiredEvent.body);
    process.exit(1);
  }
  const expiredId = expiredEvent.body.id;

  res = await request('GET', '/feed');
  assertValid(validate, res.body, 'feed with expired event posted');
  if (res.body.features.some((f) => f.id === expiredId)) {
    console.error('FAIL [expired event filtered]: event with end_date 2hrs ago should not appear in feed (retention window is 60 min)');
    process.exit(1);
  }
  console.log(`PASS [expired event filtered]: event past retention window is NOT in feed`);

  // ── Test 8: just-closed event — must still appear in feed ────────────────
  // Post an event, close it via PATCH (sets end_date = now), then verify it
  // is still in the feed (within the 60-minute retention window).
  const toClose = await request('POST', '/api/events', {
    road_name:        'Test-Close-Rd',
    direction:        'southbound',
    start_coords:     [-86.802, 33.502],
    end_coords:       [-86.803, 33.503],
    start_date:       new Date(Date.now() - 60 * 60 * 1000).toISOString(), // started 1 hr ago
    vehicle_impact:   'some-lanes-closed',
    location_method:  'channel-device-method',
  });
  if (toClose.status !== 201) {
    console.error('FAIL [close test post]: expected 201, got', toClose.status, toClose.body);
    process.exit(1);
  }
  const toCloseId = toClose.body.id;

  const closed = await request('PATCH', `/api/events/${toCloseId}/close`);
  if (closed.status !== 200) {
    console.error('FAIL [close event]: expected 200, got', closed.status, closed.body);
    process.exit(1);
  }
  if (!closed.body.end_date) {
    console.error('FAIL [close event]: end_date not set in response');
    process.exit(1);
  }
  console.log(`PASS [close event]: PATCH /api/events/${toCloseId}/close set end_date = ${closed.body.end_date}`);

  res = await request('GET', '/feed');
  assertValid(validate, res.body, 'feed after event closed');
  if (!res.body.features.some((f) => f.id === toCloseId)) {
    console.error('FAIL [retention window]: just-closed event should still appear in feed within retention window');
    process.exit(1);
  }
  console.log(`PASS [retention window]: just-closed event still appears in feed (within 60-min retention window)`);

  // ── Cleanup ─────────────────────────────────────────────────────────────
  const Database = require('better-sqlite3');
  const db = new Database(path.join(__dirname, 'data', 'events.db'));
  db.prepare('DELETE FROM events WHERE id IN (?, ?, ?, ?, ?, ?, ?)').run(
    eventId, open.body.id, perimId, incidentId, ltId, expiredId, toCloseId
  );
  db.close();
  console.log('     (test events cleaned up)');
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
