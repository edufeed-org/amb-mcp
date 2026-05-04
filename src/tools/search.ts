import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AMBRelayClient } from '../relay/client.js';
import { buildFilter, type SearchParams } from '../relay/filters.js';
import { eventsToAMBResources, toSimplifiedResource } from '../utils/transform.js';

/**
 * Register the search_resources tool
 */
export function registerSearchTool(server: McpServer, client: AMBRelayClient): void {
  server.registerTool(
    'search_resources',
    {
      title: 'Search Educational Resources',
      description:
        'Search for educational resources (learning materials, courses, videos, etc.) using full-text search and metadata filters. Returns resources matching the query from the AMB relay.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Free-text search query (e.g., "mathematik", "machine learning")'),
        publisherName: z
          .string()
          .optional()
          .describe('Filter by publisher name (e.g., "e-teaching.org")'),
        creatorName: z
          .string()
          .optional()
          .describe('Filter by creator/author name'),
        subjectLabel: z
          .string()
          .optional()
          .describe('Filter by subject/topic label (e.g., "Mathematik", "Physik")'),
        resourceTypeLabel: z
          .string()
          .optional()
          .describe('Filter by resource type label (e.g., "Video", "Kurs", "Arbeitsblatt")'),
        educationalLevelLabel: z
          .string()
          .optional()
          .describe('Filter by educational level (e.g., "Sekundarstufe I", "Hochschule")'),
        language: z
          .string()
          .optional()
          .default('de')
          .describe('Language for label filters (default: "de")'),
        since: z
          .number()
          .optional()
          .describe('Return resources created at or after this Unix timestamp'),
        until: z
          .number()
          .optional()
          .describe('Return resources created at or before this Unix timestamp'),
        authors: z
          .array(z.string())
          .optional()
          .describe('Filter by author pubkeys (hex format)'),
        limit: z
          .number()
          .min(1)
          .max(250)
          .optional()
          .default(20)
          .describe('Maximum number of results (1-250, default: 20)'),
      },
    },
    async (params) => {
      const searchParams: SearchParams = {
        query: params.query,
        publisherName: params.publisherName,
        creatorName: params.creatorName,
        subjectLabel: params.subjectLabel,
        resourceTypeLabel: params.resourceTypeLabel,
        educationalLevelLabel: params.educationalLevelLabel,
        language: params.language,
        since: params.since,
        until: params.until,
        authors: params.authors,
        limit: params.limit,
      };

      const { filter, search } = buildFilter(searchParams);

      // Execute query
      const events = search
        ? await client.search(search, filter)
        : await client.query(filter);

      // Transform to AMB resources
      const resources = eventsToAMBResources(events);
      const lang = params.language || 'de';
      const simplified = resources.map(r => toSimplifiedResource(r, lang));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              total: simplified.length,
              resources: simplified,
            }),
          },
        ],
      };
    }
  );
}
