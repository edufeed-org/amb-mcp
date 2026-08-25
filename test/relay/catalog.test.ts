import { describe, it, expect } from 'vitest';
import {
  buildRelayCatalog,
  parseRelayNames,
  UnknownRelayNameError,
} from '../../src/relay/catalog.js';

const CONFIGURED = [
  'wss://relay.edufeed.org',
  'wss://oersi.edufeed.org',
  'wss://sodix.edufeed.org',
];

describe('buildRelayCatalog', () => {
  it('resolves a relay by its full configured URL', () => {
    const catalog = buildRelayCatalog(CONFIGURED);
    expect(catalog.resolve(['wss://sodix.edufeed.org'])).toEqual([
      'wss://sodix.edufeed.org',
    ]);
  });

  it('resolves a relay by its bare hostname', () => {
    const catalog = buildRelayCatalog(CONFIGURED);
    expect(catalog.resolve(['sodix.edufeed.org'])).toEqual([
      'wss://sodix.edufeed.org',
    ]);
  });

  it('resolves a relay by the first label of its hostname', () => {
    const catalog = buildRelayCatalog(CONFIGURED);
    expect(catalog.resolve(['sodix'])).toEqual(['wss://sodix.edufeed.org']);
  });

  it('resolves names case-insensitively', () => {
    const catalog = buildRelayCatalog(CONFIGURED);
    expect(catalog.resolve(['SODIX'])).toEqual(['wss://sodix.edufeed.org']);
  });

  it('preserves the order the caller asked for and drops duplicates', () => {
    const catalog = buildRelayCatalog(CONFIGURED);
    expect(catalog.resolve(['sodix', 'relay', 'sodix.edufeed.org'])).toEqual([
      'wss://sodix.edufeed.org',
      'wss://relay.edufeed.org',
    ]);
  });

  it('drops a short alias claimed by two relays, keeping the hostnames usable', () => {
    const catalog = buildRelayCatalog([
      'wss://sodix.edufeed.org',
      'wss://sodix.example.com',
    ]);
    expect(() => catalog.resolve(['sodix'])).toThrow(UnknownRelayNameError);
    expect(catalog.resolve(['sodix.example.com'])).toEqual([
      'wss://sodix.example.com',
    ]);
  });

  it('rejects an unknown name with the names it does accept', () => {
    const catalog = buildRelayCatalog(CONFIGURED);
    try {
      catalog.resolve(['sodix', 'nope']);
      expect.unreachable('resolve should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownRelayNameError);
      const e = err as UnknownRelayNameError;
      expect(e.unknownNames).toEqual(['nope']);
      expect(e.knownNames).toContain('sodix');
      expect(e.knownNames).toContain('wss://sodix.edufeed.org');
    }
  });

  it('lists every configured relay with the short alias that reaches it', () => {
    const catalog = buildRelayCatalog(CONFIGURED);
    expect(catalog.entries()).toEqual([
      { url: 'wss://relay.edufeed.org', alias: 'relay' },
      { url: 'wss://oersi.edufeed.org', alias: 'oersi' },
      { url: 'wss://sodix.edufeed.org', alias: 'sodix' },
    ]);
  });
});

describe('parseRelayNames', () => {
  it('splits a comma-separated parameter and trims each name', () => {
    expect(parseRelayNames(' sodix , oersi ')).toEqual(['sodix', 'oersi']);
  });

  it('returns an empty list for a parameter with no names', () => {
    expect(parseRelayNames(' , ')).toEqual([]);
  });
});
