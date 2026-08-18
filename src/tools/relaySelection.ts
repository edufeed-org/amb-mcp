import type { UnknownRelayError } from '../relay/client.js';

/**
 * Shared tool-error payload for a per-call `relays` selection that named a
 * relay outside the selectable (default ∪ extra) set.
 */
export function unknownRelayPayload(err: UnknownRelayError): Record<string, unknown> {
  return {
    error: 'Unknown relay(s) requested',
    unknownRelays: err.unknownRelays,
    selectableRelays: err.selectableRelays,
    message:
      'The relays parameter only accepts relays from list_relays (default or extra).',
  };
}
