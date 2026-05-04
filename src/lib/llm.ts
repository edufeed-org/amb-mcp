import type { Variant } from './schema.js';
import type { VocabSnapshot } from './vocabs.js';

/**
 * Anthropic SDK wrapper for the URL → form-prefill pipeline.
 *
 * The real Anthropic client is dependency-injected (`AnthropicLike`) so
 * tests never need network. Production code constructs a real
 * `new Anthropic({ apiKey })` and passes it in.
 *
 * Structured output is enforced via tool_use: we declare a single
 * `submit_form_payload` tool and force the model to call it. The tool
 * input *is* the result.
 *
 * Vocab snapshots are placed in their own user-content block with
 * `cache_control: { type: 'ephemeral' }` so Anthropic's prompt cache can
 * reuse them across pages — vocabs are stable, page text is not.
 */

export const DEFAULT_MODEL = 'claude-sonnet-4-6';

/** Minimal subset of the Anthropic SDK we depend on. */
export interface AnthropicLike {
  messages: {
    create: (params: unknown) => Promise<{
      stop_reason?: string;
      content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: unknown }
      >;
    }>;
  };
}

export interface LlmPageInput {
  title?: string;
  description?: string;
  ogTags: Record<string, string>;
  jsonLdPartial?: unknown[];
  readableText: string;
}

export interface LlmEnrichInput {
  client: AnthropicLike;
  variant: Variant;
  page: LlmPageInput;
  /** Map of form-field name → vocab snapshot. */
  vocabs: Record<string, VocabSnapshot>;
  model?: string;
  maxTokens?: number;
}

export interface LlmEnrichResult {
  payload: Record<string, unknown>;
  evidence: Record<string, string>;
}

const SUBMIT_TOOL = {
  name: 'submit_form_payload',
  description: 'Submit the AMB/EKW form-prefill payload extracted from the page.',
  input_schema: {
    type: 'object',
    properties: {
      payload: {
        type: 'object',
        description:
          'Form-field values to prefill. Use concept IDs from the provided vocabularies. Only fill fields with strong evidence in the page text.'
      },
      evidence: {
        type: 'object',
        description:
          'For each filled field, a quoted phrase from the page that justifies the value. Keys must match payload keys.'
      }
    },
    required: ['payload', 'evidence']
  }
} as const;

function systemPrompt(variant: Variant): string {
  return [
    `You are a metadata extractor. Variant: ${variant}.`,
    'Read the page content and the provided SKOS vocabularies, then call the',
    'submit_form_payload tool exactly once. For each form field you fill,',
    'pick concept IDs verbatim from the vocabs. Only fill a field if the page',
    'gives strong evidence; leave others empty. For every filled field,',
    'include a sibling key in `evidence` quoting the supporting page phrase.'
  ].join(' ');
}

export async function llmEnrich(input: LlmEnrichInput): Promise<LlmEnrichResult> {
  const { client, variant, page, vocabs, model = DEFAULT_MODEL, maxTokens = 2048 } = input;

  const userContent: Array<Record<string, unknown>> = [];

  // Vocab snapshots — cached together because they are stable.
  if (Object.keys(vocabs).length > 0) {
    userContent.push({
      type: 'text',
      text:
        'SKOS vocabularies (pick concept IDs from these):\n' +
        JSON.stringify(vocabs, null, 2),
      cache_control: { type: 'ephemeral' }
    });
  } else {
    // Even with no vocabs we still emit a cached marker so prompt-cache
    // accounting is consistent. Cheap, avoids special-casing downstream.
    userContent.push({
      type: 'text',
      text: 'SKOS vocabularies: (none provided)',
      cache_control: { type: 'ephemeral' }
    });
  }

  // Page payload — varies per call, not cached.
  userContent.push({
    type: 'text',
    text:
      'Page to extract from:\n' +
      JSON.stringify(
        {
          title: page.title,
          description: page.description,
          ogTags: page.ogTags,
          jsonLdPartial: page.jsonLdPartial,
          readableText: page.readableText
        },
        null,
        2
      )
  });

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt(variant),
    tools: [SUBMIT_TOOL],
    tool_choice: { type: 'tool', name: 'submit_form_payload' },
    messages: [{ role: 'user', content: userContent }]
  });

  const toolUse = response.content.find(
    (b): b is { type: 'tool_use'; id: string; name: string; input: unknown } =>
      b.type === 'tool_use' && b.name === 'submit_form_payload'
  );
  if (!toolUse) {
    throw new Error('LLM did not return a submit_form_payload tool call');
  }

  const out = toolUse.input as { payload?: unknown; evidence?: unknown };
  return {
    payload: (out.payload as Record<string, unknown>) ?? {},
    evidence: (out.evidence as Record<string, string>) ?? {}
  };
}
