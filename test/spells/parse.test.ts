import { describe, it, expect } from 'vitest';
import { parseSpellEvent } from '../../src/spells/parse.js';
import { SpellError, SPELL_KIND } from '../../src/spells/types.js';
import type { Event as NostrEvent } from 'nostr-tools';

function spellEvent(tags: string[][], content = 'A spell'): NostrEvent {
  return {
    id: 'a'.repeat(64),
    pubkey: 'b'.repeat(64),
    created_at: 1700000000,
    kind: SPELL_KIND,
    tags,
    content,
    sig: 'c'.repeat(128),
  };
}

describe('parseSpellEvent', () => {
  it('parses the canonical grimoire example', () => {
    const s = parseSpellEvent(
      spellEvent([
        ['cmd', 'REQ'],
        ['name', 'Bitcoin from contacts'],
        ['k', '1'],
        ['authors', '$contacts'],
        ['tag', 't', 'bitcoin'],
        ['since', '7d'],
        ['limit', '50'],
        ['t', 'bitcoin'], // topic tag on the spell itself — NOT a filter
      ])
    );
    expect(s.cmd).toBe('REQ');
    expect(s.name).toBe('Bitcoin from contacts');
    expect(s.kinds).toEqual([1]);
    expect(s.authors).toEqual(['$contacts']);
    expect(s.tagFilters).toEqual([{ letter: 't', values: ['bitcoin'] }]);
    expect(s.since).toBe('7d');
    expect(s.limit).toBe(50);
    expect(s.description).toBe('A spell');
  });

  it('merges multiple k tags and keeps authors multi-value', () => {
    const s = parseSpellEvent(
      spellEvent([
        ['cmd', 'REQ'],
        ['k', '30142'],
        ['k', '30023'],
        ['authors', 'a'.repeat(64), 'b'.repeat(64)],
      ])
    );
    expect(s.kinds).toEqual([30142, 30023]);
    expect(s.authors).toHaveLength(2);
  });

  it('rejects a non-777 event', () => {
    const ev = { ...spellEvent([['cmd', 'REQ'], ['k', '1']]), kind: 1 };
    expect(() => parseSpellEvent(ev)).toThrowError(
      expect.objectContaining({ code: 'not_a_spell' })
    );
  });

  it('rejects a missing cmd tag', () => {
    expect(() => parseSpellEvent(spellEvent([['k', '1']]))).toThrowError(
      expect.objectContaining({ code: 'not_a_spell' })
    );
  });

  it('rejects COUNT spells as not groundable', () => {
    expect(() =>
      parseSpellEvent(spellEvent([['cmd', 'COUNT'], ['k', '1']]))
    ).toThrowError(expect.objectContaining({ code: 'count_not_groundable' }));
  });

  it('rejects a spell with no filter tags', () => {
    expect(() =>
      parseSpellEvent(spellEvent([['cmd', 'REQ'], ['name', 'empty']]))
    ).toThrowError(expect.objectContaining({ code: 'no_filter' }));
  });

  it('parses search, until, ids and relays tags', () => {
    const s = parseSpellEvent(
      spellEvent([
        ['cmd', 'REQ'],
        ['search', 'mathematik'],
        ['until', 'now'],
        ['ids', 'f'.repeat(64)],
        ['relays', 'wss://relay.edufeed.org'],
      ])
    );
    expect(s.search).toBe('mathematik');
    expect(s.until).toBe('now');
    expect(s.ids).toEqual(['f'.repeat(64)]);
    expect(s.relays).toEqual(['wss://relay.edufeed.org']);
  });
});
