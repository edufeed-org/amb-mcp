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

describe('extractMetadata — LLM output normalization', () => {
  // Anthropic models, when handed a loose tool input_schema, sometimes
  // serialize concept IDs as bare strings ("https://…/text") rather than
  // {id: "…"} objects, and sometimes return evidence as a JSON-encoded
  // string instead of a flat object. extractMetadata must accept both
  // shapes so the downstream form prefill survives those drifts.

  it('coerces bare-string concept IDs into {id} objects so vocab filter keeps them', async () => {
    const html = `<html><head><title>x</title></head><body><p>y</p></body></html>`;
    const llmClient = stubLlm(
      // bare-string concept IDs (as observed from real Anthropic output)
      { name: 'x', learningResourceType: ['https://w3id.org/kim/hcrt/text'] },
      { name: 'n', learningResourceType: 'y' }
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
    expect(result.evidence.learningResourceType).toBe('y');
  });

  it('parses payload when the LLM returns it as a JSON-encoded string', async () => {
    // Mirror of the evidence-as-string drift: Anthropic models sometimes
    // serialize the entire `payload` tool argument as a JSON string. Without
    // normalization, downstream `Object.entries(payload)` iterates the chars
    // of the string, applyVariantSchema strips everything, payload comes out
    // empty.
    const html = `<html><head><title>x</title></head><body><p>y</p></body></html>`;
    const llmClient = stubLlm(
      // payload as a JSON string
      JSON.stringify({
        name: 'x',
        learningResourceType: ['https://w3id.org/kim/hcrt/text']
      }) as unknown as Record<string, unknown>,
      { name: 'evidence-for-name', learningResourceType: 'evidence-for-lrt' }
    );

    const result = await extractMetadata({
      url: 'https://example.com/r',
      variant: 'amb',
      fetchFn: fakeHtml(html),
      llmClient,
      skosSchemes: { learningResourceType: LRT_URI }
    });

    expect(result.payload.name).toBe('x');
    expect(result.payload.learningResourceType).toEqual([
      { id: 'https://w3id.org/kim/hcrt/text' }
    ]);
    expect(result.evidence.name).toBe('evidence-for-name');
  });

  it('repairs malformed JSON-encoded payloads with unescaped typographic quotes', async () => {
    // Captured live from a German-language magazine PDF (rpi-konfi 1/2025):
    // Anthropic returned the payload as a JSON-encoded string whose body
    // contained a stray unescaped ASCII `"` after the German low-9 opener
    // (`„gegen Einsamkeit"`) — the closing curly-quote `"` was a straight
    // quote, prematurely terminating the JSON string. Strict JSON.parse
    // rejects this; a repair fallback must keep the payload intact.
    const html = `<html><head><title>x</title></head><body><p>y</p></body></html>`;
    const broken =
      '{\n  "name": "DU BIST NICHT ALLEIN ALLEIN – Ein Baustein „gegen Einsamkeit" im Rahmen der Kampagne",\n  "description": "Ein Baustein für die Konfi-Arbeit."\n}';
    const llmClient = stubLlm(
      broken as unknown as Record<string, unknown>,
      { name: 'evidence-for-name' }
    );

    const result = await extractMetadata({
      url: 'https://example.com/r',
      variant: 'amb',
      fetchFn: fakeHtml(html),
      llmClient,
      skosSchemes: {}
    });

    expect(result.payload.name).toBe(
      'DU BIST NICHT ALLEIN ALLEIN – Ein Baustein „gegen Einsamkeit" im Rahmen der Kampagne'
    );
    expect(result.payload.description).toBe('Ein Baustein für die Konfi-Arbeit.');
    expect(result.evidence.name).toBe('evidence-for-name');
  });

  it('parses evidence when the LLM returns it as a JSON-encoded string', async () => {
    const html = `<html><head><title>x</title></head><body><p>y</p></body></html>`;
    const llmClient = stubLlm(
      { name: 'x' },
      // evidence as a JSON string (as observed from real Anthropic output)
      JSON.stringify({ name: 'evidence-for-name' }) as unknown as Record<string, string>
    );

    const result = await extractMetadata({
      url: 'https://example.com/r',
      variant: 'amb',
      fetchFn: fakeHtml(html),
      llmClient,
      skosSchemes: {}
    });

    expect(result.evidence.name).toBe('evidence-for-name');
  });
});

describe('extractMetadata — production LLM-output shape', () => {
  // Replays the exact shape captured live from /api/enrich against the
  // RPI Impulse PDF: bare-string concept IDs (HTTP-form for HCRT/EDU_LEVEL,
  // NIP-VOCAB `kind:pubkey:dtag` form for the NIP-VOCAB schemes), plus
  // evidence as a JSON-encoded string. The endpoint logged
  //   result.source= llm-enriched payload keys= [] evidence keys= []
  // so this test must currently fail.

  const HCRT_URI = 'https://w3id.org/kim/hcrt/scheme';
  const KLASSEN_URI = 'naddr-klassenstufen';
  const SCHULART_URI = 'naddr-schulart';

  const NIP_VOCAB_PUBKEY =
    'd2689e2f41dabfba953da26655a94ce2aa4e029c383ee921c6a4deafab99a612';

  const hcrtVocab: ParsedVocabulary = {
    scheme: { id: HCRT_URI, type: 'ConceptScheme', title: { de: 'HCRT' }, hasTopConcept: [] },
    concepts: new Map([
      [
        'https://w3id.org/kim/hcrt/worksheet',
        { id: 'https://w3id.org/kim/hcrt/worksheet', type: 'Concept', prefLabel: { de: 'Arbeitsblatt' } }
      ]
    ])
  };

  const klassenVocab: ParsedVocabulary = {
    scheme: { id: `39737:${NIP_VOCAB_PUBKEY}:klassenstufen`, type: 'ConceptScheme', title: { de: 'Klassenstufen' }, hasTopConcept: [] },
    concepts: new Map([
      [
        `39738:${NIP_VOCAB_PUBKEY}:1`,
        { id: `39738:${NIP_VOCAB_PUBKEY}:1`, type: 'Concept', prefLabel: { de: 'Jahrgang 1' } }
      ],
      [
        `39738:${NIP_VOCAB_PUBKEY}:2`,
        { id: `39738:${NIP_VOCAB_PUBKEY}:2`, type: 'Concept', prefLabel: { de: 'Jahrgang 2' } }
      ]
    ])
  };

  const schulartVocab: ParsedVocabulary = {
    scheme: { id: `39737:${NIP_VOCAB_PUBKEY}:schulart`, type: 'ConceptScheme', title: { de: 'Schulart' }, hasTopConcept: [] },
    concepts: new Map([
      [
        `39738:${NIP_VOCAB_PUBKEY}:grundschule`,
        { id: `39738:${NIP_VOCAB_PUBKEY}:grundschule`, type: 'Concept', prefLabel: { de: 'Grundschule' } }
      ]
    ])
  };

  it('keeps both HTTP-form and NIP-VOCAB-form concept IDs after filter+schema', async () => {
    vocabularyCache.set(HCRT_URI, hcrtVocab);
    vocabularyCache.set(KLASSEN_URI, klassenVocab);
    vocabularyCache.set(SCHULART_URI, schulartVocab);

    const html = `<html><head><title>x</title></head><body><p>y</p></body></html>`;

    // Bare-string IDs and JSON-encoded evidence — the production drift.
    const llmClient = stubLlm(
      {
        learningResourceType: ['https://w3id.org/kim/hcrt/worksheet'],
        gradeLevels: [`39738:${NIP_VOCAB_PUBKEY}:1`, `39738:${NIP_VOCAB_PUBKEY}:2`],
        schoolTypes: [`39738:${NIP_VOCAB_PUBKEY}:grundschule`]
      },
      JSON.stringify({
        learningResourceType: 'M4 Rollenspiel',
        gradeLevels: 'Jahrgang 1 und 2',
        schoolTypes: 'GRUNDSCHULE'
      }) as unknown as Record<string, string>
    );

    const result = await extractMetadata({
      url: 'https://example.com/r',
      variant: 'ekw',
      fetchFn: fakeHtml(html),
      llmClient,
      skosSchemes: {
        learningResourceType: HCRT_URI,
        gradeLevels: KLASSEN_URI,
        schoolTypes: SCHULART_URI
      }
    });

    expect(result.source).toBe('llm-enriched');
    expect(result.payload.learningResourceType).toEqual([
      { id: 'https://w3id.org/kim/hcrt/worksheet' }
    ]);
    expect(result.payload.gradeLevels).toEqual([
      { id: `39738:${NIP_VOCAB_PUBKEY}:1` },
      { id: `39738:${NIP_VOCAB_PUBKEY}:2` }
    ]);
    expect(result.payload.schoolTypes).toEqual([
      { id: `39738:${NIP_VOCAB_PUBKEY}:grundschule` }
    ]);
    expect(result.evidence.learningResourceType).toBe('M4 Rollenspiel');
    expect(result.evidence.gradeLevels).toBe('Jahrgang 1 und 2');
    expect(result.evidence.schoolTypes).toBe('GRUNDSCHULE');
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
