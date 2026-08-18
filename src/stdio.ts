#!/usr/bin/env bun
/**
 * AMB Relay MCP Server - Stdio Transport
 *
 * This entry point is designed for use with `cvmi serve` or direct stdio MCP clients.
 * All logging goes to stderr to keep stdout clean for JSON-RPC.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { AMBRelayClient } from './relay/client.js';
import { registerTools } from './tools/index.js';
import { registerResources } from './resources/index.js';
import { loadAuthorSets, setAuthorDirectory, setCalendarAuthorDirectory } from './authors.js';
import { SERVER_NAME, SERVER_VERSION, SERVER_INSTRUCTIONS } from './server-info.js';

// Configuration from environment
const AMB_RELAYS = process.env.AMB_RELAYS?.split(',') || ['wss://relay.edufeed.org'];
const AMB_EXTRA_RELAYS = process.env.AMB_EXTRA_RELAYS?.split(',').filter(Boolean) || [];
const AMB_AUTHOR_SETS = process.env.AMB_AUTHOR_SETS?.split(',').filter(Boolean) || [];
const CALENDAR_RELAYS = process.env.CALENDAR_RELAYS?.split(',').filter(Boolean) || ['wss://relay.edufeed.org'];
const CALENDAR_AUTHOR_SETS = process.env.CALENDAR_AUTHOR_SETS?.split(',').filter(Boolean) || [];

async function main() {
  // All logs to stderr to not interfere with stdio protocol
  console.error('Starting AMB Relay MCP Server (stdio mode)...');
  console.error(`AMB Relays: ${AMB_RELAYS.join(', ')}`);
  if (AMB_EXTRA_RELAYS.length) console.error(`AMB Extra Relays: ${AMB_EXTRA_RELAYS.join(', ')}`);
  console.error(`Calendar Relays: ${CALENDAR_RELAYS.join(', ')}`);

  // Initialize AMB relay client
  const ambClient = new AMBRelayClient(AMB_RELAYS, { extraRelays: AMB_EXTRA_RELAYS });

  // Initialize calendar relay client
  const calendarClient = new AMBRelayClient(CALENDAR_RELAYS);

  // Create MCP server
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  // Register tools and resources
  registerTools(server, ambClient, calendarClient);
  registerResources(server, ambClient);

  // Load known authors from follow sets if configured
  if (AMB_AUTHOR_SETS.length > 0) {
    console.error(`Loading author sets from ${AMB_AUTHOR_SETS.length} naddr(s)...`);
    try {
      const directory = await loadAuthorSets(AMB_AUTHOR_SETS, AMB_RELAYS);
      setAuthorDirectory(directory);
      console.error(`Loaded ${directory.authors.length} authors from ${directory.sets.length} set(s)`);
    } catch (error) {
      console.error('Failed to load author sets:', error);
    }
  }

  // Load calendar authors from follow sets if configured
  if (CALENDAR_AUTHOR_SETS.length > 0) {
    console.error(`Loading calendar author sets from ${CALENDAR_AUTHOR_SETS.length} naddr(s)...`);
    try {
      const directory = await loadAuthorSets(CALENDAR_AUTHOR_SETS, CALENDAR_RELAYS);
      setCalendarAuthorDirectory(directory);
      console.error(`Loaded ${directory.authors.length} calendar authors from ${directory.sets.length} set(s)`);
    } catch (error) {
      console.error('Failed to load calendar author sets:', error);
    }
  }

  // Use stdio transport for cvmi serve compatibility
  const transport = new StdioServerTransport();

  // Connect and run
  await server.connect(transport);
  console.error('AMB MCP Server running (stdio)');

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.error('Shutting down...');
    ambClient.close();
    calendarClient.close();
    await server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.error('Shutting down...');
    ambClient.close();
    calendarClient.close();
    await server.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
