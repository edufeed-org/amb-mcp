import { describe, it, expect } from 'vitest';
import type { RelayInfo } from '../../src/relay/client.js';
import { runRelayStats } from '../../src/tools/stats.js';
import { runListRelays } from '../../src/tools/relays.js';

const DEFAULT = 'wss://amb-relay.example';
const EXTRA = 'wss://oersi.example';

function fakeClient(infoUrls: string[]) {
  const info: RelayInfo = { name: 'r', description: 'd', software: 's', version: '1' };
  return {
    getRelays: () => [DEFAULT],
    getExtraRelays: () => [EXTRA],
    getRelayInfo: async () => new Map(infoUrls.map((u) => [u, info])),
  };
}

describe('runRelayStats', () => {
  it('covers default and extra relays, each marked with its role', async () => {
    const out = await runRelayStats(fakeClient([DEFAULT, EXTRA]));
    expect(out.count).toBe(2);
    expect(out.relays.map((r) => [r.url, r.role])).toEqual([
      [DEFAULT, 'default'],
      [EXTRA, 'extra'],
    ]);
    expect(out.relays.every((r) => !('error' in r))).toBe(true);
  });

  it('reports a fetch failure per relay without dropping the entry', async () => {
    const out = await runRelayStats(fakeClient([DEFAULT]));
    expect(out.relays[1]).toEqual({
      url: EXTRA,
      role: 'extra',
      error: 'Failed to fetch relay info',
    });
  });
});

describe('runListRelays', () => {
  it('includes a usage note when extra relays exist', () => {
    const out = runListRelays({
      getRelays: () => [DEFAULT],
      getExtraRelays: () => [EXTRA],
    });
    expect(out.defaultRelays).toEqual([DEFAULT]);
    expect(out.extraRelays).toEqual([EXTRA]);
    expect(out.count).toBe(2);
    expect(out.note).toMatch(/not searched by default/i);
    expect(out.note).toMatch(/relays parameter/i);
  });

  it('omits the note when there are no extra relays', () => {
    const out = runListRelays({
      getRelays: () => [DEFAULT],
      getExtraRelays: () => [],
    });
    expect(out.note).toBeUndefined();
    expect(out.count).toBe(1);
  });

  it('attributes the default set to the server config by default', () => {
    const out = runListRelays({
      getRelays: () => [DEFAULT],
      getExtraRelays: () => [],
    });
    expect(out.defaultRelaysSource).toBe('server-config');
  });

  it('reports a default set that the connection URL chose', () => {
    const out = runListRelays(
      { getRelays: () => [DEFAULT], getExtraRelays: () => [] },
      { defaultsFromConnectorUrl: true },
    );
    expect(out.defaultRelaysSource).toBe('connector-url');
    expect(out.note).toMatch(/connection URL/i);
  });
});
