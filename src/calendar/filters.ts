import type { Filter } from 'nostr-tools';

/**
 * Parameters for searching NIP-52 calendar events.
 *
 * Extended tag filters (#start_after, etc.) are supported by the calendar relay protocol.
 * Standard relays will ignore them.
 */
export interface CalendarSearchParams {
  /** Unix timestamp — only events starting after this time */
  startAfter?: number;
  /** Unix timestamp — only events starting before this time */
  startBefore?: number;
  /** Unix timestamp — only events ending after this time */
  endAfter?: number;
  /** Unix timestamp — only events ending before this time */
  endBefore?: number;
  /** Geohash prefix for location-based search */
  geohash?: string;
  /** Hashtag filters */
  hashtags?: string[];
  /** Filter by author pubkeys */
  authors?: string[];
  /** Event kinds (default: [31922, 31923]) */
  kinds?: number[];
  /** NIP-01 created_at since */
  since?: number;
  /** NIP-01 created_at until */
  until?: number;
  /** Maximum number of results (1-250, default: 20) */
  limit?: number;
  /** Free-text topic (NIP-50 search on the calendar collection). */
  query?: string;
}

/**
 * Build a Nostr filter for NIP-52 calendar event queries.
 *
 * Extended filters are standard Nostr tag filters passed through as-is.
 * Relays supporting the calendar relay protocol will index them.
 */
export function buildCalendarFilter(params: CalendarSearchParams): Filter {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 250);
  const kinds = params.kinds ?? [31922, 31923];

  const filter: Filter = { kinds, limit };

  if (params.query?.trim()) {
    filter.search = params.query.trim();
  }

  if (params.authors?.length) {
    filter.authors = params.authors;
  }
  if (params.since !== undefined) {
    filter.since = params.since;
  }
  if (params.until !== undefined) {
    filter.until = params.until;
  }

  // Extended tag filters for calendar relay protocol
  if (params.startAfter !== undefined) {
    (filter as Record<string, unknown>)['#start_after'] = [String(params.startAfter)];
  }
  if (params.startBefore !== undefined) {
    (filter as Record<string, unknown>)['#start_before'] = [String(params.startBefore)];
  }
  if (params.endAfter !== undefined) {
    (filter as Record<string, unknown>)['#end_after'] = [String(params.endAfter)];
  }
  if (params.endBefore !== undefined) {
    (filter as Record<string, unknown>)['#end_before'] = [String(params.endBefore)];
  }
  if (params.geohash) {
    (filter as Record<string, unknown>)['#g'] = [params.geohash];
  }
  if (params.hashtags?.length) {
    filter['#t'] = params.hashtags;
  }

  return filter;
}
