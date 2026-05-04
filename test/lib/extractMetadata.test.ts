import { describe, it, expect, beforeEach, vi } from 'vitest';
import { extractMetadata } from '../../src/lib/extractMetadata.js';
import type { AnthropicLike } from '../../src/lib/llm.js';
import { vocabularyCache } from '../../src/skos/cache.js';
import type { ParsedVocabulary } from '../../src/skos/types.js';

/**
 * Build a fake fetch returning a fixed HTML body.
 */
const fakeHtml = (html: string) =>
  async (_url: string | URL): Promise<Response> =>
    new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

/** A minimal Anthropic stub returning a canned tool_use payload. */
function stubLlm(payload: Record<string, unknown>, evidence: Record<string, string>): AnthropicLike {
  return {
    messages: {
      create: vi.fn(async () => ({
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_test',
            name: 'submit_form_payload',
            input: { payload, evidence }
          }
        ]
      }))
    }
  };
}

const LRT_URI = 'https://w3id.org/kim/hcrt/scheme';
const lrtVocab: ParsedVocabulary = {
  scheme: {
    id: LRT_URI,
    type: 'ConceptScheme',
    title: { de: 'Lernressourcentyp' },
    hasTopConcept: []
  },
  concepts: new Map([
    [
      'https://w3id.org/kim/hcrt/text',
      {
        id: 'https://w3id.org/kim/hcrt/text',
        type: 'Concept',
        prefLabel: { de: 'Text' }
      }
    ],
    [
      'https://w3id.org/kim/hcrt/video',
      {
        id: 'https://w3id.org/kim/hcrt/video',
        type: 'Concept',
        prefLabel: { de: 'Video' }
      }
    ]
  ])
};

beforeEach(() => {
  vocabularyCache.clear();
  vocabularyCache.set(LRT_URI, lrtVocab);
});

describe('extractMetadata — AMB short-circuit', () => {
  it('returns source: amb-jsonld and skips LLM when AMB JSON-LD is present', async () => {
    const ld = JSON.stringify({
      '@context': ['https://schema.org/', 'https://w3id.org/kim/amb/context.jsonld'],
      '@type': ['LearningResource'],
      id: 'urn:uuid:abc',
      name: 'A lesson'
    });
    const html = `<html><head><script type="application/ld+json">${ld}</script></head><body><p>x</p></body></html>`;
    const llmClient = stubLlm({}, {});

    const result = await extractMetadata({
      url: 'https://example.com/lesson',
      variant: 'amb',
      fetchFn: fakeHtml(html),
      llmClient
    });

    expect(result.source).toBe('amb-jsonld');
    expect(result.payload).toMatchObject({ name: 'A lesson' });
    expect(result.baseline.amb).toBeDefined();
    expect(llmClient.messages.create).not.toHaveBeenCalled();
  });
});

describe('extractMetadata — opengraph-only fallback', () => {
  it('returns OG fields and source: opengraph-only when no LLM client provided', async () => {
    const html = `
      <html><head>
        <meta property="og:title" content="OG Title">
        <meta property="og:description" content="OG Desc">
        <meta property="og:image" content="https://example.com/img.png">
        <meta property="og:locale" content="de_DE">
      </head><body><p>x</p></body></html>`;

    const result = await extractMetadata({
      url: 'https://example.com/',
      variant: 'amb',
      fetchFn: fakeHtml(html)
      // no llmClient
    });

    expect(result.source).toBe('opengraph-only');
    expect(result.payload).toMatchObject({
      name: 'OG Title',
      description: 'OG Desc',
      image: 'https://example.com/img.png',
      inLanguage: 'de'
    });
    expect(result.baseline.og?.['og:title']).toBe('OG Title');
    expect(result.evidence).toEqual({});
  });
});

