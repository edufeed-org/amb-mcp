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
 * amb-relay's query builder only maps a handful of tag names (#t/#r/#p/#a/#h
 * + ns:facet shapes) — any other `#<letter>` filter is silently ignored
 * server-side, so a materialized REQ for e.g. `#doi` comes back with every
 * event the relay has, not just matches. Re-check every tag filter in the
 * resolved filter client-side before an event is allowed into scope:
 * standard NIP-01 semantics (OR within one letter's values, AND across
 * letters).
 */
function matchesTagFilters(e: NostrEvent, filter: Filter): boolean {
  for (const key of Object.keys(filter)) {
    if (!key.startsWith('#')) continue;
    const values = (filter as Record<string, string[] | undefined>)[key];
    if (!values || values.length === 0) continue;
    const letter = key.slice(1);
    const ok = e.tags.some((t) => t[0] === letter && values.includes(t[1]));
    if (!ok) return false;
  }
  return true;
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
  const matched = events.filter((e) => matchesTagFilters(e, filter));

  const seen = new Set<string>();
  const withCoord: { coord: string; created_at: number }[] = [];
  for (const e of matched) {
    const coord = coordOf(e);
    if (!coord || seen.has(coord)) continue;
    seen.add(coord);
    withCoord.push({ coord, created_at: e.created_at });
  }
  if (withCoord.length === 0) {
    throw new SpellError('empty_scope', 'the relay answered but the spell matched no events — nothing to ground on (an unreachable relay is reported as relay_unreachable, not this)');
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
