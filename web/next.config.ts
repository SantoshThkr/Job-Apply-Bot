import path from 'node:path';
import type { NextConfig } from 'next';

const api = `http://127.0.0.1:${process.env.API_PORT ?? 4100}`;

const config: NextConfig = {
  // The dashboard imports ../src/domain.ts (statuses and API shapes shared with the bot).
  turbopack: { root: path.join(__dirname, '..') },
  // Next otherwise writes AGENTS.md and CLAUDE.md into this folder on every dev start.
  agentRules: false,
  devIndicators: false,
  // /api belongs to the bot's local server (`npm run server`), which owns the browser.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${api}/api/:path*` }];
  },
};

export default config;
