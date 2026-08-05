const request = require('supertest');
const app = require('../index');

describe('NIRRP Express API', () => {
  describe('GET /api/health', () => {
    it('reports the service as ok', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      // Assert the contract (status ok + a service name), not the exact label,
      // so renames (e.g. #9 -> "NIRRP Geocoding Proxy") don't break this.
      expect(res.body.status).toBe('ok');
      expect(typeof res.body.service).toBe('string');
    });
  });

  describe('geocode proxy', () => {
    // These exercise the route's own validation, before any Google call —
    // so they need no service-account key and make no network request.
    it('GET /api/geocode/search with no query returns empty suggestions', async () => {
      const res = await request(app).get('/api/geocode/search');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ suggestions: [] });
    });

    it('GET /api/geocode/details with no place_id returns 400', async () => {
      const res = await request(app).get('/api/geocode/details');
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });
  });

  describe('unknown routes', () => {
    it('returns 404 with an error body', async () => {
      const res = await request(app).get('/api/does-not-exist');
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error');
    });
  });
});
