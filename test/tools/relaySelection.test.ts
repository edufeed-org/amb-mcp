import { describe, it, expect } from 'vitest';
import { AMBRelayClient, UnknownRelayError } from '../../src/relay/client.js';
import {
  relaysNotSearched,
  resolveRelaysOrError,
  unknownRelayPayload,
} from '../../src/tools/relaySelection.js';

describe('unknownRelayPayload', () => {
  it('turns an UnknownRelayError into an actionable tool error payload', () => {
    const err = new UnknownRelayError(
      ['wss://evil.example'],
      ['wss://amb-relay.example', 'wss://oersi.example']
    );
    expect(unknownRelayPayload(err)).toEqual({
      error: 'Unknown relay(s) requested',
      unknownRelays: ['wss://evil.example'],
      selectableRelays: ['wss://amb-relay.example', 'wss://oersi.example'],
      message:
        'The relays parameter only accepts relays from list_relays (default or extra). ' +
        'Name each by its full URL or its short name — the hostname or first label ' +
        '(e.g. "oersi", "sodix", "amb-relay").',
    });
  });
});

describe('resolveRelaysOrError', () => {
  const client = new AMBRelayClient(['wss://amb-relay.example'], {
    extraRelays: ['wss://oersi.example'],
  });

  it('returns the resolved relays for a valid selection', () => {
    expect(resolveRelaysOrError(client, ['wss://oersi.example'])).toEqual({
      relays: ['wss://oersi.example'],
    });
    expect(resolveRelaysOrError(client, undefined)).toEqual({
      relays: ['wss://amb-relay.example'],
    });
  });

  it('relaysNotSearched lists the selectable relays a search skipped', () => {
    expect(relaysNotSearched(client, ['wss://amb-relay.example'])).toEqual([
      'wss://oersi.example',
    ]);
    expect(relaysNotSearched(client, ['wss://oersi.example'])).toEqual([
      'wss://amb-relay.example',
    ]);
    expect(
      relaysNotSearched(client, ['wss://amb-relay.example', 'wss://oersi.example'])
    ).toEqual([]);
  });

  it('returns the error payload for an unknown relay', () => {
    const out = resolveRelaysOrError(client, ['wss://evil.example']);
    expect(out).toEqual({
      errorPayload: {
        error: 'Unknown relay(s) requested',
        unknownRelays: ['wss://evil.example'],
        selectableRelays: ['wss://amb-relay.example', 'wss://oersi.example'],
        message:
          'The relays parameter only accepts relays from list_relays (default or extra). ' +
        'Name each by its full URL or its short name — the hostname or first label ' +
        '(e.g. "oersi", "sodix", "amb-relay").',
      },
    });
  });
});
