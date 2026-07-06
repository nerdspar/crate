import { defineConfig } from 'vite';

const target = process.env.CRATE_SERVER ?? 'http://localhost:8080';

export default defineConfig({
  // Device service serves the built admin under /admin/; base makes asset URLs resolve there.
  base: '/admin/',
  server: {
    host: true,
    port: 5174,
    proxy: {
      '/api': { target, changeOrigin: true },
      '/art': { target, changeOrigin: true },
    },
  },
});
