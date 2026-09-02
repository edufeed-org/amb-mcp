import { describe, it, expect, vi } from 'vitest';
import { buildScope, SCOPE_CAP, MATERIALIZE_REQ_LIMIT } from '../../src/spells/scope.js';
import type { Event as NostrEvent } from 'nostr-tools';

function ev(kind: number, pubkey: string, d: string, created_at = 1): NostrEvent {
  return { id: 'e'.repeat(64), pubkey, created_at, kind, tags: [['d', d]], content: '', sig: 's' };
}
const neverQuery = vi.fn(async () => { throw new Error('must not REQ'); });

describe('buildScope — passthrough', () => {
  it('maps authors+kinds directly, no REQ', async () => {
    const scope = await buildScope({ kinds: [30142], authors: ['a'.repeat(64)] }, neverQuery);
    expect(scope.mode).toBe('passthrough');
    expect(scope.chunkFilter).toEqual({ kinds: [30142], pubkey: ['a'.repeat(64)] });
    expect(scope.truncated).toBe(false);
    expect(neverQuery).not.toHaveBeenCalled();
  });

  it('kinds-only is passthrough', async () => {
    const scope = await buildScope({ kinds: [30040] }, neverQuery);
    expect(scope.chunkFilter).toEqual({ kinds: [30040] });
  });

  it('caps a long author list and flags truncation', async () => {
    const authors = Array.from({ length: 300 }, (_, i) => i.toString(16).padStart(64, '0'));
    const scope = await buildScope({ authors }, neverQuery);
    expect((scope.chunkFilter.pubkey as string[]).length).toBe(SCOPE_CAP);
    expect(scope.truncated).toBe(true);
  });

  it('ignores the spell limit in passthrough mode', async () => {
    const scope = await buildScope({ kinds: [30142], limit: 5 }, neverQuery);
    expect(scope.mode).toBe('passthrough');
  });

  it('rejects empty authors with no filter', async () => {
    await expect(buildScope({ authors: [] }, neverQuery))
      .rejects.toMatchObject({ code: 'no_filter' });
    expect(neverQuery).not.toHaveBeenCalled();
  });

  it('rejects empty filter with no kinds or authors', async () => {
    await expect(buildScope({}, neverQuery))
      .rejects.toMatchObject({ code: 'no_filter' });
    expect(neverQuery).not.toHaveBeenCalled();
  });
});

describe('buildScope — materialized', () => {
  it('REQs, derives coords from addressable events, dedupes', async () => {
    const q = vi.fn(async () => [
      ev(30142, 'a'.repeat(64), 'x'), ev(30142, 'a'.repeat(64), 'x'), ev(30023, 'b'.repeat(64), 'y'),
    ]);
    const scope = await buildScope({ kinds: [30142], search: 'klima' }, q);
    expect(scope.mode).toBe('materialized');
    expect(q).toHaveBeenCalledWith({ kinds: [30142], search: 'klima', limit: MATERIALIZE_REQ_LIMIT });
    expect(scope.chunkFilter).toEqual({
      event_coord: [`30142:${'a'.repeat(64)}:x`, `30023:${'b'.repeat(64)}:y`],
    });
    expect(scope.eventsInScope).toBe(2);
  });

  it('honors a smaller spell limit for the REQ', async () => {
    const q = vi.fn(async () => [ev(30142, 'a'.repeat(64), 'x')]);
    await buildScope({ search: 'x', limit: 50 }, q);
    expect(q).toHaveBeenCalledWith({ search: 'x', limit: 50 });
  });

  it('caps coords at SCOPE_CAP newest and flags truncation', async () => {
    const events = Array.from({ length: 250 }, (_, i) =>
      ev(30142, 'a'.repeat(64), `d${i}`, i)
    );
    const scope = await buildScope({ search: 'x' }, async () => events);
    const coords = scope.chunkFilter.event_coord as string[];
    expect(coords.length).toBe(SCOPE_CAP);
    expect(coords[0]).toBe(`30142:${'a'.repeat(64)}:d249`); // newest first
    expect(scope.truncated).toBe(true);
  });

  it('throws empty_scope on zero matches', async () => {
    await expect(buildScope({ search: 'nichts' }, async () => []))
      .rejects.toMatchObject({ code: 'empty_scope' });
  });

  it('skips non-addressable events when deriving coords', async () => {
    const regular = { ...ev(1, 'a'.repeat(64), ''), tags: [] };
    const scope = await buildScope({ search: 'x' }, async () => [regular, ev(30142, 'b'.repeat(64), 'z')]);
    expect(scope.chunkFilter.event_coord).toEqual([`30142:${'b'.repeat(64)}:z`]);
  });
});
