import { describe, it, expect, vi } from 'vitest';
import { parseTimeValue, resolveSpell } from '../../src/spells/resolve.js';
import { spellFromParams } from '../../src/spells/parse.js';
import { nip19 } from 'nostr-tools';

const NOW = 1_760_000_000;
const ME = 'a'.repeat(64);
const noContacts = async () => [];

describe('parseTimeValue', () => {
  it('resolves now, relative units, and absolutes', () => {
    expect(parseTimeValue('now', NOW)).toBe(NOW);
    expect(parseTimeValue('7d', NOW)).toBe(NOW - 7 * 86400);
    expect(parseTimeValue('1mo', NOW)).toBe(NOW - 30 * 86400);
    expect(parseTimeValue('2h', NOW)).toBe(NOW - 7200);
    expect(parseTimeValue('1700000000', NOW)).toBe(1700000000);
  });
  it('rejects garbage', () => {
    expect(() => parseTimeValue('$now-7d', NOW)).toThrowError(
      expect.objectContaining({ code: 'bad_time' })
    );
  });
});

describe('resolveSpell', () => {
  it('maps spell fields onto a NIP-01 filter', async () => {
    const spell = spellFromParams({
      kinds: [30142], search: 'klima', since: '7d',
      tag: { letter: 'h', values: ['e'.repeat(64)] },
    });
    const f = await resolveSpell(spell, { fetchContacts: noContacts, nowSec: NOW });
    expect(f).toEqual({
      kinds: [30142], search: 'klima', since: NOW - 7 * 86400,
      '#h': ['e'.repeat(64)],
    });
  });

  it('resolves $me and npub authors to hex', async () => {
    const npub = nip19.npubEncode('b'.repeat(64));
    const spell = spellFromParams({ authors: ['$me', npub] });
    const f = await resolveSpell(spell, { me: ME, fetchContacts: noContacts, nowSec: NOW });
    expect(f.authors).toEqual([ME, 'b'.repeat(64)]);
  });

  it('errors when $me is unresolvable', async () => {
    const spell = spellFromParams({ authors: ['$me'] });
    await expect(resolveSpell(spell, { fetchContacts: noContacts, nowSec: NOW }))
      .rejects.toMatchObject({ code: 'me_unresolvable' });
  });

  it('expands $contacts via the fetcher', async () => {
    const contacts = ['c'.repeat(64), 'd'.repeat(64)];
    const fetchContacts = vi.fn(async () => contacts);
    const spell = spellFromParams({ authors: ['$contacts'] });
    const f = await resolveSpell(spell, { me: ME, fetchContacts, nowSec: NOW });
    expect(fetchContacts).toHaveBeenCalledWith(ME);
    expect(f.authors).toEqual(contacts);
  });

  it('errors on empty $contacts (spec: MUST NOT send)', async () => {
    const spell = spellFromParams({ authors: ['$contacts'] });
    await expect(resolveSpell(spell, { me: ME, fetchContacts: noContacts, nowSec: NOW }))
      .rejects.toMatchObject({ code: 'contacts_empty' });
  });

  it('carries the spell limit into the filter', async () => {
    const spell = { ...spellFromParams({ kinds: [30142] }), limit: 50 };
    const f = await resolveSpell(spell, { fetchContacts: noContacts, nowSec: NOW });
    expect(f.limit).toBe(50);
  });

  it('rejects malformed author strings with bad_pubkey', async () => {
    const spell = spellFromParams({ authors: ['garbage-not-a-key'] });
    await expect(resolveSpell(spell, { fetchContacts: noContacts, nowSec: NOW }))
      .rejects.toMatchObject({ code: 'bad_pubkey' });
  });
});
