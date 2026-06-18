import { describe, it, expect } from 'vitest';
import { parseSnippets, attachSnippets, SNIPPET_KIND } from '../../src/content/snippet.js';
import type { NostrEvent } from 'nostr-tools';
import type { ArticleResult } from '../../src/content/types.js';

function snippetEvent(parentId: string, content: string, tags: string[][] = []): NostrEvent {
  return {
    id: `snip-${parentId}`,
    pubkey: 'relay',
    created_at: 1700000000,
    kind: SNIPPET_KIND,
    tags: [['e', parentId], ['a', `30023:pk:${parentId}`], ['k', '30023'], ...tags],
    content,
    sig: 'sig',
  };
}

function contentEvent(id: string): NostrEvent {
  return { id, pubkey: 'pk', created_at: 1, kind: 30023, tags: [], content: '', sig: 's' };
}

function articleResult(): ArticleResult {
  return { type: 'article', kind: 30023, title: 'T', eventAuthor: { pubkey: 'pk' }, createdAt: 1 };
}

describe('parseSnippets', () => {
  it('parses content, score and locators keyed by parent e tag', () => {
    const map = parseSnippets([
      snippetEvent('parent1', 'matched passage', [
        ['score', '0.8200'],
        ['page', '12'],
        ['heading', 'Aufmerksamkeit'],
        ['source_url', 'https://example.org/p.pdf'],
      ]),
    ]);
    const s = map.get('parent1')!;
    expect(s.passage).toBe('matched passage');
    expect(s.score).toBeCloseTo(0.82);
    expect(s.page).toBe(12);
    expect(s.heading).toBe('Aufmerksamkeit');
    expect(s.sourceUrl).toBe('https://example.org/p.pdf');
  });

  it('keeps the higher score when a parent has duplicate snippets', () => {
    const map = parseSnippets([
      snippetEvent('p', 'low', [['score', '0.10']]),
      snippetEvent('p', 'high', [['score', '0.90']]),
    ]);
    expect(map.get('p')!.passage).toBe('high');
  });

  it('ignores snippet events with no e tag', () => {
    const noE: NostrEvent = {
      id: 'x', pubkey: 'r', created_at: 1, kind: SNIPPET_KIND,
      tags: [['score', '0.5']], content: 'orphan', sig: 's',
    };
    expect(parseSnippets([noE]).size).toBe(0);
  });
});

describe('attachSnippets', () => {
  it('attaches the snippet to the result whose event id matches', () => {
    const results = [articleResult()];
    const events = [contentEvent('parent1')];
    const map = parseSnippets([
      snippetEvent('parent1', 'the passage', [['score', '0.7'], ['heading', 'H']]),
    ]);
    attachSnippets(results, events, map);
    expect(results[0].snippet).toBe('the passage');
    expect(results[0].score).toBeCloseTo(0.7);
    expect(results[0].heading).toBe('H');
  });

  it('leaves a result without a matching snippet untouched', () => {
    const results = [articleResult()];
    const events = [contentEvent('lonely')];
    attachSnippets(results, events, new Map());
    expect(results[0].snippet).toBeUndefined();
  });
});
