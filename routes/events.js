// routes/events.js
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const store = require('../models/store');
const { buildWorkZoneFeed } = require('../models/wzdxFeed');

const router = express.Router();

// ---- Auth ---------------------------------------------------------------
// Write endpoints require an X-Api-Key header that matches the API_KEY env var.
// If API_KEY is unset (local dev), auth is skipped with a startup warning.
const API_KEY = process.env.API_KEY || null;
if (!API_KEY) {
  console.warn(
    '[WARN] API_KEY env var is not set — write endpoints are unprotected. ' +
    'Set API_KEY before exposing this server beyond localhost.'
  );
}

function requireApiKey(req, res, next) {
  if (!API_KEY) return next(); // dev mode: no key configured
  const provided = req.headers['x-api-key'];
  if (provided === API_KEY) return next();
  res.status(401).json({ error: 'Missing or invalid X-Api-Key header' });
}
// -------------------------------------------------------------------------

const VALID_LANE_STATUS = new Set([
  'open',
  'closed',
  'shift-left',
  'shift-right',
  'merge-left',
  'merge-right',
  'alternating-one-way',
]);

const VALID_OBSTRUCTION_TYPES = new Set([
  'construction',
  'road-maintenance',
  'traffic-incident',
  'accident-ems',
]);

const VALID_DURATION_TYPES = new Set(['short-term', 'long-term']);

// POST /api/events — crew/field intake
// Minimal required contract; reject early with a clear message rather
// than silently emitting a non-compliant feed downstream.
router.post('/events', requireApiKey, (req, res) => {
  const {
    road_name,
    direction,
    event_type,
    start_coords,
    end_coords,
    perimeter_points,
    start_date,
    end_date,
    total_lanes,
    lanes,
    vehicle_impact,
    location_method,
    obstruction_type,
    duration_type,
    reduced_speed_limit_kph,
    name,
  } = req.body;

  const errors = [];
  if (!road_name) errors.push('road_name is required');
  if (!direction) errors.push('direction is required');
  if (!start_date) errors.push('start_date is required (ISO 8601)');

  // Geometry: require either start_coords + end_coords, or perimeter_points ≥ 2.
  const hasStartEnd =
    Array.isArray(start_coords) && start_coords.length === 2 &&
    Array.isArray(end_coords)   && end_coords.length   === 2;
  const hasPerimeter =
    Array.isArray(perimeter_points) && perimeter_points.length >= 2;

  if (!hasStartEnd && !hasPerimeter) {
    errors.push(
      'Provide either (a) start_coords + end_coords as [lng, lat], ' +
      'or (b) perimeter_points as an array of 2+ [lng, lat] pairs'
    );
  }

  if (Array.isArray(perimeter_points)) {
    perimeter_points.forEach((pt, i) => {
      if (
        !Array.isArray(pt) || pt.length !== 2 ||
        typeof pt[0] !== 'number' || typeof pt[1] !== 'number'
      ) {
        errors.push(`perimeter_points[${i}] must be [lng, lat]`);
      }
    });
  }

  if (obstruction_type !== undefined && !VALID_OBSTRUCTION_TYPES.has(obstruction_type)) {
    errors.push(
      `obstruction_type "${obstruction_type}" must be one of: ` +
      [...VALID_OBSTRUCTION_TYPES].join(', ')
    );
  }

  if (duration_type !== undefined && !VALID_DURATION_TYPES.has(duration_type)) {
    errors.push('duration_type must be "short-term" or "long-term"');
  }

  if (
    reduced_speed_limit_kph !== undefined &&
    (typeof reduced_speed_limit_kph !== 'number' || reduced_speed_limit_kph < 0)
  ) {
    errors.push('reduced_speed_limit_kph must be a non-negative number');
  }

  if (Array.isArray(lanes) && lanes.length > 0) {
    // WZDx spec: if any lanes are reported, ALL lanes on the road event must
    // be reported.  We enforce this by requiring total_lanes and checking that
    // the submitted array covers every lane.
    if (typeof total_lanes !== 'number' || !Number.isInteger(total_lanes) || total_lanes < 1) {
      errors.push('total_lanes (integer ≥ 1) is required when lanes are provided');
    } else if (lanes.length !== total_lanes) {
      errors.push(
        `lanes array has ${lanes.length} entries but total_lanes is ${total_lanes}. ` +
        'WZDx requires every lane to be described when any lane is reported.'
      );
    }

    lanes.forEach((lane, i) => {
      if (typeof lane.order !== 'number') {
        errors.push(`lanes[${i}].order must be a number (1 = left-most)`);
      }
      if (!VALID_LANE_STATUS.has(lane.status)) {
        errors.push(`lanes[${i}].status "${lane.status}" is not a valid LaneStatus`);
      }
    });
  }

  if (errors.length) {
    return res.status(400).json({ errors });
  }

  // Store total_lanes whenever it's a valid integer — useful even without
  // individual lane status detail (e.g. perimeter capture mode).
  const storedTotalLanes =
    (typeof total_lanes === 'number' && Number.isInteger(total_lanes) && total_lanes >= 1)
      ? total_lanes
      : undefined;

  const event = {
    id: uuidv4(),
    road_name,
    direction,
    event_type: event_type || 'work-zone',
    start_coords:      hasStartEnd  ? start_coords      : undefined,
    end_coords:        hasStartEnd  ? end_coords        : undefined,
    perimeter_points:  hasPerimeter ? perimeter_points  : undefined,
    start_date,
    end_date:               end_date || null,
    total_lanes:            storedTotalLanes,
    lanes:                  lanes || [],
    vehicle_impact:         vehicle_impact || 'some-lanes-closed',
    location_method:        location_method || 'channel-device-method',
    obstruction_type:       obstruction_type || undefined,
    duration_type:          duration_type || 'short-term',
    reduced_speed_limit_kph: typeof reduced_speed_limit_kph === 'number'
      ? reduced_speed_limit_kph
      : undefined,
    name,
    created_at: new Date().toISOString(),
  };

  store.saveEvent(event);
  res.status(201).json(event);
});

// GET /api/events — internal list (not the public feed)
router.get('/events', (req, res) => {
  res.json(store.getAllEvents());
});

// PATCH /api/events/:id/close — mark an event ended (e.g. work finished)
router.patch('/events/:id/close', requireApiKey, (req, res) => {
  const updated = store.updateEvent(req.params.id, {
    end_date: new Date().toISOString(),
  });
  if (!updated) return res.status(404).json({ error: 'event not found' });
  res.json(updated);
});

// GET /feed — the actual public WZDx v4.2 WorkZoneFeed
router.get('/feed', (req, res) => {
  const events = store.getAllEvents();
  const feed = buildWorkZoneFeed(events);
  res.setHeader('Content-Type', 'application/geo+json');
  res.json(feed);
});

module.exports = router;
