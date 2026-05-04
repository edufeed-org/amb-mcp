import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AMBRelayClient } from '../relay/client.js';
import { eventToAMBResource, toSimplifiedResource } from '../utils/transform.js';

/**
 * Register the get_resource tool
 */
export function registerGetTool(server: McpServer, client: AMBRelayClient): void {
  server.registerTool(
    'get_resource',
    {
      title: 'Get Educational Resource',
      description:
        'Retrieve a single educational resource by its identifier (d-tag) or event ID. Returns the full resource metadata including educational properties.',
      inputSchema: {
        identifier: z
          .string()
          .optional()
          .describe('Resource identifier (d-tag). Use this for stable lookups.'),
        author: z
          .string()
          .optional()
          .describe('Author pubkey (hex) to disambiguate if multiple resources share the same identifier'),
        eventId: z
          .string()
          .optional()
          .describe('Nostr event ID (hex) for direct lookup. Alternative to identifier.'),
        language: z
          .string()
          .optional()
          .default('de')
          .describe('Preferred language for labels (default: "de")'),
      },
    },
    async (params) => {
      if (!params.identifier && !params.eventId) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'Either identifier or eventId must be provided',
                resource: null,
              }),
            },
          ],
        };
      }

      let event;
      if (params.eventId) {
        event = await client.getById(params.eventId);
      } else if (params.identifier) {
        event = await client.getByDTag(params.identifier, params.author);
      }

      if (!event) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                resource: null,
                message: 'Resource not found',
              }),
            },
          ],
        };
      }

      const ambResource = eventToAMBResource(event);
      if (!ambResource) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                resource: null,
                message: 'Failed to parse resource',
                rawEvent: {
                  id: event.id,
                  pubkey: event.pubkey,
                  created_at: event.created_at,
                },
              }),
            },
          ],
        };
      }

      const lang = params.language || 'de';
      const simplified = toSimplifiedResource(ambResource, lang);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ resource: simplified }),
          },
        ],
      };
    }
  );
}
