// models/store.js
//
// SQLite persistence layer (better-sqlite3).
// Events are stored as JSON blobs keyed by id — avoids schema churn
// as the event shape evolves.  Swap this for Postgres later without
// touching the route or feed-builder code: everything downstream only
// talks to getAllEvents() / getEvent() / saveEvent() / updateEvent().

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'events.db');
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id         TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT
  )
`);

// Prepare statements once at module load — synchronous, no per-call overhead.
const stmtAll    = db.prepare('SELECT data FROM events ORDER BY created_at ASC');
const stmtById   = db.prepare('SELECT data FROM events WHERE id = ?');
const stmtInsert = db.prepare(
  'INSERT INTO events (id, data, created_at) VALUES (?, ?, ?)'
);
const stmtUpdate = db.prepare(
  'UPDATE events SET data = ?, updated_at = ? WHERE id = ?'
);

function getAllEvents() {
  return stmtAll.all().map((row) => JSON.parse(row.data));
}

function getEvent(id) {
  const row = stmtById.get(id);
  return row ? JSON.parse(row.data) : null;
}

function saveEvent(event) {
  stmtInsert.run(event.id, JSON.stringify(event), event.created_at);
  return event;
}

function updateEvent(id, patch) {
  const existing = getEvent(id);
  if (!existing) return null;
  const updated = { ...existing, ...patch, updated_at: new Date().toISOString() };
  stmtUpdate.run(JSON.stringify(updated), updated.updated_at, id);
  return updated;
}

module.exports = { getAllEvents, getEvent, saveEvent, updateEvent };
