import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { AMBRelayClient } from './relay/client.js';
import { registerTools } from './tools/index.js';
import { registerResources } from './resources/index.js';
import { SERVER_NAME, SERVER_VERSION, SERVER_INSTRUCTIONS } from './server-info.js';

export interface SessionServer {
  server: McpServer;
  ambClient: AMBRelayClient;
  calendarClient: AMBRelayClient;
  dispose: () => void;
}

/**
 * Build a fresh MCP server with its own relay clients for a single session.
 *
 * Each call creates independent AMBRelayClient instances seeded from the given
 * defaults, so runtime relay changes (add_relay/remove_relay) made in one
 * session do not leak into any other session sharing the same process.
 */
export function buildSessionServer(
  ambRelays: string | string[],
  calendarRelays: string | string[],
  profile: import('./tools/index.js').ToolProfile = { read: true, extract: true, write: true },
): SessionServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  const ambClient = new AMBRelayClient(ambRelays);
  const calendarClient = new AMBRelayClient(calendarRelays);
  registerTools(server, ambClient, calendarClient, profile);
  registerResources(server, ambClient);

  return {
    server,
    ambClient,
    calendarClient,
    dispose: () => {
      ambClient.close();
      calendarClient.close();
    },
  };
}
