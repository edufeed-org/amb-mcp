import { describe, it, expect } from 'vitest';
import { nip19 } from 'nostr-tools';
import { buildContentFilter } from '../../src/relay/filters.js';

describe('buildContentFilter', () => {
  it('defaults to all content kinds plus the 21142 snippet kind', () => {
    const f = buildContentFilter({});
    expect(new Set(f.kinds)).toEqual(new Set([30142, 30023, 30818, 21142]));
    expect(f.limit).toBe(20);
    expect(f.search).toBeUndefined();
  });

  it('maps a types subset to the right kinds (plus 21142)', () => {
    const f = buildContentFilter({ types: ['article', 'wiki'] });
    expect(new Set(f.kinds)).toEqual(new Set([30023, 30818, 21142]));
  });

  it('sets the NIP-50 search string from query', () => {
    const f = buildContentFilter({ query: 'unaufmerksam seminar' });
    expect(f.search).toBe('unaufmerksam seminar');
  });

  it('passes through authors, since, until', () => {
    const f = buildContentFilter({ authors: ['a', 'b'], since: 100, until: 200 });
    expect(f.authors).toEqual(['a', 'b']);
    expect(f.since).toBe(100);
    expect(f.until).toBe(200);
  });

  it('bounds the limit', () => {
    expect(buildContentFilter({ limit: 0 }).limit).toBe(1);
    expect(buildContentFilter({ limit: 999 }).limit).toBe(250);
    expect(buildContentFilter({ limit: 50 }).limit).toBe(50);
  });

  it('always includes the snippet kind even for a single type', () => {
    const f = buildContentFilter({ types: ['resource'] });
    expect(f.kinds).toContain(21142);
    expect(f.kinds).toContain(30142);
  });
});

describe('buildContentFilter community param', () => {
  const hex = '660d8c78651f70487ec9b8ddc283e29cf2561693dda3ba246d3fd3c08dbb7083';

  it('sets search to community:<hex> when only community is given', () => {
    const filter = buildContentFilter({ community: hex });
    expect(filter.search).toBe(`community:${hex}`);
  });

  it('space-joins free-text query and community', () => {
    const filter = buildContentFilter({ query: 'mathematik', community: hex });
    expect(filter.search).toBe(`mathematik community:${hex}`);
  });

  it('normalizes an npub community to hex', () => {
    const npub = nip19.npubEncode(hex);
    const filter = buildContentFilter({ community: npub });
    expect(filter.search).toBe(`community:${hex}`);
  });

  it('throws on malformed community', () => {
    expect(() => buildContentFilter({ community: 'garbage' })).toThrow(/expected/i);
  });
});
