import { UnknownRelayError, type AMBRelayClient } from '../relay/client.js';

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

/**
 * Resolve a tool call's `relays` parameter: either the validated relay list
 * to query, or the ready-to-serialize error payload for an unknown relay.
 */
export function resolveRelaysOrError(
  client: Pick<AMBRelayClient, 'resolveRelays'>,
  requested?: string[]
): { relays: string[] } | { errorPayload: Record<string, unknown> } {
  try {
    return { relays: client.resolveRelays(requested) };
  } catch (err) {
    if (err instanceof UnknownRelayError) {
      return { errorPayload: unknownRelayPayload(err) };
    }
    throw err;
  }
}
