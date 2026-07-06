import { defineConfig } from 'vite';

const target = process.env.CRATE_SERVER ?? 'http://localhost:8080';

export default defineConfig({
  server: {
    host: true,
    port: 5174,
    proxy: {
      '/api': { target, changeOrigin: true },
      '/art': { target, changeOrigin: true },
    },
  },
});
