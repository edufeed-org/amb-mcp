import type { NostrEvent } from 'nostr-tools';
import {
  eventToAMBResource,
  toSimplifiedResource,
  encodeNaddrAndUrl,
} from '../utils/transform.js';
import type {
  SimplifiedContentResult,
  ResourceResult,
  ArticleResult,
  WikiResult,
} from './types.js';

const EXCERPT_MAX = 300;

function tag(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

function tagValues(event: NostrEvent, name: string): string[] {
  return event.tags.filter((t) => t[0] === name).map((t) => t[1]).filter(Boolean);
}

/** Collapse whitespace and cap to EXCERPT_MAX chars, appending an ellipsis. */
function excerpt(content: string): string | undefined {
  const text = content.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > EXCERPT_MAX ? text.slice(0, EXCERPT_MAX) + '…' : text;
}

function resourceToContentResult(event: NostrEvent, language: string): ResourceResult | null {
  const amb = eventToAMBResource(event);
  if (!amb) return null;
  const s = toSimplifiedResource(amb, language);
  return {
    type: 'resource',
    kind: 30142,
    title: s.name,
    description: s.description,
    url: s.url,
    naddr: s.nostr.naddr,
    about: s.about,
    learningResourceType: s.learningResourceType,
    educationalLevel: s.educationalLevel,
    author: { pubkey: event.pubkey },
    createdAt: event.created_at,
  };
}

function articleToContentResult(event: NostrEvent): ArticleResult | null {
  const d = tag(event, 'd');
  const title = tag(event, 'title');
  if (!d || !title) return null;
  const { naddr, url } = encodeNaddrAndUrl(event.kind, event.pubkey, d);
  const publishedAtRaw = tag(event, 'published_at');
  const topics = tagValues(event, 't');
  const result: ArticleResult = {
    type: 'article',
    kind: 30023,
    title,
    naddr,
    url,
    author: { pubkey: event.pubkey },
    createdAt: event.created_at,
  };
  const summary = tag(event, 'summary');
  if (summary) result.summary = summary;
  const image = tag(event, 'image');
  if (image) result.image = image;
  if (publishedAtRaw && /^\d+$/.test(publishedAtRaw)) result.publishedAt = Number(publishedAtRaw);
  if (topics.length) result.topics = topics;
  const ex = excerpt(event.content);
  if (ex) result.excerpt = ex;
  return result;
}

function wikiToContentResult(event: NostrEvent): WikiResult | null {
  const d = tag(event, 'd');
  // The relay accepts wiki events with only a `d` tag (title is optional),
  // so we must not drop title-less wikis — only the d tag is required here.
  if (!d) return null;
  // Fall back to summary, then d-tag value so title is always non-empty.
  const title = tag(event, 'title') ?? tag(event, 'summary') ?? d;
  const { naddr, url } = encodeNaddrAndUrl(event.kind, event.pubkey, d);
  const topics = tagValues(event, 't');
  const result: WikiResult = {
    type: 'wiki',
    kind: 30818,
    title,
    naddr,
    url,
    author: { pubkey: event.pubkey },
    createdAt: event.created_at,
  };
  const summary = tag(event, 'summary');
  if (summary) result.summary = summary;
  if (topics.length) result.topics = topics;
  const ex = excerpt(event.content);
  if (ex) result.excerpt = ex;
  return result;
}

/**
 * Kind → transform registry. Adding a future content type (e.g. a forum
 * kind) is a one-line addition here plus its transform function.
 */
const CONTENT_TRANSFORMS: Record<
  number,
  (event: NostrEvent, language: string) => SimplifiedContentResult | null
> = {
  30142: (event, language) => resourceToContentResult(event, language),
  30023: (event) => articleToContentResult(event),
  30818: (event) => wikiToContentResult(event),
};

/** Content kinds this MCP understands (excludes the 21142 snippet kind). */
export const CONTENT_KINDS = Object.keys(CONTENT_TRANSFORMS).map(Number);

export function transformContentEvent(
  event: NostrEvent,
  language = 'de'
): SimplifiedContentResult | null {
  const fn = CONTENT_TRANSFORMS[event.kind];
  return fn ? fn(event, language) : null;
}

export function transformContentEvents(
  events: NostrEvent[],
  language = 'de'
): SimplifiedContentResult[] {
  const out: SimplifiedContentResult[] = [];
  for (const e of events) {
    const r = transformContentEvent(e, language);
    if (r) out.push(r);
  }
  return out;
}
