import { defineConfig } from 'vite';

// The shelf talks only to the device service. In dev, proxy the API, artwork,
// and WebSocket to the server (default :8080).
const target = process.env.CRATE_SERVER ?? 'http://localhost:8080';

export default defineConfig({
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: true },
      '/art': { target, changeOrigin: true },
      '/ws': { target, ws: true },
    },
  },
});
