import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig(({ mode }) => {
  // All ports + the GeoServer URL come from the project-root .env.
  // Edit that one file to change anything.
  const rootEnv = loadEnv(mode, path.resolve(__dirname, '..'), '');
  const clientPort     = parseInt(rootEnv.CLIENT_PORT     || '7541', 10);
  const serverPort     = parseInt(rootEnv.SERVER_PORT     || '7542', 10);
  const pybackendPort  = parseInt(rootEnv.PYBACKEND_PORT  || '7543', 10);
  const geoserverTarget  = rootEnv.GEOSERVER_URL    || 'http://172.18.1.151:8080';
  const tileServerUrl   = rootEnv.TILE_SERVER_URL   || '';
  const mapboxToken     = rootEnv.MAPBOX_TOKEN      || '';
  const impactServiceUrl = rootEnv.IMPACT_SERVICE_URL || 'http://172.18.1.45:5009';
  const gcopExposureUrl  = rootEnv.GCOP_EXPOSURE_URL  || 'http://172.18.1.108:8000';

  return {
    plugins: [react()],
    // Vitest config (vitest reads it from vite.config — one toolchain, one file).
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: './src/test/setup.js',
      css: true,
      include: ['src/**/*.{test,spec}.{js,jsx}'],
    },
    // Inject root-.env values that need to reach the client bundle.
    // Accessed in code as import.meta.env.VITE_MAPBOX_TOKEN
    define: {
      'import.meta.env.VITE_MAPBOX_TOKEN':    JSON.stringify(mapboxToken),
      'import.meta.env.VITE_TILE_SERVER_URL': JSON.stringify(tileServerUrl),
    },
    server: {
      port: clientPort,
      strictPort: true, // fail loudly if the port is taken instead of bumping
      host: true,       // expose on local network (0.0.0.0)
      open: false,      // start.bat / start.sh handles the browser
      proxy: {
        '/api': {
          target: `http://localhost:${serverPort}`,
          changeOrigin: true,
        },
        '/pyapi': {
          target: `http://localhost:${pybackendPort}`,
          changeOrigin: true,
        },
        // Streams Exposure service (GLOFAS + indicators).
        // Configurable via IMPACT_SERVICE_URL in root .env.
        '/impact-api': {
          target: impactServiceUrl,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/impact-api/, ''),
        },
        // GCOP / DEW exposure service (list exposures, fetch GeoJSON details).
        // Configurable via GCOP_EXPOSURE_URL in root .env.
        '/gcop-api': {
          target: gcopExposureUrl,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/gcop-api/, ''),
        },
        '/geoserver/': {
          target: geoserverTarget,
          changeOrigin: true,
          timeout: 300000,
          proxyTimeout: 300000,
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              proxyReq.setHeader('Connection', 'keep-alive');
            });
          },
        },
      },
    },
  };
});
