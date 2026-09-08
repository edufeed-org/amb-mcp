import { UnknownRelayError, type AMBRelayClient, type RelayQueryDiagnostics } from '../relay/client.js';

/** A fresh diagnostics collector to pass into a query and read back after. */
export function newRelayDiagnostics(): RelayQueryDiagnostics {
  return { unreachable: [], timedOut: [] };
}

/**
 * Turn per-relay query diagnostics into response fields a caller can surface.
 * Returns {} when every relay answered — so a genuinely empty result stays
 * clean — and a warning naming the relays that didn't when some stalled or
 * refused, so an LLM never reads a transient outage as "nothing found."
 */
export function relayDiagnosticsFields(diag: RelayQueryDiagnostics): Record<string, unknown> {
  const affected = [...new Set([...diag.timedOut, ...diag.unreachable])];
  if (affected.length === 0) return {};
  return {
    relaysIncomplete: affected,
    warning:
      `These relays did not fully answer (timed out or unreachable): ${affected.join(', ')}. ` +
      `Results may be incomplete — an empty or short result here is NOT proof the corpus is ` +
      `empty; tell the user a source was unreachable and offer to retry.`,
  };
}

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
      'The relays parameter only accepts relays from list_relays (default or extra). ' +
      'Name each by its full URL or its short name — the hostname or first label ' +
      '(e.g. "oersi", "sodix", "amb-relay").',
  };
}

/**
 * Selectable relays a search did NOT cover — surfaced next to relaysSearched
 * so callers discover, at the decision point, that more corpus is one
 * `relays` parameter away.
 */
export function relaysNotSearched(
  client: Pick<AMBRelayClient, 'getSelectableRelays'>,
  searched: string[]
): string[] {
  return client.getSelectableRelays().filter((url) => !searched.includes(url));
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