describe('extractMetadata — LLM-enriched path', () => {
  it('calls the LLM with the requested vocabs and returns its payload', async () => {
    const html = `<html><head><title>Reading</title></head><body><p>A reading lesson.</p></body></html>`;

    const llmClient = stubLlm(
      {
        name: 'Reading lesson',
        learningResourceType: [{ id: 'https://w3id.org/kim/hcrt/text' }]
      },
      { name: 'Reading', learningResourceType: 'A reading lesson' }
    );

    const result = await extractMetadata({
      url: 'https://example.com/r',
      variant: 'amb',
      fetchFn: fakeHtml(html),
      llmClient,
      skosSchemes: { learningResourceType: LRT_URI }
    });

    expect(result.source).toBe('llm-enriched');
    expect(result.payload.name).toBe('Reading lesson');
    expect(result.payload.learningResourceType).toEqual([
      { id: 'https://w3id.org/kim/hcrt/text' }
    ]);
    expect(llmClient.messages.create).toHaveBeenCalledOnce();
  });

  it('drops concept IDs that are not in the loaded vocab', async () => {
    const html = `<html><head><title>x</title></head><body><p>y</p></body></html>`;

    const llmClient = stubLlm(
      {
        name: 'x',
        learningResourceType: [
          { id: 'https://w3id.org/kim/hcrt/text' },
          { id: 'https://w3id.org/kim/hcrt/INVALID' }
        ]
      },
      { name: 'x', learningResourceType: 'y' }
    );

    const result = await extractMetadata({
      url: 'https://example.com/r',
      variant: 'amb',
      fetchFn: fakeHtml(html),
      llmClient,
      skosSchemes: { learningResourceType: LRT_URI }
    });

    expect(result.payload.learningResourceType).toEqual([
      { id: 'https://w3id.org/kim/hcrt/text' }
    ]);
  });

  it('strips evidence entries whose payload field was dropped', async () => {
    const html = `<html><head><title>x</title></head><body><p>y</p></body></html>`;

    const llmClient = stubLlm(
      { name: 'x' }, // no learningResourceType
      { name: 'name evidence', learningResourceType: 'orphan evidence' }
    );

    const result = await extractMetadata({
      url: 'https://example.com/r',
      variant: 'amb',
      fetchFn: fakeHtml(html),
      llmClient,
      skosSchemes: {}
    });

    expect(result.evidence.name).toBe('name evidence');
    expect(result.evidence.learningResourceType).toBeUndefined();
  });

  it('rejects EKW-only fields under variant=amb', async () => {
    const html = `<html><head><title>x</title></head><body><p>y</p></body></html>`;
    const llmClient = stubLlm(
      { name: 'x', bibleReferences: ['Mt 5,1-12'] },
      { name: 'name', bibleReferences: 'matthew' }
    );

    const result = await extractMetadata({
      url: 'https://example.com/r',
      variant: 'amb',
      fetchFn: fakeHtml(html),
      llmClient,
      skosSchemes: {}
    });

    expect(result.payload.bibleReferences).toBeUndefined();
    expect(result.evidence.bibleReferences).toBeUndefined();
  });

  it('keeps EKW-only fields under variant=ekw', async () => {
    const html = `<html><head><title>x</title></head><body><p>y</p></body></html>`;
    const llmClient = stubLlm(
      { name: 'x', bibleReferences: ['Mt 5,1-12'] },
      { name: 'name', bibleReferences: 'matthew' }
    );

    const result = await extractMetadata({
      url: 'https://example.com/r',
      variant: 'ekw',
      fetchFn: fakeHtml(html),
      llmClient,
      skosSchemes: {}
    });

    expect(result.payload.bibleReferences).toEqual(['Mt 5,1-12']);
  });
});

describe('extractMetadata — output shape', () => {
  it('passes extractMetadataResult zod validation in all three modes', async () => {
    const { extractMetadataResult } = await import('../../src/lib/schema.js');

    const ambHtml =
      `<html><head><script type="application/ld+json">${JSON.stringify({
        '@type': ['LearningResource'],
        name: 'L'
      })}</script></head><body><p>x</p></body></html>`;
    const ogHtml = `<html><head><meta property="og:title" content="t"></head><body><p>x</p></body></html>`;
    const llmHtml = `<html><head><title>t</title></head><body><p>x</p></body></html>`;

    const ambRes = await extractMetadata({
      url: 'https://example.com/a',
      variant: 'amb',
      fetchFn: fakeHtml(ambHtml)
    });
    const ogRes = await extractMetadata({
      url: 'https://example.com/o',
      variant: 'amb',
      fetchFn: fakeHtml(ogHtml)
    });
    const llmRes = await extractMetadata({
      url: 'https://example.com/l',
      variant: 'amb',
      fetchFn: fakeHtml(llmHtml),
      llmClient: stubLlm({ name: 't' }, { name: 'evidence' }),
      skosSchemes: {}
    });

    expect(extractMetadataResult.safeParse(ambRes).success).toBe(true);
    expect(extractMetadataResult.safeParse(ogRes).success).toBe(true);
    expect(extractMetadataResult.safeParse(llmRes).success).toBe(true);
  });
});
