import { describe, it, expect } from 'vitest';
import {
  aggregateActorNames,
  rankActorCandidates,
  findActorCandidates,
} from '../../src/tools/resolvePublisher.js';
import type { NostrEvent } from 'nostr-tools';

function resourceEvent(
  id: string,
  opts: { publishers?: string[]; creators?: string[] } = {}
): NostrEvent {
  const tags: string[][] = [
    ['d', `d-${id}`],
    ['name', `Resource ${id}`],
  ];
  for (const p of opts.publishers ?? []) {
    tags.push(['publisher:name', p], ['publisher:type', 'Organization']);
  }
  for (const c of opts.creators ?? []) {
    tags.push(['creator:name', c], ['creator:type', 'Person']);
  }
  return {
    id,
    pubkey: 'a'.repeat(64),
    created_at: 1700000000,
    kind: 30142,
    tags,
    content: '',
    sig: 's',
  };
}

describe('aggregateActorNames', () => {
  it('counts publisher and creator names across resources', () => {
    const candidates = aggregateActorNames([
      { publisher: [{ name: 'LEHRE LADEN' }], creator: [{ name: 'Yvonne Behnke' }] },
      { publisher: [{ name: 'LEHRE LADEN' }] },
      { publisher: [{ name: 'e-teaching.org' }] },
    ]);
    expect(candidates).toContainEqual({ name: 'LEHRE LADEN', field: 'publisher', count: 2 });
    expect(candidates).toContainEqual({ name: 'e-teaching.org', field: 'publisher', count: 1 });
    expect(candidates).toContainEqual({ name: 'Yvonne Behnke', field: 'creator', count: 1 });
  });

  it('merges case variants of the same name, keeping the first-seen spelling', () => {
    const candidates = aggregateActorNames([
      { publisher: [{ name: 'LEHRE LADEN' }] },
      { publisher: [{ name: 'Lehre Laden' }] },
    ]);
    expect(candidates).toEqual([{ name: 'LEHRE LADEN', field: 'publisher', count: 2 }]);
  });
});

describe('rankActorCandidates', () => {
  it('ranks an exact normalized match (ignoring case and spaces) above a substring match', () => {
    const ranked = rankActorCandidates('Lehreladen', [
      { name: 'LEHRE LADEN GmbH', field: 'publisher', count: 10 },
      { name: 'LEHRE LADEN', field: 'publisher', count: 2 },
    ]);
    expect(ranked.map((c) => c.name)).toEqual(['LEHRE LADEN', 'LEHRE LADEN GmbH']);
  });

  it('drops names unrelated to the query even when frequent', () => {
    const ranked = rankActorCandidates('Lehreladen', [
      { name: 'e-teaching.org', field: 'publisher', count: 50 },
      { name: 'LEHRE LADEN', field: 'publisher', count: 2 },
    ]);
    expect(ranked).toEqual([{ name: 'LEHRE LADEN', field: 'publisher', count: 2 }]);
  });
});

describe('findActorCandidates', () => {
  it('free-text searches the relay and returns ranked matching actor names', async () => {
    const calls: Array<{ search: string; relays?: string[] }> = [];
    const client = {
      search: async (s: string, _f: object, relays?: string[]) => {
        calls.push({ search: s, relays });
        return [
          resourceEvent('r1', { publishers: ['LEHRE LADEN'] }),
          resourceEvent('r2', { publishers: ['LEHRE LADEN'] }),
          resourceEvent('r3', { publishers: ['e-teaching.org'] }),
        ];
      },
    };

    const candidates = await findActorCandidates(client, 'Lehreladen', ['wss://x']);

    expect(calls).toEqual([{ search: 'Lehreladen', relays: ['wss://x'] }]);
    expect(candidates).toEqual([{ name: 'LEHRE LADEN', field: 'publisher', count: 2 }]);
  });

  it('returns an empty list when no similar actor exists in the hits', async () => {
    const client = {
      search: async () => [resourceEvent('r1', { publishers: ['e-teaching.org'] })],
    };
    const candidates = await findActorCandidates(client, 'Lehreladen');
    expect(candidates).toEqual([]);
  });
});
