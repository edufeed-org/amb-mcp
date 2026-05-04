/**
 * Tests for SKOS Turtle import functionality
 */

import { describe, it, expect } from 'vitest';
import { importTurtle } from '../../src/skos/builder/turtle-import.js';

const SIMPLE_VOCAB = `
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix dct: <http://purl.org/dc/terms/> .

<https://example.org/vocab> a skos:ConceptScheme
    ; dct:title "Test Vocabulary"@en, "Testvokabular"@de
    ; dct:license <https://creativecommons.org/licenses/by/4.0/>
    ; skos:hasTopConcept <https://example.org/vocab/concept1>
    .

<https://example.org/vocab/concept1> a skos:Concept
    ; skos:inScheme <https://example.org/vocab>
    ; skos:prefLabel "First Concept"@en, "Erstes Konzept"@de
    ; skos:definition "This is the first concept"@en
    ; skos:narrower <https://example.org/vocab/concept2>
    .

<https://example.org/vocab/concept2> a skos:Concept
    ; skos:inScheme <https://example.org/vocab>
    ; skos:prefLabel "Second Concept"@en
    ; skos:altLabel "Alt Label"@en
    ; skos:broader <https://example.org/vocab/concept1>
    .
`;

describe('importTurtle', () => {
  it('imports a simple vocabulary', () => {
    const result = importTurtle(SIMPLE_VOCAB, 'test-user');

    expect(result.success).toBe(true);
    expect(result.state).toBeDefined();
    expect(result.state!.scheme.id).toBe('https://example.org/vocab');
  });

  it('extracts scheme metadata', () => {
    const result = importTurtle(SIMPLE_VOCAB, 'test-user');

    expect(result.state!.scheme.title).toEqual({
      en: 'Test Vocabulary',
      de: 'Testvokabular',
    });
    expect(result.state!.scheme.license).toBe(
      'https://creativecommons.org/licenses/by/4.0/'
    );
  });

  it('extracts concepts', () => {
    const result = importTurtle(SIMPLE_VOCAB, 'test-user');

    expect(result.state!.concepts.size).toBe(2);
    expect(result.state!.concepts.has('https://example.org/vocab/concept1')).toBe(
      true
    );
    expect(result.state!.concepts.has('https://example.org/vocab/concept2')).toBe(
      true
    );
  });

  it('extracts concept labels', () => {
    const result = importTurtle(SIMPLE_VOCAB, 'test-user');

    const concept1 = result.state!.concepts.get(
      'https://example.org/vocab/concept1'
    );
    expect(concept1!.prefLabel).toEqual({
      en: 'First Concept',
      de: 'Erstes Konzept',
    });
    expect(concept1!.definition).toEqual({
      en: 'This is the first concept',
    });
  });

  it('extracts altLabel', () => {
    const result = importTurtle(SIMPLE_VOCAB, 'test-user');

    const concept2 = result.state!.concepts.get(
      'https://example.org/vocab/concept2'
    );
    expect(concept2!.altLabel).toEqual([{ en: 'Alt Label' }]);
  });

  it('extracts broader/narrower relationships', () => {
    const result = importTurtle(SIMPLE_VOCAB, 'test-user');

    const concept1 = result.state!.concepts.get(
      'https://example.org/vocab/concept1'
    );
    const concept2 = result.state!.concepts.get(
      'https://example.org/vocab/concept2'
    );

    expect(concept1!.narrower).toHaveLength(1);
    expect(concept1!.narrower![0]).toMatchObject({
      id: 'https://example.org/vocab/concept2',
    });

    expect(concept2!.broader).toHaveLength(1);
    expect(concept2!.broader![0]).toMatchObject({
      id: 'https://example.org/vocab/concept1',
    });
  });

  it('extracts top concepts', () => {
    const result = importTurtle(SIMPLE_VOCAB, 'test-user');

    expect(result.state!.scheme.hasTopConcept).toHaveLength(1);
    expect(result.state!.scheme.hasTopConcept[0].id).toBe(
      'https://example.org/vocab/concept1'
    );
  });

  it('returns error for invalid Turtle', () => {
    const result = importTurtle('invalid turtle content', 'test-user');

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns error for Turtle without ConceptScheme', () => {
    const noScheme = `
      @prefix skos: <http://www.w3.org/2004/02/skos/core#> .
      <https://example.org/concept> a skos:Concept .
    `;
    const result = importTurtle(noScheme, 'test-user');

    expect(result.success).toBe(false);
    expect(result.error).toContain('No skos:ConceptScheme found');
  });

  it('sets owner from userPubkey', () => {
    const result = importTurtle(SIMPLE_VOCAB, 'my-pubkey-123');

    expect(result.state!.owner).toBe('my-pubkey-123');
  });
});
