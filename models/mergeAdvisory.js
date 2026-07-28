// models/mergeAdvisory.js
//
// MUTCD Merge Advisory Calculator — value-add computed product.
//
// Source: FHWA MUTCD 2009 Edition with Revisions 1 & 2, Part 6C
//   Taper formula  → Table 6C-4  (Section 6C.08)
//   Sign spacing   → Table 6C-1
//   https://mutcd.fhwa.dot.gov/htm/2009r1r2/part6/part6c.htm
//
// IMPORTANT: This module must NOT be imported by or coupled to wzdxFeed.js.
// These advisories are a separate value-add product, not a WZDx spec field.

'use strict';

const KPH_TO_MPH = 0.621371;

// ---------------------------------------------------------------------------
// MUTCD 2009 Table 6C-1 — Advance Warning Sign Spacing (feet)
//
// Columns:
//   a = distance from taper start (restriction) → Sign 1 (closest to work zone)
//   b = Sign 1 → Sign 2
//   c = Sign 2 → Sign 3 (furthest upstream; first sign drivers encounter)
//
// The MUTCD does not numerically define the urban "low speed" / "high speed"
// boundary — Table 6C-1 footnote reads: "Speed category to be determined by
// the highway agency."  40 mph is the most common agency default and mirrors
// the taper formula break at the same threshold.
const URBAN_HIGH_SPEED_THRESHOLD_MPH = 40; // agency-defined; change if your DOT sets differently

const ADVANCE_WARNING_TABLE = {
  'urban-low':  { a: 100,  b: 100,  c: 100  },  // urban, speed ≤ URBAN_HIGH_SPEED_THRESHOLD_MPH
  'urban-high': { a: 350,  b: 350,  c: 350  },  // urban, speed > URBAN_HIGH_SPEED_THRESHOLD_MPH
  'rural':      { a: 500,  b: 500,  c: 500  },
  'freeway':    { a: 1000, b: 1500, c: 2640 },
};

// Standard US lane width (AASHTO Green Book).
// Real lane widths range 10–14 ft. This default is applied only when no
// measured width is available; it may over- or under-estimate taper length.
const DEFAULT_LANE_WIDTH_FT = 12;

// ---------------------------------------------------------------------------

/**
 * Calculate merge taper length per MUTCD 2009 Part 6C, Table 6C-4.
 *
 *   Speed ≤ 40 mph → L = W × S² / 60
 *   Speed ≥ 45 mph → L = W × S
 *
 * No US posted speed limit falls between 41–44 mph, so the gap is never
 * reached in practice. For robustness, values < 45 use the lower formula
 * (produces a longer, more conservative taper).
 *
 * @param {number} laneWidthFt  Lane (offset) width in feet
 * @param {number} speedMph     Posted or anticipated operating speed in mph
 * @returns {number}            Taper length in feet
 */
function calculateTaperLength(laneWidthFt, speedMph) {
  if (typeof laneWidthFt !== 'number' || laneWidthFt <= 0) {
    throw new Error('laneWidthFt must be a positive number');
  }
  if (typeof speedMph !== 'number' || speedMph <= 0) {
    throw new Error('speedMph must be a positive number');
  }

  if (speedMph < 45) {
    // MUTCD formula for ≤ 40 mph (applied conservatively for any speed < 45)
    return (laneWidthFt * speedMph * speedMph) / 60;
  } else {
    // MUTCD formula for ≥ 45 mph
    return laneWidthFt * speedMph;
  }
}

/**
 * Look up advance warning sign spacing per MUTCD 2009 Part 6C, Table 6C-1.
 *
 * Returns the three inter-sign spacing values (a, b, c) and their total,
 * which is the minimum distance from the taper start to the furthest
 * upstream advance warning sign.
 *
 * @param {number} speedMph   Posted or operating speed in mph
 * @param {string} roadType   'urban' | 'rural' | 'freeway'
 * @returns {{ category: string, a_ft: number, b_ft: number, c_ft: number, total_ft: number }}
 */
