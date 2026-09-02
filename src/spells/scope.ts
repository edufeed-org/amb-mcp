import type { Event as NostrEvent, Filter } from 'nostr-tools';
import { SpellError } from './types.js';

export const SCOPE_CAP = 200;
export const MATERIALIZE_REQ_LIMIT = 500;

export interface ScopeResult {
  mode: 'passthrough' | 'materialized';
  /** Body for /search_chunks `filter` — pubkey/kinds or event_coord. */
  chunkFilter: Record<string, unknown>;
  eventsInScope?: number;
  truncated: boolean;
}

function isPassthrough(filter: Filter): boolean {
  return Object.entries(filter).every(
    ([k, v]) => v === undefined || k === 'kinds' || k === 'authors' || k === 'limit'
  );
}

function coordOf(e: NostrEvent): string | null {
  if (e.kind < 30000 || e.kind >= 40000) return null;
  const d = e.tags.find((t) => t[0] === 'd')?.[1];
  if (d === undefined) return null;
  return `${e.kind}:${e.pubkey}:${d}`;
}

/**
 * Turn a resolved NIP-01 filter into a /search_chunks scope. Authors/kinds-only
 * filters pass through; anything else materializes via one relay REQ.
 */
export async function buildScope(
  filter: Filter,
  queryEvents: (f: Filter) => Promise<NostrEvent[]>
): Promise<ScopeResult> {
  if (isPassthrough(filter)) {
    const chunkFilter: Record<string, unknown> = {};
    let truncated = false;
    if (filter.kinds?.length) chunkFilter.kinds = filter.kinds;
    if (filter.authors?.length) {
      truncated = filter.authors.length > SCOPE_CAP;
      chunkFilter.pubkey = filter.authors.slice(0, SCOPE_CAP);
    }
    if (!Object.keys(chunkFilter).length) {
      throw new SpellError('no_filter', 'resolved filter selects nothing — no kinds or authors');
    }
    return { mode: 'passthrough', chunkFilter, truncated };
  }

  const limit = Math.min(filter.limit ?? MATERIALIZE_REQ_LIMIT, MATERIALIZE_REQ_LIMIT);
  const events = await queryEvents({ ...filter, limit });

  const seen = new Set<string>();
  const withCoord: { coord: string; created_at: number }[] = [];
  for (const e of events) {
    const coord = coordOf(e);
    if (!coord || seen.has(coord)) continue;
    seen.add(coord);
    withCoord.push({ coord, created_at: e.created_at });
  }
  if (withCoord.length === 0) {
    throw new SpellError('empty_scope', 'spell matched no events on the relay — nothing to ground on');
  }
  withCoord.sort((a, b) => b.created_at - a.created_at);
  const truncated = withCoord.length > SCOPE_CAP;
  return {
    mode: 'materialized',
    chunkFilter: { event_coord: withCoord.slice(0, SCOPE_CAP).map((c) => c.coord) },
    eventsInScope: withCoord.length,
    truncated,
  };
}
