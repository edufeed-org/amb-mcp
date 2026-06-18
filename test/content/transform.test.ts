import { describe, it, expect } from 'vitest';
import {
  transformContentEvent,
  transformContentEvents,
} from '../../src/content/transform.js';
import type { NostrEvent } from 'nostr-tools';

function evt(kind: number, tags: string[][], content = ''): NostrEvent {
  return {
    id: `id-${kind}`,
    pubkey: 'a'.repeat(64),
    created_at: 1700000000,
    kind,
    tags,
    content,
    sig: 'sig',
  };
}

describe('transformContentEvent — article (30023)', () => {
  it('projects title, summary, topics, publishedAt, image and an excerpt', () => {
    const e = evt(
      30023,
      [
        ['d', 'attention-1'],
        ['title', 'Aufmerksamkeit im Seminar'],
        ['summary', 'Tipps gegen Unaufmerksamkeit'],
        ['image', 'https://example.org/a.png'],
        ['published_at', '1699990000'],
        ['t', 'didaktik'],
        ['t', 'hochschule'],
      ],
      'Studien zeigen, dass die Aufmerksamkeit alle 10-15 Minuten nachlässt.'
    );
    const r = transformContentEvent(e, 'de');
    expect(r).not.toBeNull();
    expect(r!.type).toBe('article');
    expect(r!.kind).toBe(30023);
    expect(r!.title).toBe('Aufmerksamkeit im Seminar');
    expect((r as any).summary).toBe('Tipps gegen Unaufmerksamkeit');
    expect((r as any).image).toBe('https://example.org/a.png');
    expect((r as any).publishedAt).toBe(1699990000);
    expect((r as any).topics).toEqual(['didaktik', 'hochschule']);
    expect((r as any).excerpt).toContain('Aufmerksamkeit');
    expect(r!.eventAuthor.pubkey).toBe('a'.repeat(64));
    expect(r!.eventAuthor.npub).toMatch(/^npub1/);
    expect(r!.createdAt).toBe(1700000000);
  });

  it('returns null when title is missing', () => {
    expect(transformContentEvent(evt(30023, [['d', 'x']]), 'de')).toBeNull();
  });
});

describe('transformContentEvent — wiki (30818)', () => {
  it('projects title, summary and excerpt from Djot content', () => {
    const e = evt(
      30818,
      [
        ['d', 'seminar'],
        ['title', 'Seminar'],
        ['summary', 'Lehrformat'],
        ['t', 'lehre'],
      ],
      'Ein Seminar ist eine Lehrveranstaltung.'
    );
    const r = transformContentEvent(e, 'de');
    expect(r!.type).toBe('wiki');
    expect(r!.kind).toBe(30818);
    expect(r!.title).toBe('Seminar');
    expect((r as any).summary).toBe('Lehrformat');
    expect((r as any).topics).toEqual(['lehre']);
    expect((r as any).excerpt).toContain('Lehrveranstaltung');
  });

  it('returns null when d tag is missing', () => {
    expect(transformContentEvent(evt(30818, [['title', 'No d']]), 'de')).toBeNull();
  });

  it('falls back to summary when title tag is absent', () => {
    const e = evt(
      30818,
      [
        ['d', 'titleless-wiki'],
        ['summary', 'A fallback summary'],
      ],
      'Some wiki content.'
    );
    const r = transformContentEvent(e, 'de');
    expect(r).not.toBeNull();
    expect(r!.type).toBe('wiki');
    expect(r!.title).toBe('A fallback summary');
  });

  it('falls back to d-tag value when both title and summary are absent', () => {
    const e = evt(
      30818,
      [['d', 'd-only-wiki']],
      'Content without title or summary.'
    );
    const r = transformContentEvent(e, 'de');
    expect(r).not.toBeNull();
    expect(r!.type).toBe('wiki');
    expect(r!.title).toBe('d-only-wiki');
  });

  it('sets eventAuthor.npub for a wiki', () => {
    const r = transformContentEvent(evt(30818, [['d', 'w'], ['title', 'W']], 'body'), 'de');
    expect(r!.eventAuthor.pubkey).toBe('a'.repeat(64));
    expect(r!.eventAuthor.npub).toMatch(/^npub1/);
  });
});

describe('transformContentEvent — resource (30142)', () => {
  it('projects an AMB resource into a resource result', () => {
    const e = evt(30142, [
      ['d', 'res-1'],
      ['name', 'Mathe Video'],
      ['description', 'Ein Video'],
      ['about:id', 'https://w3id.org/kim/schulfaecher/s1017'],
    ]);
    const r = transformContentEvent(e, 'de');
    expect(r!.type).toBe('resource');
    expect(r!.kind).toBe(30142);
    expect(r!.title).toBe('Mathe Video');
    expect((r as any).description).toBe('Ein Video');
  });

  it('surfaces resource publisher/creator distinct from the event signer', () => {
    const e = evt(30142, [
      ['d', 'res-2'],
      ['name', 'Friedensbildung in Schule und Gemeinde'],
      ['publisher:name', 'ptz Stuttgart'],
      ['publisher:type', 'Organization'],
    ]);
    const r = transformContentEvent(e, 'de');
    expect(r!.type).toBe('resource');
    expect((r as any).publisher).toEqual([{ name: 'ptz Stuttgart', type: 'Organization' }]);
    // No creator tags → empty array (mirrors get_resource output).
    expect((r as any).creator).toEqual([]);
    // The event signer is the uploader, NOT the publisher.
    expect(r!.eventAuthor.pubkey).toBe('a'.repeat(64));
  });
});

describe('transformContentEvent — unknown kind', () => {
  it('returns null for an unregistered kind', () => {
    expect(transformContentEvent(evt(1, [['d', 'x']]), 'de')).toBeNull();
  });
});

describe('transformContentEvents', () => {
  it('skips nulls and preserves order', () => {
    const ok = evt(30023, [['d', 'a'], ['title', 'A']], 'body');
    const bad = evt(30023, [['d', 'b']]); // no title
    const results = transformContentEvents([ok, bad], 'de');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('A');
  });
});

describe('excerpt capping', () => {
  it('caps long content and appends an ellipsis', () => {
    const long = 'x'.repeat(500);
    const r = transformContentEvent(evt(30023, [['d', 'l'], ['title', 'L']], long), 'de');
    const ex = (r as any).excerpt as string;
    expect(ex.length).toBeLessThanOrEqual(301);
    expect(ex.endsWith('…')).toBe(true);
  });
});
