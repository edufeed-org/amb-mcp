import { describe, it, expect } from 'vitest';
import type { Filter, NostrEvent } from 'nostr-tools';
import { AMBRelayClient } from '../../src/relay/client.js';
import { newRelayDiagnostics, relayDiagnosticsFields } from '../../src/tools/relaySelection.js';

const DEAD = 'ws://127.0.0.1:1'; // refuses connections immediately

describe('relayDiagnosticsFields', () => {
  it('is empty when every relay answered', () => {
    expect(relayDiagnosticsFields({ unreachable: [], timedOut: [] })).toEqual({});
  });

  it('names timed-out and unreachable relays, deduplicated, with a warning', () => {
    const out = relayDiagnosticsFields({ unreachable: ['wss://a'], timedOut: ['wss://a', 'wss://b'] });
    expect(out.relaysIncomplete).toEqual(['wss://a', 'wss://b']); // set-union, timedOut order first
    expect(String(out.warning)).toContain('did not fully answer');
    expect(String(out.warning)).toContain('NOT proof the corpus is');
  });
});

describe('queryEvents diagnostics (prepareSubscription path)', () => {
  it('records a connection-refusing relay as unreachable and returns [] leniently', async () => {
    const client = new AMBRelayClient([DEAD], { queryTimeoutMs: 500 });
    const diag = newRelayDiagnostics();
    try {
      const events = await client.queryEvents({ kinds: [30142], limit: 1 }, [DEAD], { diag });
      expect(events).toEqual([]);
      expect(diag.unreachable).toEqual([DEAD]);
      expect(diag.timedOut).toEqual([]);
    } finally {
      client.close();
    }
  });

  it('records a connected-but-never-EOSE relay as timedOut', async () => {
    const client = new AMBRelayClient(['wss://hangs.example'], { queryTimeoutMs: 80 });
    // Fake pool: ensureRelay resolves, prepareSubscription fires but never
    // calls oneose/onclose — i.e. a relay that connects and then hangs.
    (client as unknown as { pool: Record<string, unknown> }).pool = {
      ensureRelay: async () => ({
        prepareSubscription: () => ({ fire() {}, close() {}, filters: [] as Filter[] }),
      }),
      close() {},
    };
    const diag = newRelayDiagnostics();
    const events = await client.queryEvents({ kinds: [30142], limit: 1 }, ['wss://hangs.example'], { diag });
    expect(events).toEqual([]);
    expect(diag.timedOut).toEqual(['wss://hangs.example']);
    expect(diag.unreachable).toEqual([]);
  });
});

describe('queryRelays diagnostics (querySync path, via query())', () => {
  it('marks every queried relay as incomplete on a timeout (coarse)', async () => {
    const client = new AMBRelayClient(['wss://slow.example'], { queryTimeoutMs: 60 });
    (client as unknown as {
      pool: { querySync: (relays: string[], filter: Filter) => Promise<NostrEvent[]> };
    }).pool.querySync = () => new Promise<NostrEvent[]>(() => {}); // never resolves
    const diag = newRelayDiagnostics();
    const events = await client.query({ limit: 1 }, ['wss://slow.example'], diag);
    expect(events).toEqual([]);
    expect(diag.timedOut).toEqual(['wss://slow.example']);
  });

  it('reports no incomplete relays on a clean (fast) return', async () => {
    const client = new AMBRelayClient(['wss://ok.example'], { queryTimeoutMs: 500 });
    (client as unknown as {
      pool: { querySync: (relays: string[], filter: Filter) => Promise<NostrEvent[]> };
    }).pool.querySync = async () => [];
    const diag = newRelayDiagnostics();
    await client.query({ limit: 1 }, ['wss://ok.example'], diag);
    expect(diag.timedOut).toEqual([]);
    expect(diag.unreachable).toEqual([]);
  });
});
