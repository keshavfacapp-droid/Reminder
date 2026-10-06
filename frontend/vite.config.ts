import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backend = process.env.BACKEND_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Inline nothing: the CSP forbids inline scripts and data: scripts.
    assetsInlineLimit: 0,
  },
  server: {
    proxy: {
      '/api': { target: backend },
      '/ws': { target: backend.replace(/^http/, 'ws'), ws: true },
    },
  },
});
