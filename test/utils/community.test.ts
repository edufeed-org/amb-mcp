import { describe, it, expect } from 'vitest';
import { nip19 } from 'nostr-tools';
import { normalizeCommunityPubkey } from '../../src/utils/community.js';

describe('normalizeCommunityPubkey', () => {
  const hex = '660d8c78651f70487ec9b8ddc283e29cf2561693dda3ba246d3fd3c08dbb7083';

  it('passes a 64-char hex pubkey through (lowercased)', () => {
    expect(normalizeCommunityPubkey(hex)).toBe(hex);
    expect(normalizeCommunityPubkey(hex.toUpperCase())).toBe(hex);
  });

  it('decodes an npub to hex', () => {
    const npub = nip19.npubEncode(hex);
    expect(normalizeCommunityPubkey(npub)).toBe(hex);
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeCommunityPubkey(`  ${hex}  `)).toBe(hex);
  });

  it('throws on malformed input', () => {
    expect(() => normalizeCommunityPubkey('not-a-pubkey')).toThrow(/expected/i);
    expect(() => normalizeCommunityPubkey('nsec1xyz')).toThrow(/expected/i);
    expect(() => normalizeCommunityPubkey('abc123')).toThrow(/expected/i);
  });
});
