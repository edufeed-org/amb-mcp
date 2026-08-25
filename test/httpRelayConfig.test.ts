import { describe, it, expect } from 'vitest';
import { resolveSessionRelays } from '../src/http.js';
import { SessionConfigError } from '../src/transport/http.js';

const CONFIG = {
  defaults: ['wss://relay.edufeed.org'],
  extras: ['wss://oersi.edufeed.org', 'wss://sodix.edufeed.org'],
};

const q = (search: string) => new URLSearchParams(search);

describe('resolveSessionRelays', () => {
  it('keeps the server config when the URL names no relays', () => {
    const out = resolveSessionRelays(q(''), CONFIG);
    expect(out.defaults).toEqual(CONFIG.defaults);
    expect(out.extras).toEqual(CONFIG.extras);
    expect(out.fromConnectorUrl).toBe(false);
  });

  it('promotes a URL-named extra relay into the session default set', () => {
    const out = resolveSessionRelays(q('relays=sodix'), CONFIG);
    expect(out.defaults).toEqual(['wss://sodix.edufeed.org']);
    expect(out.fromConnectorUrl).toBe(true);
  });

  it('leaves every relay the URL did not name selectable per call', () => {
    const out = resolveSessionRelays(q('relays=sodix'), CONFIG);
    expect(out.extras).toEqual(['wss://relay.edufeed.org', 'wss://oersi.edufeed.org']);
  });

  it('honours the order the URL listed the relays in', () => {
    const out = resolveSessionRelays(q('relays=sodix,relay'), CONFIG);
    expect(out.defaults).toEqual(['wss://sodix.edufeed.org', 'wss://relay.edufeed.org']);
    expect(out.extras).toEqual(['wss://oersi.edufeed.org']);
  });

  it('accepts full relay URLs as well as short aliases', () => {
    const out = resolveSessionRelays(q('relays=wss%3A%2F%2Fsodix.edufeed.org'), CONFIG);
    expect(out.defaults).toEqual(['wss://sodix.edufeed.org']);
  });

  it('rejects a relay this deployment does not serve', () => {
    try {
      resolveSessionRelays(q('relays=sodix,evil.example.com'), CONFIG);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionConfigError);
      const e = err as SessionConfigError;
      expect(e.details?.unknownNames).toEqual(['evil.example.com']);
      expect(e.details?.knownNames).toContain('sodix');
    }
  });

  it('rejects a relays parameter that names nothing', () => {
    expect(() => resolveSessionRelays(q('relays='), CONFIG)).toThrow(SessionConfigError);
    expect(() => resolveSessionRelays(q('relays=%20,%20'), CONFIG)).toThrow(SessionConfigError);
  });
});
