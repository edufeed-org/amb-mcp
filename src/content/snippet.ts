import type { NostrEvent } from 'nostr-tools';
import type { SimplifiedContentResult } from './types.js';

/** Ephemeral kind carrying the best matching fulltext passage for a result. */
export const SNIPPET_KIND = 21142;

export interface ParsedSnippet {
  eventId: string;
  passage: string;
  score?: number;
  page?: number;
  heading?: string;
  sourceUrl?: string;
}

function tag(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

/**
 * Index kind-21142 snippet events by their parent event id (`e` tag). When a
 * parent has more than one snippet, the higher-scored passage wins.
 */
export function parseSnippets(events: NostrEvent[]): Map<string, ParsedSnippet> {
  const map = new Map<string, ParsedSnippet>();
  for (const e of events) {
    if (e.kind !== SNIPPET_KIND) continue;
    const parentId = tag(e, 'e');
    if (!parentId) continue;
    const scoreRaw = tag(e, 'score');
    const pageRaw = tag(e, 'page');
    const headingRaw = tag(e, 'heading');
    const sourceUrlRaw = tag(e, 'source_url');
    const parsed: ParsedSnippet = { eventId: parentId, passage: e.content };
    if (scoreRaw !== undefined && scoreRaw !== '') {
      const n = Number(scoreRaw);
      if (!Number.isNaN(n)) parsed.score = n;
    }
    if (pageRaw && /^\d+$/.test(pageRaw)) parsed.page = Number(pageRaw);
    if (headingRaw) parsed.heading = headingRaw;
    if (sourceUrlRaw) parsed.sourceUrl = sourceUrlRaw;

    const existing = map.get(parentId);
    if (!existing || (parsed.score ?? 0) > (existing.score ?? 0)) {
      map.set(parentId, parsed);
    }
  }
  return map;
}

/**
 * Attach each parsed snippet to the result whose originating event id matches.
 * `results[i]` must correspond to `contentEvents[i]`. Mutates and returns
 * `results`.
 */
export function attachSnippets(
  results: SimplifiedContentResult[],
  contentEvents: NostrEvent[],
  snippets: Map<string, ParsedSnippet>
): SimplifiedContentResult[] {
  for (let i = 0; i < results.length && i < contentEvents.length; i++) {
    const s = snippets.get(contentEvents[i].id);
    if (!s) continue;
    results[i].snippet = s.passage;
    if (s.score !== undefined) results[i].score = s.score;
    if (s.page !== undefined) results[i].page = s.page;
    if (s.heading !== undefined) results[i].heading = s.heading;
    if (s.sourceUrl !== undefined) results[i].sourceUrl = s.sourceUrl;
  }
  return results;
}
