const express = require('express');
const router = express.Router();
const path = require('path');
const { GoogleAuth } = require('google-auth-library');

// Service-account key path. Override with GOOGLE_APPLICATION_CREDENTIALS
// (the standard Google env var); falls back to ./geekey.json at the repo root.
const KEY_FILE =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  path.join(__dirname, '..', '..', 'geekey.json');
const SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];

// Cached auth instance — handles token refresh automatically
const auth = new GoogleAuth({ keyFile: KEY_FILE, scopes: SCOPES });

async function getBearerToken() {
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  return token;
}

// GET /api/geocode/search?q=<query>
// Uses Places API (New) autocomplete — supports service-account OAuth
router.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ suggestions: [] });

  try {
    const token = await getBearerToken();
    const response = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: q,
        includedRegionCodes: ['PK'],
        languageCode: 'en',
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[geocode] autocomplete API error', response.status, err);
      return res.status(response.status).json({ error: 'Upstream error', suggestions: [] });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('[geocode] autocomplete error', err.message);
    res.status(500).json({ error: 'Geocode search failed', suggestions: [] });
  }
});

// GET /api/geocode/details?place_id=<id>
// Uses Places API (New) place details
router.get('/details', async (req, res) => {
  const placeId = (req.query.place_id || '').trim();
  if (!placeId) return res.status(400).json({ error: 'place_id is required' });

  try {
    const token = await getBearerToken();
    const fields = 'displayName,formattedAddress,location,viewport,addressComponents';
    const response = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Goog-FieldMask': fields,
      },
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[geocode] details API error', response.status, err);
      return res.status(response.status).json({ error: 'Upstream error' });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('[geocode] details error', err.message);
    res.status(500).json({ error: 'Geocode details failed' });
  }
});

module.exports = router;
