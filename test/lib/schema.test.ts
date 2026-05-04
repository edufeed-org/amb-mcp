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
