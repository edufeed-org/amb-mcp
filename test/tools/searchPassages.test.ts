import { describe, it, expect, vi } from 'vitest';
import { runSearchPassages } from '../../src/tools/searchPassages.js';
import type { Event as NostrEvent } from 'nostr-tools';

const RELAY = 'wss://relay.edufeed.org';
const HIT = { chunk_id: 'c1', event_id: 'e1', event_coord: `30142:${'a'.repeat(64)}:d1`, chunk_idx: 0, snippet: 'Klimawandel …', score: 0.91 };

function deps(overrides: Partial<Parameters<typeof runSearchPassages>[0]> = {}) {
  return {
    queryContentEvents: vi.fn(async () => [] as NostrEvent[]),
    fetchSpellEvent: vi.fn(async () => null as NostrEvent | null),
    fetchContacts: vi.fn(async () => [] as string[]),
    searchChunks: vi.fn(async () => ({ hits: [HIT], total: 1 })),
    relay: RELAY,
    ...overrides,
  };
}

describe('runSearchPassages', () => {
  it('inline kinds scope → passthrough → passages + canonical spell', async () => {
    const d = deps();
    const out = await runSearchPassages(d, { question: 'klimawandel', kinds: [30142] }, undefined);
    expect(d.searchChunks).toHaveBeenCalledWith(RELAY, {
      q: 'klimawandel', k: 10, filter: { kinds: [30142] },
    });
    expect(out.passages).toHaveLength(1);
    expect(out.scope.mode).toBe('passthrough');
    expect(out.scope.spell.tags).toContainEqual(['cmd', 'REQ']);
    expect(out.scope.spell.tags).toContainEqual(['k', '30142']);
  });

  it('published spell → fetch, parse, materialize, ground', async () => {
    const spellEvent: NostrEvent = {
      id: '1'.repeat(64), pubkey: '2'.repeat(64), created_at: 1, kind: 777, sig: 's',
      content: 'Klima im Unterricht',
      tags: [['cmd', 'REQ'], ['k', '30142'], ['search', 'klima']],
    };
    const content: NostrEvent = {
      id: '3'.repeat(64), pubkey: 'a'.repeat(64), created_at: 5, kind: 30142, sig: 's',
      content: '', tags: [['d', 'd1']],
    };
    const d = deps({
      fetchSpellEvent: vi.fn(async () => spellEvent),
      queryContentEvents: vi.fn(async () => [content]),
    });
    const out = await runSearchPassages(d, { question: 'ursachen', spell: '1'.repeat(64) }, undefined);
    expect(d.queryContentEvents).toHaveBeenCalledWith(
      expect.objectContaining({ kinds: [30142], search: 'klima', limit: 500 })
    );
    expect(d.searchChunks).toHaveBeenCalledWith(RELAY, expect.objectContaining({
      filter: { event_coord: [`30142:${'a'.repeat(64)}:d1`] },
    }));
    expect(out.scope.spell_event_id).toBe('1'.repeat(64));
    expect(out.scope.events_in_scope).toBe(1);
  });

  it('rejects spell + inline scope together', async () => {
    const out = runSearchPassages(deps(), { question: 'q', spell: '1'.repeat(64), kinds: [1] }, undefined);
    await expect(out).rejects.toMatchObject({ code: 'no_filter' });
  });

  it('spell not found → spell_not_found naming the relays', async () => {
    const out = runSearchPassages(deps(), { question: 'q', spell: '1'.repeat(64) }, undefined);
    await expect(out).rejects.toMatchObject({ code: 'spell_not_found' });
  });

  it('$me comes from ContextVM clientPubkey when no me param', async () => {
    const d = deps();
    await runSearchPassages(
      d,
      { question: 'q', authors: ['$me'] },
      { authInfo: { clientPubkey: 'a'.repeat(64) } }
    );
    expect(d.searchChunks).toHaveBeenCalledWith(RELAY, expect.objectContaining({
      filter: { pubkey: ['a'.repeat(64)] },
    }));
  });

  it('empty scope propagates as a structured error, never unscoped search', async () => {
    const d = deps({ queryContentEvents: vi.fn(async () => []) });
    const out = runSearchPassages(d, { question: 'q', search: 'nichts' }, undefined);
    await expect(out).rejects.toMatchObject({ code: 'empty_scope' });
    expect(d.searchChunks).not.toHaveBeenCalled();
  });

  it('a malformed me param never throws a raw bech32 decode error — rejects as me_unresolvable', async () => {
    const out = runSearchPassages(deps(), { question: 'q', me: 'not-bech32!!', kinds: [1] }, undefined);
    await expect(out).rejects.toMatchObject({ code: 'me_unresolvable' });
  });

  it('a malformed spell ref never throws a raw bech32 decode error — rejects as spell_not_found', async () => {
    const out = runSearchPassages(deps(), { question: 'q', spell: 'not-bech32!!' }, undefined);
    await expect(out).rejects.toMatchObject({ code: 'spell_not_found' });
  });

  it('a tag param with an empty values array is treated as absent, not a vacuous filter', async () => {
    const d = deps();
    const out = runSearchPassages(
      d,
      { question: 'q', tag: { letter: 'h', values: [] } },
      undefined
    );
    await expect(out).rejects.toMatchObject({ code: 'no_filter' });
  });
});
