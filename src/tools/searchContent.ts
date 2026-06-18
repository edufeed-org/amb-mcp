import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AMBRelayClient } from '../relay/client.js';
import { buildContentFilter, type ContentSearchParams } from '../relay/filters.js';
import { transformContentEvents } from '../content/transform.js';
import { parseSnippets, attachSnippets, SNIPPET_KIND } from '../content/snippet.js';
import type { SimplifiedContentResult } from '../content/types.js';

/**
 * Run a cross-content search: one relay-ranked REQ over the selected content
 * kinds (+ 21142), partition out the snippet events, transform the content
 * events in arrival order, and attach each matched passage to its parent.
 */
export async function runContentSearch(
  client: Pick<AMBRelayClient, 'queryEvents'>,
  params: ContentSearchParams & { language?: string }
): Promise<{ total: number; results: SimplifiedContentResult[] }> {
  const language = params.language || 'de';
  const filter = buildContentFilter(params);
  const events = await client.queryEvents(filter);

  const contentEvents = events.filter((e) => e.kind !== SNIPPET_KIND);
  const snippetEvents = events.filter((e) => e.kind === SNIPPET_KIND);

  const results = transformContentEvents(contentEvents, language);
  // transformContentEvents preserves order and skips invalid events. Rebuild
  // the parallel event list so result[i] ↔ event[i] for snippet attachment.
  const keptEvents = contentEvents.filter((e) => transformContentEvents([e], language).length > 0);
  const snippets = parseSnippets(snippetEvents);
  attachSnippets(results, keptEvents, snippets);

  return { total: results.length, results };
}

export function registerSearchContentTool(server: McpServer, client: AMBRelayClient): void {
  server.registerTool(
    'search_content',
    {
      title: 'Search Educational Content (resources, articles, wikis)',
      description:
        'Topic search across ALL content types on the relay in one ranked call: ' +
        'educational resources (kind 30142), long-form articles/blogs (30023), and ' +
        'wikis (30818). Results are interleaved and ranked by semantic passage match, ' +
        'and each carries the matched passage ("snippet") when available — use it to ' +
        'answer the user, not just list links. This is the default tool for ' +
        'natural-language questions like "what can I do about inattentive students?". ' +
        'For upcoming events on the same topic, follow up with search_calendar_events.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Free-text topic (e.g., "Unaufmerksamkeit im Seminar").'),
        types: z
          .array(z.enum(['resource', 'article', 'wiki']))
          .optional()
          .describe('Restrict to a subset of content types. Default: all three.'),
        language: z.string().optional().default('de').describe('Label language (default "de").'),
        since: z.number().optional().describe('Created at or after this Unix timestamp.'),
        until: z.number().optional().describe('Created at or before this Unix timestamp.'),
        authors: z.array(z.string()).optional().describe('Filter by author pubkeys (hex).'),
        limit: z
          .number()
          .min(1)
          .max(250)
          .optional()
          .default(20)
          .describe('Max results (1-250, default 20).'),
      },
    },
    async (params) => {
      const out = await runContentSearch(client, {
        query: params.query,
        types: params.types,
        language: params.language,
        since: params.since,
        until: params.until,
        authors: params.authors,
        limit: params.limit,
      });
      return { content: [{ type: 'text', text: JSON.stringify(out) }] };
    }
  );
}
