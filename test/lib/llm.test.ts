import { describe, it, expect, vi } from 'vitest';
import { llmEnrich, type AnthropicLike } from '../../src/lib/llm.js';
import type { VocabSnapshot } from '../../src/lib/vocabs.js';

/**
 * Build a stub Anthropic client that returns a canned tool_use response.
 * Captures the arguments it was called with so tests can assert on prompt
 * shape (cache_control, vocab inclusion, etc.).
 */
function stubClient(toolInput: unknown): {
  client: AnthropicLike;
  calls: Parameters<AnthropicLike['messages']['create']>;
} {
  const calls: Parameters<AnthropicLike['messages']['create']> = [] as unknown as Parameters<
    AnthropicLike['messages']['create']
  >;
  const client: AnthropicLike = {
    messages: {
      create: vi.fn(async (params: unknown) => {
        (calls as unknown[]).push(params);
        return {
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_test',
              name: 'submit_form_payload',
              input: toolInput
            }
          ]
        };
      })
    }
  };
  return { client, calls };
}

const lrtVocab: VocabSnapshot = {
  id: 'https://w3id.org/kim/hcrt/scheme',
  title: 'Hochschulcampus Ressourcentypen',
  concepts: [
    { id: 'https://w3id.org/kim/hcrt/text', prefLabel: 'Text' },
    { id: 'https://w3id.org/kim/hcrt/video', prefLabel: 'Video' }
  ]
};

