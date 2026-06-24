import { describe, it, expect } from 'vitest';
import { nip19 } from 'nostr-tools';
import { buildCalendarFilter } from '../../src/calendar/filters.js';

describe('buildCalendarFilter', () => {
  it('builds a basic filter with default kinds and limit', () => {
    const filter = buildCalendarFilter({});
    expect(filter.kinds).toEqual([31922, 31923]);
    expect(filter.limit).toBe(20);
  });

  it('uses custom kinds when provided', () => {
    const filter = buildCalendarFilter({ kinds: [31923] });
    expect(filter.kinds).toEqual([31923]);
  });

  it('sets #start_after tag filter', () => {
    const filter = buildCalendarFilter({ startAfter: 1700000000 });
    expect((filter as Record<string, unknown>)['#start_after']).toEqual(['1700000000']);
  });

  it('sets #start_before tag filter', () => {
    const filter = buildCalendarFilter({ startBefore: 1800000000 });
    expect((filter as Record<string, unknown>)['#start_before']).toEqual(['1800000000']);
  });

  it('sets #end_after tag filter', () => {
    const filter = buildCalendarFilter({ endAfter: 1700000000 });
    expect((filter as Record<string, unknown>)['#end_after']).toEqual(['1700000000']);
  });

  it('sets #end_before tag filter', () => {
    const filter = buildCalendarFilter({ endBefore: 1800000000 });
    expect((filter as Record<string, unknown>)['#end_before']).toEqual(['1800000000']);
  });

  it('sets #g geohash filter', () => {
    const filter = buildCalendarFilter({ geohash: 'u33d' });
    expect((filter as Record<string, unknown>)['#g']).toEqual(['u33d']);
  });

  it('sets #t hashtag filter', () => {
    const filter = buildCalendarFilter({ hashtags: ['meetup', 'nostr'] });
    expect(filter['#t']).toEqual(['meetup', 'nostr']);
  });

  it('includes authors in filter', () => {
    const filter = buildCalendarFilter({ authors: ['abc123', 'def456'] });
    expect(filter.authors).toEqual(['abc123', 'def456']);
  });

  it('includes since/until in filter', () => {
    const filter = buildCalendarFilter({ since: 1700000000, until: 1800000000 });
    expect(filter.since).toBe(1700000000);
    expect(filter.until).toBe(1800000000);
  });

  it('clamps limit to valid range', () => {
    expect(buildCalendarFilter({ limit: 0 }).limit).toBe(1);
    expect(buildCalendarFilter({ limit: 500 }).limit).toBe(250);
    expect(buildCalendarFilter({ limit: 100 }).limit).toBe(100);
  });

  it('combines multiple filters', () => {
    const filter = buildCalendarFilter({
      startAfter: 1700000000,
      startBefore: 1800000000,
      geohash: 'u33d',
      hashtags: ['meetup'],
      authors: ['abc123'],
      limit: 50,
    });

    expect(filter.kinds).toEqual([31922, 31923]);
    expect(filter.limit).toBe(50);
    expect(filter.authors).toEqual(['abc123']);
    expect((filter as Record<string, unknown>)['#start_after']).toEqual(['1700000000']);
    expect((filter as Record<string, unknown>)['#start_before']).toEqual(['1800000000']);
    expect((filter as Record<string, unknown>)['#g']).toEqual(['u33d']);
    expect(filter['#t']).toEqual(['meetup']);
  });

  it('omits undefined optional fields', () => {
    const filter = buildCalendarFilter({});
    expect(filter.authors).toBeUndefined();
    expect(filter.since).toBeUndefined();
    expect(filter.until).toBeUndefined();
    expect((filter as Record<string, unknown>)['#start_after']).toBeUndefined();
    expect((filter as Record<string, unknown>)['#start_before']).toBeUndefined();
    expect((filter as Record<string, unknown>)['#end_after']).toBeUndefined();
    expect((filter as Record<string, unknown>)['#end_before']).toBeUndefined();
    expect((filter as Record<string, unknown>)['#g']).toBeUndefined();
    expect(filter['#t']).toBeUndefined();
  });

  it('sets the NIP-50 search string from query', () => {
    const filter = buildCalendarFilter({ query: 'mathematik' });
    expect(filter.search).toBe('mathematik');
  });

  it('keeps range params and search together (relay decides precedence)', () => {
    const filter = buildCalendarFilter({ query: 'mathe', startAfter: 100 });
    expect(filter.search).toBe('mathe');
    expect((filter as Record<string, unknown>)['#start_after']).toEqual(['100']);
  });
});

describe('buildCalendarFilter community param', () => {
  const hex = '660d8c78651f70487ec9b8ddc283e29cf2561693dda3ba246d3fd3c08dbb7083';

  it('sets search to community:<hex> when only community is given', () => {
    const filter = buildCalendarFilter({ community: hex });
    expect(filter.search).toBe(`community:${hex}`);
  });

  it('space-joins query and community', () => {
    const filter = buildCalendarFilter({ query: 'mathematik', community: hex });
    expect(filter.search).toBe(`mathematik community:${hex}`);
  });

  it('normalizes an npub community to hex', () => {
    const npub = nip19.npubEncode(hex);
    const filter = buildCalendarFilter({ community: npub });
    expect(filter.search).toBe(`community:${hex}`);
  });

  it('throws on malformed community', () => {
    expect(() => buildCalendarFilter({ community: 'garbage' })).toThrow(/expected/i);
  });
});
