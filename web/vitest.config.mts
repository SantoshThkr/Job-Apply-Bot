import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@bot': fileURLToPath(new URL('../src', import.meta.url)),
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    name: 'dashboard',
    environment: 'happy-dom',
    include: ['**/*.test.tsx'],
    exclude: ['node_modules/**', '.next/**'],
  },
});
