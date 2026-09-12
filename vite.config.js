import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5175, strictPort: true },
  build: { outDir: 'dist', target: 'es2022' },
});
