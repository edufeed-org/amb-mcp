import { describe, it, expect } from 'vitest';
import type { Filter, NostrEvent } from 'nostr-tools';
import { AMBRelayClient } from '../../src/relay/client.js';

/** Capture the filter searchProfiles hands to queryEvents without any IO. */
function clientCapturingFilter(): { client: AMBRelayClient; captured: () => Filter } {
  const client = new AMBRelayClient('wss://example.invalid');
  let seen: Filter = {};
  (client as unknown as { queryEvents: (f: Filter) => Promise<NostrEvent[]> }).queryEvents =
    async (f: Filter) => {
      seen = f;
      return [];
    };
  return { client, captured: () => seen };
}

describe('AMBRelayClient.searchProfiles', () => {
  it('builds a kind-0 NIP-50 search filter', async () => {
    const { client, captured } = clientCapturingFilter();
    await client.searchProfiles('Jörg Lohrer', 5);
    expect(captured()).toEqual({ kinds: [0], search: 'Jörg Lohrer', limit: 5 });
  });

  it('defaults limit to 10 and clamps to 1..25', async () => {
    const { client, captured } = clientCapturingFilter();
    await client.searchProfiles('x');
    expect(captured().limit).toBe(10);
    await client.searchProfiles('x', 0);
    expect(captured().limit).toBe(1);
    await client.searchProfiles('x', 999);
    expect(captured().limit).toBe(25);
  });
});
