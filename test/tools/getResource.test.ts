import { describe, it, expect } from 'vitest';
import { nip19 } from 'nostr-tools';
import { naddrToLookup } from '../../src/tools/get.js';

function pk(n: number): string {
  return n.toString(16).padStart(64, '0');
}

describe('naddrToLookup', () => {
  it('decodes a valid naddr into identifier + author', () => {
    const naddr = nip19.naddrEncode({
      kind: 30142,
      pubkey: pk(7),
      identifier: 'https://example.org/material/peace/',
      relays: [],
    });
    expect(naddrToLookup(naddr)).toEqual({
      identifier: 'https://example.org/material/peace/',
      author: pk(7),
    });
  });

  it('returns null for a malformed or non-naddr value', () => {
    expect(naddrToLookup('not-an-naddr')).toBeNull();
    expect(naddrToLookup(nip19.npubEncode(pk(7)))).toBeNull();
  });
});
