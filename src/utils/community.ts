import { nip19 } from 'nostr-tools';

const HEX64 = /^[0-9a-f]{64}$/i;

/**
 * Normalize a community identifier (hex pubkey or npub) to a 64-char lowercase
 * hex pubkey. Throws on malformed input so the tool layer surfaces a clear error.
 */
export function normalizeCommunityPubkey(input: string): string {
  const value = input.trim();
  if (HEX64.test(value)) return value.toLowerCase();
  if (value.startsWith('npub1')) {
    try {
      const decoded = nip19.decode(value);
      if (decoded.type === 'npub') return decoded.data;
    } catch {
      // fall through to the error below
    }
  }
  throw new Error(`Invalid community: expected a 64-char hex pubkey or npub, got "${input}"`);
}
