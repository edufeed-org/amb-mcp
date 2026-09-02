import { SPELL_KIND, Spell, SpellError, SpellTagFilter } from './types.js';
import type { Event as NostrEvent } from 'nostr-tools';

const FILTER_KEYS = ['kinds', 'authors', 'ids', 'tagFilters', 'search', 'since', 'until'] as const;

/** Parse a kind-777 event into the internal Spell representation. */
export function parseSpellEvent(event: NostrEvent): Spell {
  if (event.kind !== SPELL_KIND) {
    throw new SpellError('not_a_spell', `event kind ${event.kind} is not a spell (777)`);
  }
  let cmd: string | undefined;
  const spell: Spell = { cmd: 'REQ' };
  const kinds: number[] = [];
  const tagFilters: SpellTagFilter[] = [];

  for (const tag of event.tags) {
    const [t, ...rest] = tag;
    switch (t) {
      case 'cmd':
        cmd = rest[0];
        break;
      case 'name':
        spell.name = rest[0];
        break;
      case 'k': {
        const k = Number.parseInt(rest[0], 10);
        if (Number.isFinite(k)) kinds.push(k);
        break;
      }
      case 'authors':
        spell.authors = [...(spell.authors ?? []), ...rest];
        break;
      case 'ids':
        spell.ids = [...(spell.ids ?? []), ...rest];
        break;
      case 'tag':
        if (rest.length >= 2) tagFilters.push({ letter: rest[0], values: rest.slice(1) });
        break;
      case 'search':
        spell.search = rest[0];
        break;
      case 'since':
        spell.since = rest[0];
        break;
      case 'until':
        spell.until = rest[0];
        break;
      case 'limit': {
        const n = Number.parseInt(rest[0], 10);
        if (Number.isFinite(n)) spell.limit = n;
        break;
      }
      case 'relays':
        spell.relays = rest;
        break;
      default:
        break; // 't' topic tags, 'alt', 'client', 'e' fork refs — metadata, not filters
    }
  }

  if (cmd === 'COUNT') {
    throw new SpellError('count_not_groundable', 'COUNT spells return a number — nothing to ground on');
  }
  if (cmd !== 'REQ') {
    throw new SpellError('not_a_spell', 'missing or unsupported cmd tag (expected REQ)');
  }
  if (kinds.length > 0) spell.kinds = kinds;
  if (tagFilters.length > 0) spell.tagFilters = tagFilters;
  if (event.content) spell.description = event.content;

  const hasFilter = FILTER_KEYS.some((k) => spell[k] !== undefined);
  if (!hasFilter) {
    throw new SpellError('no_filter', 'spell has no filter tags — nothing to select');
  }
  return spell;
}
