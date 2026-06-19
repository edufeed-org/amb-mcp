#!/usr/bin/env node
/**
 * AMB Relay MCP Server - Streamable HTTP Transport
 *
 * Third entry point alongside `src/index.ts` (Nostr/ContextVM) and
 * `src/stdio.ts` (stdio). Mounts MCP at `/mcp` so web-based MCP clients
 * (Claude.ai connectors, MCP Inspector, custom browser apps) can connect.
 */

import {
  loadAuthorSets,
  setAuthorDirectory,
  setCalendarAuthorDirectory,
} from './authors.js';
import { startHttpServer } from './transport/http.js';
import { buildSessionServer } from './session.js';
import { SERVER_NAME, SERVER_VERSION } from './server-info.js';

// Configuration from environment
const AMB_RELAYS = process.env.AMB_RELAYS?.split(',') || ['wss://relay.edufeed.org'];
const AMB_AUTHOR_SETS = process.env.AMB_AUTHOR_SETS?.split(',').filter(Boolean) || [];
const CALENDAR_RELAYS =
  process.env.CALENDAR_RELAYS?.split(',').filter(Boolean) || ['wss://dev.calendar-relay.edufeed.org'];
const CALENDAR_AUTHOR_SETS =
  process.env.CALENDAR_AUTHOR_SETS?.split(',').filter(Boolean) || [];

const HTTP_PORT = Number(process.env.HTTP_PORT ?? 3000);
const HTTP_HOST = process.env.HTTP_HOST ?? '0.0.0.0';
const HTTP_BEARER_TOKEN = process.env.HTTP_BEARER_TOKEN || undefined;
const HTTP_ALLOWED_HOSTS = process.env.HTTP_ALLOWED_HOSTS?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const HTTP_ALLOWED_ORIGINS = process.env.HTTP_ALLOWED_ORIGINS?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

async function main() {
  console.log('Starting AMB Relay MCP Server (HTTP mode)...');
  console.log(`AMB Relays: ${AMB_RELAYS.join(', ')}`);
  console.log(`Calendar Relays: ${CALENDAR_RELAYS.join(', ')}`);
  console.log(`HTTP bind: ${HTTP_HOST}:${HTTP_PORT}`);
  console.log(`Auth: ${HTTP_BEARER_TOKEN ? 'bearer token required' : 'open (no auth)'}`);
  if (HTTP_ALLOWED_HOSTS?.length) console.log(`Allowed hosts: ${HTTP_ALLOWED_HOSTS.join(', ')}`);
  if (HTTP_ALLOWED_ORIGINS?.length) console.log(`Allowed origins: ${HTTP_ALLOWED_ORIGINS.join(', ')}`);

  // Load author sets once at startup; setAuthorDirectory mutates module
  // state shared across all sessions.
  if (AMB_AUTHOR_SETS.length > 0) {
    console.log(`Loading author sets from ${AMB_AUTHOR_SETS.length} naddr(s)...`);
    try {
      const directory = await loadAuthorSets(AMB_AUTHOR_SETS, AMB_RELAYS);
      setAuthorDirectory(directory);
      console.log(
        `Loaded ${directory.authors.length} authors from ${directory.sets.length} set(s)`,
      );
    } catch (error) {
      console.error('Failed to load author sets:', error);
    }
  }

  if (CALENDAR_AUTHOR_SETS.length > 0) {
    console.log(`Loading calendar author sets from ${CALENDAR_AUTHOR_SETS.length} naddr(s)...`);
    try {
      const directory = await loadAuthorSets(CALENDAR_AUTHOR_SETS, CALENDAR_RELAYS);
      setCalendarAuthorDirectory(directory);
      console.log(
        `Loaded ${directory.authors.length} calendar authors from ${directory.sets.length} set(s)`,
      );
    } catch (error) {
      console.error('Failed to load calendar author sets:', error);
    }
  }

  const handle = await startHttpServer({
    port: HTTP_PORT,
    host: HTTP_HOST,
    bearerToken: HTTP_BEARER_TOKEN,
    allowedHosts: HTTP_ALLOWED_HOSTS,
    allowedOrigins: HTTP_ALLOWED_ORIGINS,
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    buildMcpServer: () => {
      // Per-session relay clients: each session starts from the configured
      // defaults and can add/remove relays without affecting other sessions.
      const { server, dispose } = buildSessionServer(AMB_RELAYS, CALENDAR_RELAYS);
      return { server, dispose };
    },
  });

  console.log(`✓ AMB MCP Server listening at http://${HTTP_HOST}:${HTTP_PORT}/mcp`);
  console.log(`  Health: http://${HTTP_HOST}:${HTTP_PORT}/healthz`);
  console.log('Press Ctrl+C to stop');

  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    try {
      // Closes all active session transports, each of which disposes its
      // own relay clients via the onclose hook.
      await handle.close();
    } catch (err) {
      console.error('Error closing HTTP server:', err);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
