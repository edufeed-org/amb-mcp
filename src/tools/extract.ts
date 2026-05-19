import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Anthropic from '@anthropic-ai/sdk';
import { extractMetadata } from '../lib/extractMetadata.js';
import type { AnthropicLike } from '../lib/llm.js';
import { extractPdfText } from '../lib/pdfExtractor.js';
import { VARIANTS } from '../lib/schema.js';

/**
 * `extract_metadata` MCP tool.
 *
 * Thin wrapper over `extractMetadata()` from src/lib/. Constructs the
 * Anthropic client from `ANTHROPIC_API_KEY` if present; absent key
 * degrades gracefully to the OpenGraph-only branch.
 *
 * `skosSchemes` defaults to `SKOS_SCHEMES` env (JSON map of
 * fieldName → scheme URI) so a stdio user gets a sensible default
 * without having to spell out vocabs on every call.
 */

function defaultSchemesFromEnv(): Record<string, string> {
  const raw = process.env.SKOS_SCHEMES;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, string>;
  } catch {
    // Ignore malformed env — caller can still pass schemes explicitly.
  }
  return {};
}

export function registerExtractTool(server: McpServer): void {
  server.registerTool(
    'extract_metadata',
    {
      title: 'Extract AMB/EKW form-prefill metadata from a URL',
      description:
        'Fetch a public web page and produce a complete AMB/EKW form-prefill payload. ' +
        'Returns OpenGraph fallback by default; with ANTHROPIC_API_KEY set, an LLM ' +
        'grounded in the configured SKOS vocabularies fills SKOS-typed fields with ' +
        'concept IDs and per-field evidence quotes.',
      inputSchema: {
        url: z.string().url().describe('Public http(s) URL of the page to extract.'),
        variant: z
          .enum(VARIANTS)
          .optional()
          .default('amb')
          .describe(
            'Form variant. EKW adds religious-education fields (Klassenstufen, Schulart, …); ' +
              'konfi adds Konfi-Arbeit fields (Zielgruppen, Lernformat, Themen, …).'
          ),
        skosSchemes: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'Map of form-field name → SKOS scheme URI. Defaults to the SKOS_SCHEMES env var if absent.'
          )
      }
    },
    async (params) => {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      const llmClient = apiKey
        ? (new Anthropic({ apiKey }) as unknown as AnthropicLike)
        : undefined;

      // VOCAB_RELAYS is the fallback relay list for naddr1 SKOS schemes
      // whose hint relays are missing or unreachable (e.g. the
      // educational-level naddr ships with no hints). Falls back to
      // AMB_RELAYS so a single env var typically suffices.
      const vocabRelays = (process.env.VOCAB_RELAYS ?? process.env.AMB_RELAYS)
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      const result = await extractMetadata({
        url: params.url,
        variant: params.variant ?? 'amb',
        skosSchemes: params.skosSchemes ?? defaultSchemesFromEnv(),
        llmClient,
        pdfExtract: extractPdfText,
        ...(vocabRelays && vocabRelays.length > 0 ? { vocabRelays } : {}),
        ...(process.env.ANTHROPIC_MODEL ? { llmModel: process.env.ANTHROPIC_MODEL } : {})
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }]
      };
    }
  );
}