describe('llmEnrich', () => {
  it('returns the parsed tool_use payload + evidence', async () => {
    const toolInput = {
      payload: {
        name: 'A lesson',
        learningResourceType: [{ id: 'https://w3id.org/kim/hcrt/text' }]
      },
      evidence: {
        name: 'A lesson on the gospel',
        learningResourceType: 'reading text passages'
      }
    };
    const { client } = stubClient(toolInput);

    const result = await llmEnrich({
      client,
      variant: 'amb',
      page: {
        title: 'A lesson',
        description: 'short desc',
        ogTags: {},
        readableText: 'A lesson on the gospel with reading text passages.'
      },
      vocabs: { learningResourceType: lrtVocab }
    });

    expect(result.payload.name).toBe('A lesson');
    expect(result.evidence.name).toBe('A lesson on the gospel');
  });

  it('forces tool_choice to submit_form_payload', async () => {
    const { client, calls } = stubClient({ payload: {}, evidence: {} });
    await llmEnrich({
      client,
      variant: 'amb',
      page: { ogTags: {}, readableText: 'x' },
      vocabs: {}
    });
    const params = calls[0] as Record<string, unknown>;
    expect(params.tool_choice).toMatchObject({ type: 'tool', name: 'submit_form_payload' });
  });

  it('marks the vocab block as cache_control: ephemeral for prompt caching', async () => {
    const { client, calls } = stubClient({ payload: {}, evidence: {} });
    await llmEnrich({
      client,
      variant: 'amb',
      page: { ogTags: {}, readableText: 'x' },
      vocabs: { learningResourceType: lrtVocab }
    });
    const params = calls[0] as { messages: Array<{ content: Array<Record<string, unknown>> }> };
    const userBlocks = params.messages[0].content;
    // At least one block carries cache_control.ephemeral — that's the vocab block
    const hasCache = userBlocks.some(
      (b) => (b.cache_control as Record<string, unknown> | undefined)?.type === 'ephemeral'
    );
    expect(hasCache).toBe(true);
  });

  it('includes the variant in the system prompt', async () => {
    const { client, calls } = stubClient({ payload: {}, evidence: {} });
    await llmEnrich({
      client,
      variant: 'ekw',
      page: { ogTags: {}, readableText: 'x' },
      vocabs: {}
    });
    const params = calls[0] as { system: string | Array<{ text?: string }> };
    const systemText = typeof params.system === 'string'
      ? params.system
      : params.system.map((s) => s.text ?? '').join(' ');
    expect(systemText).toMatch(/ekw/i);
  });

  it('declares the AMB + EKW form fields as explicit payload properties', async () => {
    // Without per-field properties Anthropic models sometimes serialize the
    // entire `payload` arg as a JSON-encoded string, and those strings can
    // contain unescaped typographic quotes that break JSON.parse downstream
    // (observed on real magazine PDFs with German „…" quotes). A concrete
    // schema makes the model emit a structured object instead.
    const { client, calls } = stubClient({ payload: {}, evidence: {} });
    await llmEnrich({
      client,
      variant: 'ekw',
      page: { ogTags: {}, readableText: 'x' },
      vocabs: {}
    });
    const params = calls[0] as {
      tools: Array<{
        name: string;
        input_schema: {
          properties: {
            payload: {
              type?: string;
              properties?: Record<string, { type?: string }>;
            };
          };
        };
      }>;
    };
    const tool = params.tools.find((t) => t.name === 'submit_form_payload');
    expect(tool).toBeDefined();
    const payloadSchema = tool!.input_schema.properties.payload;
    expect(payloadSchema.type).toBe('object');
    const props = payloadSchema.properties ?? {};

    // AMB simple text fields
    expect(props.name?.type).toBe('string');
    expect(props.description?.type).toBe('string');
    expect(props.inLanguage?.type).toBe('string');
    expect(props.image?.type).toBe('string');
    expect(props.license?.type).toBe('string');
    // AMB array fields
    expect(props.keywords?.type).toBe('array');
    expect(props.creators?.type).toBe('array');
    expect(props.publisher?.type).toBe('array');
    // AMB SKOS concept arrays
    expect(props.learningResourceType?.type).toBe('array');
    expect(props.educationalLevels?.type).toBe('array');
    // EKW extension fields
    expect(props.ekwFachrichtung?.type).toBe('array');
    expect(props.gradeLevels?.type).toBe('array');
    expect(props.schoolTypes?.type).toBe('array');
    expect(props.didacticConcepts?.type).toBe('array');
    expect(props.methods?.type).toBe('array');
    expect(props.methodOther?.type).toBe('string');
    expect(props.bibleReferences?.type).toBe('array');
  });

  it('instructs the model that evidence must be a verbatim substring of the page in the source language', async () => {
    // Real-world failure: the model produced English meta-commentary like
    // "Content explicitly addresses religious and theological concepts: ..." for a
    // German page, instead of quoting actual page text. Tighten the prompt so
    // evidence is a verbatim substring AND in the page's language.
    const { client, calls } = stubClient({ payload: {}, evidence: {} });
    await llmEnrich({
      client,
      variant: 'amb',
      page: { ogTags: {}, readableText: 'x' },
      vocabs: {}
    });
    const params = calls[0] as { system: string | Array<{ text?: string }>; tools: Array<{ input_schema: { properties: { evidence: { description?: string } } } }> };
    const systemText = typeof params.system === 'string'
      ? params.system
      : params.system.map((s) => s.text ?? '').join(' ');
    expect(systemText).toMatch(/verbatim/i);
    expect(systemText).toMatch(/substring|exact phrase|exactly as it appears/i);
    expect(systemText).toMatch(/same language|source language|language of the page/i);

    // The tool schema description should reinforce the same constraint so the
    // model's structured-output discipline picks it up too.
    const evidenceDesc = params.tools[0].input_schema.properties.evidence.description ?? '';
    expect(evidenceDesc).toMatch(/verbatim/i);
  });

  it('throws when the model returns no tool_use block', async () => {
    const client: AnthropicLike = {
      messages: {
        create: vi.fn(async () => ({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'sorry' }]
        }))
      }
    };
    await expect(
      llmEnrich({
        client,
        variant: 'amb',
        page: { ogTags: {}, readableText: 'x' },
        vocabs: {}
      })
    ).rejects.toThrow();
  });
});