function calculateAdvanceWarningDistance(speedMph, roadType) {
  if (typeof speedMph !== 'number' || speedMph <= 0) {
    throw new Error('speedMph must be a positive number');
  }

  let category;
  switch (roadType) {
    case 'freeway':
      category = 'freeway';
      break;
    case 'rural':
      category = 'rural';
      break;
    case 'urban':
      category = speedMph > URBAN_HIGH_SPEED_THRESHOLD_MPH ? 'urban-high' : 'urban-low';
      break;
    default:
      throw new Error(`roadType must be 'urban', 'rural', or 'freeway'; got '${roadType}'`);
  }

  const s = ADVANCE_WARNING_TABLE[category];
  return {
    category,
    a_ft: s.a,
    b_ft: s.b,
    c_ft: s.c,
    total_ft: s.a + s.b + s.c,
  };
}

/**
 * Build a full merge advisory for a stored event.
 *
 * Speed resolution (first match wins):
 *   1. event.reduced_speed_limit_kph (work-zone posted speed, converted to mph)
 *   2. opts.postedSpeedMph (caller-supplied approach speed)
 *   If neither is present, throws — no silent default (safety-relevant).
 *
 * Lane width: DEFAULT_LANE_WIDTH_FT (12 ft assumed). No width field exists in
 * the current event schema; capture real lane width for higher accuracy.
 *
 * All distances in the output are measured upstream from the work zone boundary
 * (the point where the lane is physically closed). distance_from_closure_ft = 0
 * is the work zone start; larger values are further upstream.
 *
 * @param {object} event              Stored event from the database
 * @param {object} [opts]
 * @param {number} [opts.postedSpeedMph]  Required when event.reduced_speed_limit_kph is absent
 * @param {string} [opts.roadType]        'urban'|'rural'|'freeway'; defaults to 'rural'
 * @returns {object}
 */
