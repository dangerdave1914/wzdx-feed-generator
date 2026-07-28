// models/wzdxFeed.js
//
// Builds a WZDx v4.2 WorkZoneFeed GeoJSON FeatureCollection from our
// internal event records. Reference: usdot-jpo-ode/wzdx spec-content.
//
// Only Construction and Road Maintenance obstruction types are published.
// Traffic Incident and Accident/EMS events are stored internally but
// filtered out of the public feed — WZDx WorkZoneFeed is explicitly
// scoped to planned/temporary work zones, not live incident response.
//
// This intentionally implements only the REQUIRED subset of the spec
// (feed_info, core details, geometry, lanes) plus the optional fields
// we actually populate: types_of_work, reduced_speed_limit_kph.

// Configurable retention window: after an event's end_date passes, it stays
// in the feed for this long so downstream consumers have time to process the
// closure before the event disappears. Default: 60 minutes.
// The WZDx spec does not mandate a specific window — this is our own policy.
const FEED_RETENTION_MS = (parseInt(process.env.FEED_RETENTION_MINUTES, 10) || 60) * 60 * 1000;

const FEED_PUBLISHER = {
  publisher:     process.env.WZDX_PUBLISHER     || 'Independent Work Zone Feed (pilot)',
  contact_name:  process.env.WZDX_CONTACT_NAME  || 'David Clark',
  contact_email: process.env.WZDX_CONTACT_EMAIL || 'unset@example.com',
};

const DATA_SOURCE_ID = 'primary-source-001';

// Obstruction types that are NOT published to the public WZDx feed.
const UNPUBLISHED_TYPES = new Set(['traffic-incident', 'accident-ems']);

function buildFeedInfo() {
  return {
    publisher:        FEED_PUBLISHER.publisher,
    contact_name:     FEED_PUBLISHER.contact_name,
    contact_email:    FEED_PUBLISHER.contact_email,
    update_date:      new Date().toISOString(),
    update_frequency: 60,
    version:          '4.2',
    data_sources: [
      {
        data_source_id:    DATA_SOURCE_ID,
        organization_name: FEED_PUBLISHER.publisher,
        update_date:       new Date().toISOString(),
        update_frequency:  60,
        contact_name:      FEED_PUBLISHER.contact_name,
        contact_email:     FEED_PUBLISHER.contact_email,
      },
    ],
  };
}

// If end_date is absent, emit an estimated end based on duration_type.
// The spec requires end_date to be a date-time string — null fails schema.
// is_end_date_verified is false to signal the estimate is unconfirmed.
function estimatedEndDate(startDate, durationType) {
  const d = new Date(startDate);
  if (durationType === 'long-term') {
    d.setDate(d.getDate() + 7);  // 7-day window for multi-day closures
  } else {
    d.setHours(d.getHours() + 8); // single-shift estimate
  }
  return d.toISOString();
}

// Use perimeter_points if available (field-capture mode), else start/end.
// WZDx LineString requires 2+ positions — both paths satisfy that.
function getGeometry(event) {
  if (Array.isArray(event.perimeter_points) && event.perimeter_points.length >= 2) {
    return { type: 'LineString', coordinates: event.perimeter_points };
  }
  return { type: 'LineString', coordinates: [event.start_coords, event.end_coords] };
}

// Map obstruction_type to WZDx types_of_work.
// WorkTypeName enum (verified against schemas/4.2/RoadEventFeature.json):
//   maintenance, minor-road-defect-repair, roadside-work, overhead-work,
//   below-road-work, barrier-work, surface-work, painting,
//   roadway-relocation, roadway-creation
// Incident types are filtered before this function is called.
function getTypesOfWork(obstructionType) {
  switch (obstructionType) {
    case 'construction':
      return [{ type_name: 'surface-work', is_architectural_change: true }];
    case 'road-maintenance':
      return [{ type_name: 'maintenance', is_architectural_change: false }];
    default:
      return undefined;
  }
}

function eventToFeature(event) {
  const endDateVerified = Boolean(event.end_date);
  const endDate        = event.end_date || estimatedEndDate(event.start_date, event.duration_type);
  const typesOfWork    = getTypesOfWork(event.obstruction_type);

  const properties = {
    core_details: {
      event_type:    'work-zone',
      data_source_id: DATA_SOURCE_ID,
      road_names:    [event.road_name],
      direction:     event.direction,
      relationship:  {},
      name:          event.name || undefined,
    },
    start_date:              event.start_date,
    end_date:                endDate,
    is_start_date_verified:  true,
    is_end_date_verified:    endDateVerified,
    is_start_position_verified: true,
    is_end_position_verified:   true,
    vehicle_impact:          event.vehicle_impact || 'some-lanes-closed',
    location_method:         event.location_method || 'channel-device-method',
    lanes: (event.lanes || []).map((lane) => ({
      order:  lane.order,
      status: lane.status,
      type:   lane.type || 'general',
    })),
  };

  if (typesOfWork) {
    properties.types_of_work = typesOfWork;
  }
  if (typeof event.reduced_speed_limit_kph === 'number') {
    properties.reduced_speed_limit_kph = event.reduced_speed_limit_kph;
  }

  return {
    id:         event.id,
    type:       'Feature',
    geometry:   getGeometry(event),
    properties,
  };
}

function buildWorkZoneFeed(events) {
  const now = Date.now();
  const publishable = events.filter((e) => {
    if (UNPUBLISHED_TYPES.has(e.obstruction_type)) return false;
    if (e.end_date) {
      const endMs = new Date(e.end_date).getTime();
      if (now > endMs + FEED_RETENTION_MS) return false; // past retention window
    }
    return true;
  });
  return {
    feed_info: buildFeedInfo(),
    type:      'FeatureCollection',
    features:  publishable.map(eventToFeature),
  };
}

module.exports = { buildWorkZoneFeed };
