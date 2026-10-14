import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const base = process.env.VITE_BASE ?? '/supplier/';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base,
  plugins: [react()],
  resolve: {
    alias: { '@zapas/shared': fileURLToPath(new URL('../../../packages/shared/src/index.ts', import.meta.url)) },
  },
  server: {
    port: 5174,
    proxy: { [`${base}api`]: { target: 'http://127.0.0.1:3100', changeOrigin: false } },
  },
  build: {
    outDir: fileURLToPath(new URL('../dist/web', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    assetsInlineLimit: 0,
  },
});
