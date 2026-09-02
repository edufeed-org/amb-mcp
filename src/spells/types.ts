import type { Event as NostrEvent } from 'nostr-tools';

export const SPELL_KIND = 777;

export interface SpellTagFilter {
  letter: string; // e.g. 't' — filter becomes {"#t": values}
  values: string[];
}

/**
 * Internal representation of a kind-777 spell (grimoire draft NIP).
 * since/until stay RAW strings here ('7d', 'now', '1700000000') —
 * resolution to absolute timestamps happens in resolve.ts.
 */
export interface Spell {
  cmd: 'REQ';
  name?: string;
  description?: string;
  kinds?: number[];
  authors?: string[]; // may contain '$me' / '$contacts' / npub / hex
  ids?: string[];
  tagFilters?: SpellTagFilter[];
  search?: string;
  since?: string;
  until?: string;
  limit?: number;
  relays?: string[];
}

export type SpellErrorCode =
  | 'not_a_spell'
  | 'count_not_groundable'
  | 'no_filter'
  | 'bad_time'
  | 'me_unresolvable'
  | 'contacts_empty'
  | 'spell_not_found'
  | 'empty_scope'
  | 'no_indexer'
  | 'indexer_error';

export class SpellError extends Error {
  constructor(
    public readonly code: SpellErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'SpellError';
  }
}

export type { NostrEvent };