function buildMergeAdvisory(event, opts = {}) {
  // --- Speed ---
  let speedMph;
  let speedSource;

  if (event.reduced_speed_limit_kph != null) {
    speedMph = Math.round(event.reduced_speed_limit_kph * KPH_TO_MPH);
    speedSource = 'event.reduced_speed_limit_kph';
  } else if (opts.postedSpeedMph != null) {
    const parsed = Number(opts.postedSpeedMph);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error('posted_speed_mph must be a positive number');
    }
    speedMph = parsed;
    speedSource = 'caller-supplied posted_speed_mph';
  } else {
    throw new Error(
      'Speed limit required: set reduced_speed_limit_kph on the event, ' +
      'or pass ?posted_speed_mph=N as a query parameter.'
    );
  }

  // --- Road type ---
  const roadType = opts.roadType || 'rural';
  const roadTypeAssumed = !opts.roadType;
  if (!['urban', 'rural', 'freeway'].includes(roadType)) {
    throw new Error("road_type must be 'urban', 'rural', or 'freeway'");
  }

  // --- Lane analysis ---
  const lanes = Array.isArray(event.lanes) ? event.lanes : [];
  const totalLanes = event.total_lanes || lanes.length || null;
  const closedLanes = lanes.filter(l => l.status === 'closed');
  const closedLaneCount = closedLanes.length;
  const openLaneCount = totalLanes != null ? totalLanes - closedLaneCount : null;

  // Determine merge direction from lane order (1 = leftmost).
  // Right-side closure (highest order lane closed) → merge left.
  // Left-side closure  (lowest order lane closed)  → merge right.
  let mergeDirection = null;
  if (closedLanes.length > 0 && lanes.length > 0) {
    const closedOrders = new Set(closedLanes.map(l => l.order));
    const allOrders    = lanes.map(l => l.order);
    const maxOrder     = Math.max(...allOrders);
    const minOrder     = Math.min(...allOrders);
    if (closedOrders.has(maxOrder)) mergeDirection = 'left';
    else if (closedOrders.has(minOrder)) mergeDirection = 'right';
  }
  const mergeLabel = mergeDirection === 'left'  ? 'Left'
                   : mergeDirection === 'right' ? 'Right'
                   : null;

  // --- Taper length (MUTCD Table 6C-4) ---
  // Lane width defaulted to 12 ft — no width field in current event schema.
  const laneWidthFt = DEFAULT_LANE_WIDTH_FT;
  const taperLengthFt = Math.round(calculateTaperLength(laneWidthFt, speedMph));

  // --- Advance warning sign spacing (MUTCD Table 6C-1) ---
  const aw = calculateAdvanceWarningDistance(speedMph, roadType);

  // --- Sign placement distances (upstream from work zone boundary = 0) ---
  // The taper starts taperLengthFt before the closure.
  // Signs are placed upstream of the taper start, per Table 6C-1 spacing.
  const taperStartDist = taperLengthFt;
  const sign1Dist      = taperStartDist + aw.a_ft;           // closest warning sign
  const sign2Dist      = sign1Dist + aw.b_ft;
  const sign3Dist      = sign2Dist + aw.c_ft;                // furthest; first sign drivers see

  // Advance warning sign messages follow MUTCD Part 6F sign conventions.
  const sign2Text = closedLaneCount === 0  ? 'Lane Closed Ahead'
                  : closedLaneCount === 1  ? (mergeLabel ? `${mergeLabel === 'Left' ? 'Right' : 'Left'} Lane Closed Ahead` : 'Lane Closed Ahead')
                  : `${closedLaneCount} Lanes Closed Ahead`;
  const sign1Text = mergeLabel ? `Merge ${mergeLabel}` : 'Merge Now';

  const laneDetail = closedLaneCount > 0 && totalLanes != null
    ? `${closedLaneCount} of ${totalLanes} lane(s) closed`
    : 'lane restriction begins';
  const openDetail = openLaneCount != null ? `; ${openLaneCount} lane(s) remain open` : '';

  const recommendedActions = [
    {
      distance_from_closure_ft: sign3Dist,
      instruction: 'Place advance warning sign (Sign 3 — furthest upstream): "Road Work Ahead"',
    },
    {
      distance_from_closure_ft: sign2Dist,
      instruction: `Place advance warning sign (Sign 2): "${sign2Text}"`,
    },
    {
      distance_from_closure_ft: sign1Dist,
      instruction: `Place advance warning sign (Sign 1): "${sign1Text}"`,
    },
    {
      distance_from_closure_ft: taperStartDist,
      instruction: `Taper begins — ${taperLengthFt} ft merge zone${mergeLabel ? `, channelize traffic ${mergeLabel.toLowerCase()}` : ''}`,
    },
    {
      distance_from_closure_ft: 0,
      instruction: `Work zone boundary — ${laneDetail}${openDetail}`,
    },
  ];

  return {
    event_id: event.id,
    computed_at: new Date().toISOString(),
    mutcd_source: 'FHWA MUTCD 2009 Ed. Rev. 1&2, Part 6C, Tables 6C-1 and 6C-4',
    disclaimer:
      'Value-add advisory computed from event data. NOT a WZDx spec field. ' +
      'Verify against actual site conditions, sight distance, and local agency ' +
      'standards before field use.',
    inputs: {
      speed_mph: speedMph,
      speed_source: speedSource,
      road_type: roadType,
      road_type_assumed: roadTypeAssumed,
      lane_width_ft: laneWidthFt,
      lane_width_assumed: true,    // no lane width field in current event schema
      total_lanes: totalLanes,
      closed_lane_count: closedLaneCount,
    },
    taper_length_ft: taperLengthFt,
    advance_warning: {
      category: aw.category,
      a_ft: aw.a_ft,
      b_ft: aw.b_ft,
      c_ft: aw.c_ft,
      total_ft: aw.total_ft,
    },
    advance_warning_distance_ft: aw.total_ft,
    total_influence_zone_ft: taperLengthFt + aw.total_ft,
    recommended_actions: recommendedActions,
  };
}

module.exports = { calculateTaperLength, calculateAdvanceWarningDistance, buildMergeAdvisory };
