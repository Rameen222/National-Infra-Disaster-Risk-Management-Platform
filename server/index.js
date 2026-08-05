// NIRRP geocoding proxy.
// Single responsibility: proxy Google Places (search + details) using a
// service-account credential the browser must never see. All map/risk data is
// served by the Python backend (/pyapi); this server only owns /api/geocode.
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const geocodeRouter = require('./routes/geocode');

const app = express();
const PORT = process.env.PORT || 5000;

// Security & middleware
app.use(helmet());
app.use(cors({
  origin: true, // reflect any origin — safe on a trusted LAN
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));

// The only API surface: the geocoding proxy.
app.use('/api/geocode', geocodeRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'NIRRP Geocoding Proxy', timestamp: new Date().toISOString() });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// Only start the listener when run directly (`node index.js`), not when
// imported by tests (supertest drives the exported `app` in-process).
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`NIRRP Geocoding Proxy running on http://0.0.0.0:${PORT}`);
  });
}

module.exports = app;
