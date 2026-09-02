import { describe, it, expect, vi } from 'vitest';
import { IndexerClient } from '../../src/indexer/client.js';

const SPEC = 'wss://relay.edufeed.org=https://indexer.edufeed.org, wss://oersi.edufeed.org=https://indexer.oersi.edufeed.org/';

describe('IndexerClient.fromEnv', () => {
  it('parses relay=endpoint pairs, trimming and stripping trailing slash', () => {
    const c = IndexerClient.fromEnv(SPEC, 'tok');
    expect(c?.forRelay('wss://relay.edufeed.org')).toBe('https://indexer.edufeed.org');
    expect(c?.forRelay('wss://oersi.edufeed.org/')).toBe('https://indexer.oersi.edufeed.org');
    expect(c?.forRelay('wss://unknown.example')).toBeNull();
  });
  it('returns null without spec or token', () => {
    expect(IndexerClient.fromEnv(undefined, 'tok')).toBeNull();
    expect(IndexerClient.fromEnv(SPEC, undefined)).toBeNull();
  });
});

describe('searchChunks', () => {
  it('POSTs with bearer auth and returns hits', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ hits: [{ chunk_id: 'c', event_id: 'e', event_coord: '30142:p:d', chunk_idx: 0, snippet: 's', score: 0.9 }], total: 1 }),
      { status: 200 }
    ));
    const c = new IndexerClient(new Map([['wss://relay.edufeed.org', 'https://ix']]), 'tok', fetchImpl as unknown as typeof fetch);
    const res = await c.searchChunks('wss://relay.edufeed.org', { q: 'klima', k: 10, filter: { kinds: [30142] } });
    expect(res.total).toBe(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://ix/search_chunks');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ q: 'klima', k: 10, filter: { kinds: [30142] } });
  });

  it('throws no_indexer for an unmapped relay', async () => {
    const c = new IndexerClient(new Map(), 'tok');
    await expect(c.searchChunks('wss://x', { q: 'q', k: 1, filter: {} }))
      .rejects.toMatchObject({ code: 'no_indexer' });
  });

  it('throws indexer_error on non-2xx', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }));
    const c = new IndexerClient(new Map([['wss://r', 'https://ix']]), 'tok', fetchImpl as unknown as typeof fetch);
    await expect(c.searchChunks('wss://r', { q: 'q', k: 1, filter: {} }))
      .rejects.toMatchObject({ code: 'indexer_error' });
  });

  it('throws indexer_error on network failure', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const c = new IndexerClient(new Map([['wss://r', 'https://ix']]), 'tok', fetchImpl as unknown as typeof fetch);
    await expect(c.searchChunks('wss://r', { q: 'q', k: 1, filter: {} }))
      .rejects.toMatchObject({ code: 'indexer_error' });
  });

  it('throws indexer_error on invalid JSON response', async () => {
    const fetchImpl = vi.fn(async () => new Response('not-json{', { status: 200 }));
    const c = new IndexerClient(new Map([['wss://r', 'https://ix']]), 'tok', fetchImpl as unknown as typeof fetch);
    await expect(c.searchChunks('wss://r', { q: 'q', k: 1, filter: {} }))
      .rejects.toMatchObject({ code: 'indexer_error' });
  });
});
