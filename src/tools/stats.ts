import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AMBRelayClient } from '../relay/client.js';

/**
 * Register the relay_stats tool
 */
export function registerStatsTool(
  server: McpServer,
  client: AMBRelayClient
): void {
  server.registerTool(
    'relay_stats',
    {
      title: 'Relay Statistics',
      description:
        'Get information about all connected AMB relays, including supported NIPs, relay name, and description.',
      inputSchema: {},
    },
    async () => {
      try {
        const relayInfoMap = await client.getRelayInfo();
        const relays = client.getRelays();

        const relayStats = relays.map((url) => {
          const info = relayInfoMap.get(url);
          if (info) {
            return {
              url,
              name: info.name,
              description: info.description,
              pubkey: info.pubkey,
              contact: info.contact,
              supportedNips: info.supported_nips,
              software: info.software,
              version: info.version,
            };
          }
          return {
            url,
            error: 'Failed to fetch relay info',
          };
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  relays: relayStats,
                  count: relays.length,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'Failed to fetch relay info',
                message: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    }
  );
}
