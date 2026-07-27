// test-schema.js
//
// Validates GET /feed output against the official WZDx v4.2 JSON Schema.
// Run with: node test-schema.js
//
// Requires the server to be running on localhost:3000.
// Schemas are in schemas/4.2/ (downloaded from the usdot-jpo-ode/wzdx repo).

const http = require('http');
const path = require('path');
const fs = require('fs');
const Ajv = require('ajv');

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Non-JSON response: ' + body.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

function loadSchema(filename) {
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, 'schemas', '4.2', filename), 'utf8')
  );
}

async function main() {
  const ajv = new Ajv({ strict: false });

  // Register all local schemas so $ref resolution uses local copies.
  const schemaFiles = [
    { file: 'BoundingBox.json' },
    { file: 'Direction.json' },
    { file: 'FeedInfo.json' },
    { file: 'RoadEventFeature.json' },
    { file: 'LineString.json' },
    { file: 'MultiPoint.json' },
  ];
  for (const { file } of schemaFiles) {
    ajv.addSchema(loadSchema(file));
  }

  const rootSchema = loadSchema('WorkZoneFeed.json');

  console.log('Fetching feed from http://localhost:3000/feed ...');
  let feed;
  try {
    feed = await get('http://localhost:3000/feed');
  } catch (e) {
    console.error('FAIL: Could not fetch feed —', e.message);
    console.error('      Is the server running? (npm start)');
    process.exit(1);
  }

  const validate = ajv.compile(rootSchema);
  const valid = validate(feed);

  if (valid) {
    console.log('PASS: feed output is valid against WZDx v4.2 WorkZoneFeed schema');
    console.log(`      Features in feed: ${feed.features.length}`);
  } else {
    console.error('FAIL: schema validation errors:');
    (validate.errors || []).forEach((e) => {
      console.error(`  • ${e.instancePath || '(root)'}: ${e.message}`);
      if (e.params && Object.keys(e.params).length) {
        console.error('    params:', JSON.stringify(e.params));
      }
    });
    process.exit(1);
  }
}

main();
