// models/wzdxFeed.js
//
// Builds a WZDx v4.2 WorkZoneFeed GeoJSON FeatureCollection from our
// internal event records. Reference: usdot-jpo-ode/wzdx spec-content.
//
// This intentionally implements only the REQUIRED subset of the spec
// (feed_info, road_event_feature core details, geometry, lanes) needed
// to pass validation — extend as real deployments demand more fields
// (detours, restrictions, worker_presence, etc).

const FEED_PUBLISHER = {
  publisher: process.env.WZDX_PUBLISHER || 'Independent Work Zone Feed (pilot)',
  contact_name: process.env.WZDX_CONTACT_NAME || 'David Clark',
  contact_email: process.env.WZDX_CONTACT_EMAIL || 'unset@example.com',
};

const DATA_SOURCE_ID = 'primary-source-001';

function buildFeedInfo() {
  return {
    publisher: FEED_PUBLISHER.publisher,
    contact_name: FEED_PUBLISHER.contact_name,
    contact_email: FEED_PUBLISHER.contact_email,
    update_date: new Date().toISOString(),
    update_frequency: 60,
    version: '4.2',
    data_sources: [
      {
        data_source_id: DATA_SOURCE_ID,
        organization_name: FEED_PUBLISHER.publisher,
        update_date: new Date().toISOString(),
        update_frequency: 60,
        contact_name: FEED_PUBLISHER.contact_name,
        contact_email: FEED_PUBLISHER.contact_email,
      },
    ],
  };
}

// event shape expected (see routes/events.js for the intake contract):
// {
//   id, road_name, direction, event_type ('work-zone' | 'incident'),
//   start_coords: [lng, lat], end_coords: [lng, lat],
//   start_date, end_date (ISO, optional for open-ended),
//   lanes: [{ order, status, type }],
//   vehicle_impact
// }
// When end_date is absent (open-ended event), emit an estimated end 8 hours
// after start as the spec requires end_date to be a date-time string, not null.
// is_end_date_verified is left false to signal the estimate is unconfirmed.
function estimatedEndDate(startDate) {
  const d = new Date(startDate);
  d.setHours(d.getHours() + 8);
  return d.toISOString();
}

function eventToFeature(event) {
  const endDateVerified = Boolean(event.end_date);
  const endDate = event.end_date || estimatedEndDate(event.start_date);

  return {
    id: event.id,
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: [event.start_coords, event.end_coords],
    },
    properties: {
      core_details: {
        event_type: 'work-zone',
        data_source_id: DATA_SOURCE_ID,
        road_names: [event.road_name],
        direction: event.direction,
        relationship: {},
        name: event.name || undefined,
      },
      start_date: event.start_date,
      end_date: endDate,
      is_start_date_verified: true,
      is_end_date_verified: endDateVerified,
      is_start_position_verified: true,
      is_end_position_verified: true,
      vehicle_impact: event.vehicle_impact || 'some-lanes-closed',
      location_method: event.location_method || 'channel-device-method',
      lanes: (event.lanes || []).map((lane) => ({
        order: lane.order,
        status: lane.status,
        type: lane.type || 'general',
      })),
    },
  };
}

function buildWorkZoneFeed(events) {
  return {
    feed_info: buildFeedInfo(),
    type: 'FeatureCollection',
    features: events.map(eventToFeature),
  };
}

module.exports = { buildWorkZoneFeed };
