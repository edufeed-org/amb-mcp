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

// Concept-array shape — used by every SKOS-grounded form field.
// Each entry must carry an `id`; `prefLabel` is an optional hint.
const conceptArray = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      prefLabel: { type: 'string' }
    },
    required: ['id']
  }
} as const;

// Person-or-Organization shape — used for `creators` / `publisher`.
const personOrOrgArray = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      type: { type: 'string', enum: ['Person', 'Organization'] },
      id: { type: 'string' }
    },
    required: ['name']
  }
} as const;

const SUBMIT_TOOL = {
  name: 'submit_form_payload',
  description: 'Submit the AMB/EKW form-prefill payload extracted from the page.',
  input_schema: {
    type: 'object',
    properties: {
      payload: {
        type: 'object',
        description:
          'Form-field values to prefill. Use concept IDs from the provided vocabularies. Only fill fields with strong evidence in the page text. Omit fields you cannot fill — do not emit empty strings or empty arrays.',
        properties: {
          // AMB simple text fields
          name: { type: 'string' },
          description: { type: 'string' },
          inLanguage: { type: 'string' },
          image: { type: 'string' },
          license: { type: 'string' },
          datePublished: { type: 'string' },
          isAccessibleForFree: { type: 'boolean' },
          // AMB array fields
          keywords: { type: 'array', items: { type: 'string' } },
          creators: personOrOrgArray,
          publisher: personOrOrgArray,
          // AMB SKOS concept arrays
          learningResourceType: conceptArray,
          educationalLevels: conceptArray,
          about: conceptArray,
          // EKW extension fields
          ekwFachrichtung: conceptArray,
          gradeLevels: conceptArray,
          schoolTypes: conceptArray,
          didacticConcepts: conceptArray,
          methods: conceptArray,
          methodOther: { type: 'string' },
          bibleReferences: { type: 'array', items: { type: 'string' } }
        }
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
    'include a sibling key in `evidence` quoting the supporting page phrase.',
    '',
    'Always attempt to fill the simple text fields when the page provides them:',
    '`name` (resource title — derive from the page title, JSON-LD `name`/`headline`,',
    '  the largest heading, or the document\'s opening lines for a PDF),',
    '`description` (a 1–3 sentence summary — derive from JSON-LD `description`,',
    '  the page\'s meta description, or a synthesis of the opening paragraphs),',
    '`creators` (authors / publishers / responsible institutions — derive from',
    '  bylines, JSON-LD `author`/`publisher`, imprint/Impressum, or the document',
    '  cover page),',
    '`license` (a license URL — when the page or PDF mentions a Creative Commons',
    '  license, a CC-license badge, or text like "CC BY-SA 4.0", "CC BY-NC-SA 4.0",',
    '  "CC0", "lizenziert unter …", emit the canonical URL form.',
    '  RULE 1: if the source text already contains a `creativecommons.org/...` URL,',
    '  copy it VERBATIM — do not change the version or locale segment. e.g. if the',
    '  source has `https://creativecommons.org/licenses/by-nc-sa/3.0/de/`, emit',
    '  exactly that, NOT the 4.0 international URL.',
    '  RULE 2: otherwise build the URL from the modifiers and version stated in',
    '  the source. Map ALL six CC variants exactly — do not collapse NC/ND/SA:',
    '    CC BY {v}          → https://creativecommons.org/licenses/by/{v}/',
    '    CC BY-SA {v}       → https://creativecommons.org/licenses/by-sa/{v}/',
    '    CC BY-NC {v}       → https://creativecommons.org/licenses/by-nc/{v}/',
    '    CC BY-NC-SA {v}    → https://creativecommons.org/licenses/by-nc-sa/{v}/',
    '    CC BY-ND {v}       → https://creativecommons.org/licenses/by-nd/{v}/',
    '    CC BY-NC-ND {v}    → https://creativecommons.org/licenses/by-nc-nd/{v}/',
    '    CC0 1.0            → https://creativecommons.org/publicdomain/zero/1.0/',
    '  Use the version `{v}` actually written in the source (3.0, 4.0, …). Do',
    '  NOT default to 4.0 unless the source says 4.0 or omits the version.',
    '  Read the suffix carefully — "BY-NC-SA" is NOT "BY-SA", and "BY-NC" is NOT',
    '  "BY". Reproduce every modifier present in the source text. PDFs often',
    '  state the license on the cover page, in the imprint/Impressum, or',
    '  alongside copyright notices). For PDFs without OpenGraph tags, you must',
    '  still synthesize these fields from the readable text. Do not leave them',
    '  empty just because no OG metadata is present.'
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
