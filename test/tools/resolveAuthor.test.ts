import { describe, it, expect } from 'vitest';
import { nip19, type NostrEvent } from 'nostr-tools';
import { resolveAuthor } from '../../src/tools/resolveAuthor.js';

function pk(n: number): string {
  return n.toString(16).padStart(64, '0');
}

function profile(pubkey: string, content: string, kind = 0): NostrEvent {
  return { id: pubkey, pubkey, created_at: 1700000000, kind, tags: [], content, sig: 's' };
}

function fakeClient(events: NostrEvent[]) {
  return { searchProfiles: async () => events };
}

describe('resolveAuthor', () => {
  it('returns valid kind-0 candidates in relay order, dropping noise', async () => {
    const a = profile(pk(1), JSON.stringify({ display_name: 'Jörg Lohrer' }));
    const b = profile(pk(2), JSON.stringify({ name: 'e-teaching' }));
    const notProfile = profile(pk(3), 'irrelevant', 1); // non-kind-0 → dropped
    const malformed = profile(pk(4), 'not json'); // unparseable → dropped

    const out = await resolveAuthor(fakeClient([a, b, notProfile, malformed]), {
      name: 'lohrer',
    });

    expect(out.total).toBe(2);
    expect(out.candidates.map((c) => c.name)).toEqual(['Jörg Lohrer', 'e-teaching']);
    expect(out.candidates[0]).toEqual({
      pubkey: pk(1),
      npub: nip19.npubEncode(pk(1)),
      name: 'Jörg Lohrer',
    });
  });

  it('returns an empty result when the relay has no match', async () => {
    const out = await resolveAuthor(fakeClient([]), { name: 'nobody' });
    expect(out).toEqual({ total: 0, candidates: [] });
  });
});
