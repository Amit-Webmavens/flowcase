import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_TARGET = process.env.FLOWCASE_API ?? 'http://127.0.0.1:4100';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Relative base so the built SPA works no matter what path the server mounts it on.
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5174,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/artifacts': { target: API_TARGET, changeOrigin: true },
      '/ws': { target: API_TARGET.replace(/^http/, 'ws'), ws: true },
    },
  },
});
