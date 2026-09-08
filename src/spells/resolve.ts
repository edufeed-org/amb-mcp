import type { Filter } from 'nostr-tools';
import { nip19 } from 'nostr-tools';
import { Spell, SpellError } from './types.js';

const UNITS: Record<string, number> = {
  s: 1, m: 60, h: 3600, d: 86400, w: 604800, mo: 2592000, y: 31536000,
};

/** 'now' | '<n><unit>' (s m h d w mo y) | absolute seconds. */
export function parseTimeValue(v: string, nowSec: number): number {
  if (v === 'now') return nowSec;
  if (/^\d+$/.test(v)) return Number.parseInt(v, 10);
  const m = /^(\d+)(mo|[smhdwy])$/.exec(v);
  if (!m) throw new SpellError('bad_time', `invalid since/until value: ${v}`);
  return nowSec - Number.parseInt(m[1], 10) * UNITS[m[2]];
}

export interface ResolveContext {
  /** Executing user's hex pubkey, when known. */
  me?: string;
  /** kind-3 p-tag expansion for $contacts. */
  fetchContacts: (pubkeyHex: string) => Promise<string[]>;
  /** Injected clock (seconds) for tests; defaults to wall time. */
  nowSec?: number;
}

function toHexPubkey(v: string): string {
  if (/^[0-9a-f]{64}$/.test(v)) return v;
  try {
    const decoded = nip19.decode(v);
    if (decoded.type === 'npub') return decoded.data;
  } catch {
    throw new SpellError('bad_pubkey', `not a pubkey: ${v}`);
  }
  throw new SpellError('bad_pubkey', `not a pubkey: ${v}`);
}

/** Resolve variables + relative times into a concrete NIP-01 filter. */
export async function resolveSpell(spell: Spell, ctx: ResolveContext): Promise<Filter> {
  const nowSec = ctx.nowSec ?? Math.floor(Date.now() / 1000);
  const filter: Filter = {};

  if (spell.kinds?.length) filter.kinds = spell.kinds;
  if (spell.ids?.length) filter.ids = spell.ids;
  if (spell.search) filter.search = spell.search;
  if (spell.since) filter.since = parseTimeValue(spell.since, nowSec);
  if (spell.until) filter.until = parseTimeValue(spell.until, nowSec);
  if (spell.limit !== undefined) filter.limit = spell.limit;
  for (const tf of spell.tagFilters ?? []) {
    (filter as Record<string, unknown>)[`#${tf.letter}`] = tf.values;
  }

  if (spell.authors?.length) {
    const authors: string[] = [];
    for (const a of spell.authors) {
      if (a === '$me') {
        if (!ctx.me) {
          throw new SpellError(
            'me_unresolvable',
            'spell uses $me but the caller is unknown — pass the `me` parameter (npub or hex)'
          );
        }
        authors.push(ctx.me);
      } else if (a === '$contacts') {
        if (!ctx.me) {
          throw new SpellError(
            'me_unresolvable',
            'spell uses $contacts but the caller is unknown — pass the `me` parameter (npub or hex)'
          );
        }
        const contacts = await ctx.fetchContacts(ctx.me);
        if (contacts.length === 0) {
          throw new SpellError('contacts_empty', 'no kind-3 contact list found for the caller');
        }
        authors.push(...contacts);
      } else {
        authors.push(toHexPubkey(a));
      }
    }
    filter.authors = authors;
  }
  return filter;
}
