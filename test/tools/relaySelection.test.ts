import { describe, it, expect } from 'vitest';
import { UnknownRelayError } from '../../src/relay/client.js';
import { unknownRelayPayload } from '../../src/tools/relaySelection.js';

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
        'The relays parameter only accepts relays from list_relays (default or extra).',
    });
  });
});
