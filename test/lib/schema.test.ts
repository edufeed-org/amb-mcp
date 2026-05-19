import { describe, it, expect } from 'vitest';
import { extractMetadataResult, formPayload } from '../../src/lib/schema.js';

describe('formPayload schema (variant-aware)', () => {
  it('accepts a minimal AMB payload (just name)', () => {
    const result = formPayload('amb').safeParse({ name: 'Hello' });
    expect(result.success).toBe(true);
  });

  it('rejects EKW-only field bibleReferences under variant=amb', () => {
    const result = formPayload('amb').safeParse({
      name: 'Hello',
      bibleReferences: ['Mt 5,1-12']
    });
    expect(result.success).toBe(false);
  });

  it('accepts EKW-only field bibleReferences under variant=ekw', () => {
    const result = formPayload('ekw').safeParse({
      name: 'Hello',
      bibleReferences: ['Mt 5,1-12']
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown fields under any variant', () => {
    const result = formPayload('ekw').safeParse({ name: 'Hello', notAField: 1 });
    expect(result.success).toBe(false);
  });

  it('accepts a minimal Konfi payload (just name)', () => {
    const result = formPayload('konfi').safeParse({ name: 'Hello' });
    expect(result.success).toBe(true);
  });

  it('accepts Konfi-only vocab fields (konfiZielgruppen, landeskirchen) under variant=konfi', () => {
    const result = formPayload('konfi').safeParse({
      name: 'Hello',
      konfiZielgruppen: [
        { id: 'https://w3id.org/kim/edufeed/konfi/zielgruppen/konfis', prefLabel: 'Konfis' }
      ],
      landeskirchen: [
        { id: 'https://w3id.org/kim/edufeed/landeskirchen/ekkw', prefLabel: 'EKKW' }
      ]
    });
    expect(result.success).toBe(true);
  });

  it('accepts Konfi scalar fields plainLanguage and requiredMaterialsNote under variant=konfi', () => {
    const result = formPayload('konfi').safeParse({
      name: 'Hello',
      plainLanguage: true,
      requiredMaterialsNote: 'Stifte, Plakate'
    });
    expect(result.success).toBe(true);
  });

  it('accepts bibleReferences under variant=konfi (shared with EKW)', () => {
    const result = formPayload('konfi').safeParse({
      name: 'Hello',
      bibleReferences: ['Apostelgeschichte 2,1-12']
    });
    expect(result.success).toBe(true);
  });

  it('rejects Konfi-only field konfiZielgruppen under variant=amb', () => {
    const result = formPayload('amb').safeParse({
      name: 'Hello',
      konfiZielgruppen: [{ id: 'x' }]
    });
    expect(result.success).toBe(false);
  });

  it('rejects Konfi-only field konfiZielgruppen under variant=ekw', () => {
    const result = formPayload('ekw').safeParse({
      name: 'Hello',
      konfiZielgruppen: [{ id: 'x' }]
    });
    expect(result.success).toBe(false);
  });

  it('rejects EKW school field schoolTypes under variant=konfi', () => {
    const result = formPayload('konfi').safeParse({
      name: 'Hello',
      schoolTypes: [{ id: 'x' }]
    });
    expect(result.success).toBe(false);
  });

  it('rejects EKW school field gradeLevels under variant=konfi', () => {
    const result = formPayload('konfi').safeParse({
      name: 'Hello',
      gradeLevels: [{ id: 'x' }]
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown fields under variant=konfi', () => {
    const result = formPayload('konfi').safeParse({ name: 'Hello', notAField: 1 });
    expect(result.success).toBe(false);
  });
});

describe('extractMetadataResult schema', () => {
  it('accepts a well-formed amb-jsonld result with empty payload', () => {
    const result = extractMetadataResult.safeParse({
      source: 'amb-jsonld',
      payload: {},
      evidence: {},
      baseline: {}
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown source values', () => {
    const result = extractMetadataResult.safeParse({
      source: 'magic',
      payload: {},
      evidence: {},
      baseline: {}
    });
    expect(result.success).toBe(false);
  });
});
