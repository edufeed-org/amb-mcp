import { describe, it, expect, beforeEach } from 'vitest';
import { vocabSnapshot } from '../../src/lib/vocabs.js';
import { vocabularyCache } from '../../src/skos/cache.js';
import type { ParsedVocabulary } from '../../src/skos/types.js';

/**
 * Build a parsed-vocabulary fixture and prime the SKOSCache so the adapter
 * does not hit the network. We test the adapter shape, not skohub fetching.
 */
function primeCache(uri: string, vocab: ParsedVocabulary) {
  vocabularyCache.set(uri, vocab);
}

const FIXTURE_URI = 'https://example.test/vocab/scheme';

const fixture: ParsedVocabulary = {
  scheme: {
    id: FIXTURE_URI,
    type: 'ConceptScheme',
    title: { de: 'Lernressourcentyp', en: 'Learning Resource Type' },
    hasTopConcept: []
  },
  concepts: new Map([
    [
      'https://example.test/vocab/text',
      {
        id: 'https://example.test/vocab/text',
        type: 'Concept',
        prefLabel: { de: 'Text', en: 'Text' },
        altLabel: [{ de: 'Lesetext', en: 'Reading' }]
      }
    ],
    [
      'https://example.test/vocab/video',
      {
        id: 'https://example.test/vocab/video',
        type: 'Concept',
        prefLabel: { de: 'Video', en: 'Video' }
      }
    ],
    [
      'https://example.test/vocab/legacy',
      {
        id: 'https://example.test/vocab/legacy',
        type: 'Concept',
        prefLabel: { de: 'Veraltet', en: 'Deprecated' },
        deprecated: true
      }
    ],
    [
      'https://example.test/vocab/english-only',
      {
        id: 'https://example.test/vocab/english-only',
        type: 'Concept',
        // No de label — exercises the en fallback
        prefLabel: { en: 'English Only' }
      }
    ]
  ])
};

describe('vocabSnapshot', () => {
  beforeEach(() => {
    vocabularyCache.clear();
    primeCache(FIXTURE_URI, fixture);
  });

  it('returns a snapshot with one entry per concept', async () => {
    const snap = await vocabSnapshot(FIXTURE_URI);
    // 4 concepts in fixture, 1 deprecated → 3 entries
    expect(snap.concepts).toHaveLength(3);
  });

  it('exposes the scheme id and German title', async () => {
    const snap = await vocabSnapshot(FIXTURE_URI);
    expect(snap.id).toBe(FIXTURE_URI);
    expect(snap.title).toBe('Lernressourcentyp');
  });

  it('prefers German prefLabel by default', async () => {
    const snap = await vocabSnapshot(FIXTURE_URI);
    const text = snap.concepts.find((c) => c.id === 'https://example.test/vocab/text');
    expect(text?.prefLabel).toBe('Text');
  });

  it('falls back to first available language when German missing', async () => {
    const snap = await vocabSnapshot(FIXTURE_URI);
    const en = snap.concepts.find((c) => c.id === 'https://example.test/vocab/english-only');
    expect(en?.prefLabel).toBe('English Only');
  });

  it('flattens altLabels into a single string array (German first)', async () => {
    const snap = await vocabSnapshot(FIXTURE_URI);
    const text = snap.concepts.find((c) => c.id === 'https://example.test/vocab/text');
    expect(text?.altLabels?.[0]).toBe('Lesetext');
  });

  it('omits altLabels field when none present', async () => {
    const snap = await vocabSnapshot(FIXTURE_URI);
    const video = snap.concepts.find((c) => c.id === 'https://example.test/vocab/video');
    expect(video?.altLabels).toBeUndefined();
  });

  it('drops deprecated concepts', async () => {
    const snap = await vocabSnapshot(FIXTURE_URI);
    expect(snap.concepts.find((c) => c.id === 'https://example.test/vocab/legacy')).toBeUndefined();
  });

  it('honors the language option (en)', async () => {
    const snap = await vocabSnapshot(FIXTURE_URI, { language: 'en' });
    const text = snap.concepts.find((c) => c.id === 'https://example.test/vocab/text');
    expect(text?.prefLabel).toBe('Text'); // happens to be the same string
    expect(text?.altLabels?.[0]).toBe('Reading');
  });
});

describe('vocabSnapshot serialization', () => {
  beforeEach(() => {
    vocabularyCache.clear();
    primeCache(FIXTURE_URI, fixture);
  });

  it('produces a stable JSON shape suitable for prompt caching', async () => {
    const snap = await vocabSnapshot(FIXTURE_URI);
    const json = JSON.stringify(snap);
    expect(json).toContain('"id"');
    expect(json).toContain('"prefLabel"');
    // Output is plain data — no Maps / undefined
    const round = JSON.parse(json);
    expect(round.concepts).toBeInstanceOf(Array);
  });
});
