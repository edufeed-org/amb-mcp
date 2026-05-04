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
