import { defineConfig } from 'vitest/config';

// The bot's tests, and the dashboard's (web/vitest.config.mts; needs `npm install --prefix web`).
export default defineConfig({
  test: {
    projects: [{ test: { name: 'bot', include: ['tests/**/*.test.ts'] } }, 'web/vitest.config.mts'],
  },
});
