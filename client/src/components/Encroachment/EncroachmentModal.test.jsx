import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EncroachmentModal from './EncroachmentModal';

const mockResult = {
  total_buildings: 100,
  encroachment_count: 2,
  percentage: 2.0,
  area_sqm: 50,
  zone_area_sqm: 1000,
  high_sus_count: 1,
  high_sus_percentage: 1.0,
};

const mockGeojson = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { bldg_id: 'BLDG-A', centroid_lat: 34.123456, centroid_lon: 73.654321 },
      geometry: {
        type: 'Polygon',
        coordinates: [[[73.65, 34.12], [73.66, 34.12], [73.66, 34.13], [73.65, 34.13], [73.65, 34.12]]],
      },
    },
    {
      type: 'Feature',
      properties: { bldg_id: 'BLDG-B', centroid_lat: 35.0, centroid_lon: 74.0 },
      geometry: {
        type: 'Polygon',
        coordinates: [[[74.0, 35.0], [74.1, 35.0], [74.1, 35.1], [74.0, 35.1], [74.0, 35.0]]],
      },
    },
  ],
};

function jsonResponse(body) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
}

describe('EncroachmentModal attribute table', () => {
  it('lets the user expand the building list and click a row to focus the map', async () => {
    global.fetch = vi.fn((url, options) => {
      if (url === '/pyapi/buildings/encroachment' && options?.method === 'POST') {
        return jsonResponse({ status: 'done', result: mockResult, cached: true });
      }
      if (url.startsWith('/pyapi/buildings/encroachment/geojson')) {
        return jsonResponse(mockGeojson);
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    const user = userEvent.setup();
    const onBuildingFocus = vi.fn();
    render(
      <EncroachmentModal
        district="Test District"
        onClose={() => {}}
        onBuildingFocus={onBuildingFocus}
      />,
    );

    // Stats finish first (cached path); the table toggle only appears once
    // the encroachment count is known and > 0.
    const toggle = await screen.findByText(/Show building details \(2\)/, {}, { timeout: 3000 });

    // Table is fetched lazily — not requested until the toggle is clicked.
    expect(screen.queryByText('BLDG-A')).not.toBeInTheDocument();

    await user.click(toggle);

    const rowA = await screen.findByText('BLDG-A');
    expect(rowA).toBeInTheDocument();
    expect(screen.getByText('34.123456')).toBeInTheDocument();
    expect(screen.getByText('BLDG-B')).toBeInTheDocument();

    await user.click(rowA.closest('tr'));
    expect(onBuildingFocus).toHaveBeenCalledTimes(1);
    expect(onBuildingFocus.mock.calls[0][0]).toEqual({ geometry: mockGeojson.features[0].geometry });
  });

  it('does not render a table toggle when no buildings are encroached', async () => {
    global.fetch = vi.fn((url, options) => {
      if (url === '/pyapi/buildings/encroachment' && options?.method === 'POST') {
        return jsonResponse({
          status: 'done',
          result: { ...mockResult, encroachment_count: 0 },
          cached: true,
        });
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    render(<EncroachmentModal district="Empty District" onClose={() => {}} />);

    await screen.findByText(/Buildings in encroachment zone/i, {}, { timeout: 3000 });
    expect(screen.queryByText(/Show building details/)).not.toBeInTheDocument();
  });
});
