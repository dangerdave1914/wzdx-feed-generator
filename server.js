// server.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const eventsRouter = require('./routes/events');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', eventsRouter);
app.get('/feed', (req, res, next) => next()); // handled by router mounted below too
app.use('/', eventsRouter); // exposes GET /feed at the root, matching WZDx convention

app.listen(PORT, () => {
  console.log(`WZDx feed generator running on http://localhost:${PORT}`);
  console.log(`Intake form:  http://localhost:${PORT}/`);
  console.log(`Public feed:  http://localhost:${PORT}/feed`);
});
