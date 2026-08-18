import { describe, it, expect } from 'vitest';
import type { Filter, NostrEvent } from 'nostr-tools';
import { AMBRelayClient, UnknownRelayError } from '../../src/relay/client.js';

const DEFAULT = 'wss://amb-relay.example';
const EXTRA = 'wss://oersi.example';

function makeClient(): AMBRelayClient {
  return new AMBRelayClient([DEFAULT], { extraRelays: [EXTRA] });
}

/** Swap the pool's querySync for a recorder so no IO happens. */
function stubQuerySync(client: AMBRelayClient): () => string[][] {
  const calls: string[][] = [];
  (client as unknown as {
    pool: { querySync: (relays: string[], filter: Filter) => Promise<NostrEvent[]> };
  }).pool.querySync = async (relays) => {
    calls.push(relays);
    return [];
  };
  return () => calls;
}

describe('relay selection', () => {
  it('keeps extra relays out of the default set but selectable', () => {
    const client = makeClient();
    expect(client.getRelays()).toEqual([DEFAULT]);
    expect(client.getExtraRelays()).toEqual([EXTRA]);
    expect(client.getSelectableRelays()).toEqual([DEFAULT, EXTRA]);
  });

  it('works without extra relays (back-compat constructor)', () => {
    const client = new AMBRelayClient(DEFAULT);
    expect(client.getRelays()).toEqual([DEFAULT]);
    expect(client.getExtraRelays()).toEqual([]);
    expect(client.getSelectableRelays()).toEqual([DEFAULT]);
  });

  it('resolveRelays falls back to the default set when nothing is requested', () => {
    const client = makeClient();
    expect(client.resolveRelays()).toEqual([DEFAULT]);
    expect(client.resolveRelays([])).toEqual([DEFAULT]);
  });

  it('resolveRelays accepts default and extra relays, preserving request order', () => {
    const client = makeClient();
    expect(client.resolveRelays([EXTRA])).toEqual([EXTRA]);
    expect(client.resolveRelays([EXTRA, DEFAULT])).toEqual([EXTRA, DEFAULT]);
  });

  it('resolveRelays matches modulo URL normalization and returns the configured form', () => {
    const client = makeClient();
    expect(client.resolveRelays(['wss://oersi.example/'])).toEqual([EXTRA]);
  });

  it('resolveRelays dedupes repeated requests for the same relay', () => {
    expect(makeClient().resolveRelays([EXTRA, `${EXTRA}/`])).toEqual([EXTRA]);
  });

  it('resolveRelays throws UnknownRelayError for relays outside the allowlist', () => {
    const client = makeClient();
    let caught: unknown;
    try {
      client.resolveRelays(['wss://evil.example', EXTRA]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnknownRelayError);
    const err = caught as UnknownRelayError;
    expect(err.unknownRelays).toEqual(['wss://evil.example']);
    expect(err.selectableRelays).toEqual([DEFAULT, EXTRA]);
  });

  it('treats unparseable relay URLs as unknown, not as a crash', () => {
    const client = makeClient();
    let caught: unknown;
    try {
      client.resolveRelays(['not a url']);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnknownRelayError);
    expect((caught as UnknownRelayError).unknownRelays).toEqual(['not a url']);
  });
});

describe('runtime relay mutation vs extras', () => {
  it('addRelay of an extra relay moves it to the default set (no dual membership)', () => {
    const client = makeClient();
    client.addRelay(`${EXTRA}/`);
    expect(client.getRelays()).toEqual([DEFAULT, `${EXTRA}/`]);
    expect(client.getExtraRelays()).toEqual([]);
    expect(client.getSelectableRelays()).toEqual([DEFAULT, `${EXTRA}/`]);
  });

  it('dedupes normalization-duplicate extras at construction', () => {
    const client = new AMBRelayClient([DEFAULT], {
      extraRelays: [EXTRA, `${EXTRA}/`],
    });
    expect(client.getExtraRelays()).toEqual([EXTRA]);
  });
});

describe('query routing with a relays override', () => {
  it('query() hits the default relays when no override is given', async () => {
    const client = makeClient();
    const calls = stubQuerySync(client);
    await client.query({});
    expect(calls()).toEqual([[DEFAULT]]);
  });

  it('query() with an override hits only the requested relays', async () => {
    const client = makeClient();
    const calls = stubQuerySync(client);
    await client.query({}, [EXTRA]);
    expect(calls()).toEqual([[EXTRA]]);
  });

  it('search() with an override hits only the requested relays', async () => {
    const client = makeClient();
    const calls = stubQuerySync(client);
    await client.search('mathematik', {}, [EXTRA, DEFAULT]);
    expect(calls()).toEqual([[EXTRA, DEFAULT]]);
  });

  it('getById() and getByDTag() route the override through', async () => {
    const client = makeClient();
    const calls = stubQuerySync(client);
    await client.getById('e'.repeat(64), [30142], [EXTRA]);
    await client.getByDTag('some-d-tag', undefined, [30142], [EXTRA]);
    expect(calls()).toEqual([[EXTRA], [EXTRA]]);
  });

  it('query() rejects with UnknownRelayError for a relay outside the allowlist', async () => {
    const client = makeClient();
    stubQuerySync(client);
    await expect(client.query({}, ['wss://evil.example'])).rejects.toBeInstanceOf(
      UnknownRelayError
    );
  });

  it('queryEvents() routes the override to the subscription path', async () => {
    const client = makeClient();
    const seen = new Set<string>();
    (client as unknown as {
      pool: { ensureRelay: (url: string) => Promise<unknown> };
    }).pool.ensureRelay = async (url: string) => {
      seen.add(url);
      return {
        prepareSubscription(
          _filters: Filter[],
          handlers: { oneose: () => void }
        ) {
          return {
            close() {},
            fire() {
              queueMicrotask(() => handlers.oneose());
            },
            filters: [] as Filter[],
          };
        },
      };
    };

    await client.queryEvents({ kinds: [30142] }, [EXTRA]);
    expect([...seen]).toEqual([EXTRA]);
  });
});
