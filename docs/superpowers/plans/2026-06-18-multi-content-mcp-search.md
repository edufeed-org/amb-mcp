# Multi-Content MCP Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a unified `search_content` tool to `amb-mcp` that queries the new multi-content `amb-relay` across educational resources (30142), long-form articles (30023), and wikis (30818) in one relay-ranked REQ, attaching the matched passage from kind-21142 snippet events, plus a topic-aware calendar search.

**Architecture:** A new `src/content/` module holds the discriminated `SimplifiedContentResult` shape, per-kind transforms behind a kind→transform registry, and snippet parsing/attachment. A `buildContentFilter` in `src/relay/filters.ts` maps requested content types to a `kinds` set (always including 21142) and the NIP-50 `search`. The tool runs the existing order-preserving `AMBRelayClient.queryEvents` (which neither hardcodes kinds nor reorders), partitions out 21142 events, transforms the content events via the registry, and attaches snippets by the `e` tag. Calendar gains a `query` param.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), `nostr-tools`, `zod`, `@modelcontextprotocol/sdk`, vitest.

## Global Constraints

- ESM with NodeNext: every relative import MUST use the `.js` extension (e.g. `from '../content/types.js'`), even from `.ts` sources. Tests import from `../../src/...js`.
- `strict` TypeScript. No `any` without a localized, commented cast (mirror the existing casts in `client.ts`).
- Test files live in `test/**/*.test.ts`, mirroring the `src/` path. Use `import { describe, it, expect } from 'vitest'`.
- Run a single test file with: `npx vitest run test/<path>.test.ts`. Run all: `npx vitest run`.
- The kind-21142 snippet event shape is fixed by the relay (`nostrlib/khatru/semantic/snippet.go`): `content` = passage; tags `e`=parent id, `a`=coord, `k`=parent kind, `score` (string, 4 decimals), optional `page` (int string), `heading`, `source_url`.
- Content kinds: resource=30142, article=30023, wiki=30818. Snippet kind=21142.
- Do NOT modify the existing `buildFilter`/`buildGetFilter` or the 30142-only `search`/`query` client methods — `search_resources` stays as-is.
- `EDUFEED_APP_BASE_URL` (env, trailing slash stripped) gates the `url` field, mirroring `toSimplifiedResource`.

---

### Task 1: Content result types, transforms, and registry

**Files:**
- Create: `src/content/types.ts`
- Create: `src/content/transform.ts`
- Modify: `src/utils/transform.ts` (extract & export `encodeNaddrAndUrl`)
- Test: `test/content/transform.test.ts`

**Interfaces:**
- Consumes: `eventToAMBResource`, `toSimplifiedResource` from `../utils/transform.js`; `NostrEvent` from `nostr-tools`.
- Produces:
  - `type ContentType = 'resource' | 'article' | 'wiki'`
  - `type SimplifiedContentResult` (discriminated union below)
  - `transformContentEvent(event: NostrEvent, language?: string): SimplifiedContentResult | null`
  - `transformContentEvents(events: NostrEvent[], language?: string): SimplifiedContentResult[]`
  - `encodeNaddrAndUrl(kind: number, pubkey: string, dTag: string): { naddr?: string; url?: string }` (exported from `src/utils/transform.ts`)

- [ ] **Step 1: Extract `encodeNaddrAndUrl` in `src/utils/transform.ts`**

Add this exported helper (place it just below the `EDUFEED_APP_BASE_URL` constant) and refactor `toSimplifiedResource` to use it.

```ts
/**
 * Encode a NIP-19 naddr for an addressable event and, when
 * EDUFEED_APP_BASE_URL is configured, a frontend URL pointing at it.
 * Both fields are omitted on encoding failure (malformed pubkey, etc.).
 */
export function encodeNaddrAndUrl(
  kind: number,
  pubkey: string,
  dTag: string
): { naddr?: string; url?: string } {
  try {
    const naddr = nip19.naddrEncode({ kind, pubkey, identifier: dTag, relays: [] });
    const url = EDUFEED_APP_BASE_URL ? `${EDUFEED_APP_BASE_URL}/${naddr}` : undefined;
    return { naddr, url };
  } catch {
    return {};
  }
}
```

Then replace the inline `try { naddr = nip19.naddrEncode(...) ... }` block inside `toSimplifiedResource` with:

```ts
  const { naddr, url } = encodeNaddrAndUrl(nostr.kind, nostr.pubkey, nostr.dTag);
```

(Remove the now-unused `let naddr` / `let url` declarations and the old try/catch.)

- [ ] **Step 2: Write the failing test `test/content/transform.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import {
  transformContentEvent,
  transformContentEvents,
} from '../../src/content/transform.js';
import type { NostrEvent } from 'nostr-tools';

function evt(kind: number, tags: string[][], content = ''): NostrEvent {
  return {
    id: `id-${kind}`,
    pubkey: 'a'.repeat(64),
    created_at: 1700000000,
    kind,
    tags,
    content,
    sig: 'sig',
  };
}

describe('transformContentEvent — article (30023)', () => {
  it('projects title, summary, topics, publishedAt, image and an excerpt', () => {
    const e = evt(
      30023,
      [
        ['d', 'attention-1'],
        ['title', 'Aufmerksamkeit im Seminar'],
        ['summary', 'Tipps gegen Unaufmerksamkeit'],
        ['image', 'https://example.org/a.png'],
        ['published_at', '1699990000'],
        ['t', 'didaktik'],
        ['t', 'hochschule'],
      ],
      'Studien zeigen, dass die Aufmerksamkeit alle 10-15 Minuten nachlässt.'
    );
    const r = transformContentEvent(e, 'de');
    expect(r).not.toBeNull();
    expect(r!.type).toBe('article');
    expect(r!.kind).toBe(30023);
    expect(r!.title).toBe('Aufmerksamkeit im Seminar');
    expect((r as any).summary).toBe('Tipps gegen Unaufmerksamkeit');
    expect((r as any).image).toBe('https://example.org/a.png');
    expect((r as any).publishedAt).toBe(1699990000);
    expect((r as any).topics).toEqual(['didaktik', 'hochschule']);
    expect((r as any).excerpt).toContain('Aufmerksamkeit');
    expect(r!.author.pubkey).toBe('a'.repeat(64));
    expect(r!.createdAt).toBe(1700000000);
  });

  it('returns null when title is missing', () => {
    expect(transformContentEvent(evt(30023, [['d', 'x']]), 'de')).toBeNull();
  });
});

describe('transformContentEvent — wiki (30818)', () => {
  it('projects title, summary and excerpt from Djot content', () => {
    const e = evt(
      30818,
      [
        ['d', 'seminar'],
        ['title', 'Seminar'],
        ['summary', 'Lehrformat'],
        ['t', 'lehre'],
      ],
      'Ein Seminar ist eine Lehrveranstaltung.'
    );
    const r = transformContentEvent(e, 'de');
    expect(r!.type).toBe('wiki');
    expect(r!.kind).toBe(30818);
    expect(r!.title).toBe('Seminar');
    expect((r as any).summary).toBe('Lehrformat');
    expect((r as any).topics).toEqual(['lehre']);
    expect((r as any).excerpt).toContain('Lehrveranstaltung');
  });

  it('returns null when d tag is missing', () => {
    expect(transformContentEvent(evt(30818, [['title', 'No d']]), 'de')).toBeNull();
  });
});

describe('transformContentEvent — resource (30142)', () => {
  it('projects an AMB resource into a resource result', () => {
    const e = evt(30142, [
      ['d', 'res-1'],
      ['name', 'Mathe Video'],
      ['description', 'Ein Video'],
      ['about:id', 'https://w3id.org/kim/schulfaecher/s1017'],
    ]);
    const r = transformContentEvent(e, 'de');
    expect(r!.type).toBe('resource');
    expect(r!.kind).toBe(30142);
    expect(r!.title).toBe('Mathe Video');
    expect((r as any).description).toBe('Ein Video');
  });
});

describe('transformContentEvent — unknown kind', () => {
  it('returns null for an unregistered kind', () => {
    expect(transformContentEvent(evt(1, [['d', 'x']]), 'de')).toBeNull();
  });
});

describe('transformContentEvents', () => {
  it('skips nulls and preserves order', () => {
    const ok = evt(30023, [['d', 'a'], ['title', 'A']], 'body');
    const bad = evt(30023, [['d', 'b']]); // no title
    const results = transformContentEvents([ok, bad], 'de');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('A');
  });
});

describe('excerpt capping', () => {
  it('caps long content and appends an ellipsis', () => {
    const long = 'x'.repeat(500);
    const r = transformContentEvent(evt(30023, [['d', 'l'], ['title', 'L']], long), 'de');
    const ex = (r as any).excerpt as string;
    expect(ex.length).toBeLessThanOrEqual(301);
    expect(ex.endsWith('…')).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/content/transform.test.ts`
Expected: FAIL — `Cannot find module '../../src/content/transform.js'`.

- [ ] **Step 4: Create `src/content/types.ts`**

```ts
/** Discriminant for the unified content result. */
export type ContentType = 'resource' | 'article' | 'wiki';

interface ContentResultBase {
  type: ContentType;
  kind: number;
  title: string;
  /** Frontend URL — present only when EDUFEED_APP_BASE_URL is configured. */
  url?: string;
  /** NIP-19 addressable identifier. */
  naddr?: string;
  author: { pubkey: string };
  createdAt: number;
  /** Best matching passage from a kind-21142 snippet, when available. */
  snippet?: string;
  /** Chunk score from the snippet, when available. */
  score?: number;
  /** Locators from the snippet, when known. */
  page?: number;
  heading?: string;
  sourceUrl?: string;
}

export interface ResourceResult extends ContentResultBase {
  type: 'resource';
  kind: 30142;
  description?: string;
  about?: string[];
  learningResourceType?: string[];
  educationalLevel?: string[];
}

export interface ArticleResult extends ContentResultBase {
  type: 'article';
  kind: 30023;
  summary?: string;
  excerpt?: string;
  topics?: string[];
  image?: string;
  publishedAt?: number;
}

export interface WikiResult extends ContentResultBase {
  type: 'wiki';
  kind: 30818;
  summary?: string;
  excerpt?: string;
  topics?: string[];
}

export type SimplifiedContentResult = ResourceResult | ArticleResult | WikiResult;
```

- [ ] **Step 5: Create `src/content/transform.ts`**

```ts
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
  const title = tag(event, 'title');
  if (!d || !title) return null;
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
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/content/transform.test.ts test/utils/transform.test.ts`
Expected: PASS (including the existing 30142 transform tests, proving the `encodeNaddrAndUrl` refactor is non-breaking).

- [ ] **Step 7: Commit**

```bash
git add src/content/types.ts src/content/transform.ts src/utils/transform.ts test/content/transform.test.ts
git commit -m "feat(content): article/wiki/resource transforms + kind registry"
```

---

### Task 2: Snippet parsing and attachment

**Files:**
- Create: `src/content/snippet.ts`
- Test: `test/content/snippet.test.ts`

**Interfaces:**
- Consumes: `NostrEvent` from `nostr-tools`; `SimplifiedContentResult` from `./types.js`.
- Produces:
  - `interface ParsedSnippet { eventId: string; passage: string; score?: number; page?: number; heading?: string; sourceUrl?: string }`
  - `SNIPPET_KIND = 21142`
  - `parseSnippets(events: NostrEvent[]): Map<string, ParsedSnippet>` (keyed by `e` tag; on duplicate parent id keeps the higher score)
  - `attachSnippets(results: SimplifiedContentResult[], snippets: Map<string, ParsedSnippet>): SimplifiedContentResult[]` (mutates each result by `nostr` event id match and returns the same array)

Note: results carry `naddr`/locators but the join key is the parent **event id**. The tool passes a parallel array of event ids alongside results (see Task 4) — to keep `attachSnippets` self-contained, it matches on a `__eventId` carried internally. To avoid leaking that, attach by index is brittle; instead, key the match on the result's event id which we add to the result object as a non-enumerable field is overkill. **Decision:** `attachSnippets` takes `results` plus the originating `contentEvents` (same order) so it can map result[i] ↔ contentEvents[i].id. Signature:
`attachSnippets(results: SimplifiedContentResult[], contentEvents: NostrEvent[], snippets: Map<string, ParsedSnippet>): SimplifiedContentResult[]`.

- [ ] **Step 1: Write the failing test `test/content/snippet.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { parseSnippets, attachSnippets, SNIPPET_KIND } from '../../src/content/snippet.js';
import type { NostrEvent } from 'nostr-tools';
import type { ArticleResult } from '../../src/content/types.js';

function snippetEvent(parentId: string, content: string, tags: string[][] = []): NostrEvent {
  return {
    id: `snip-${parentId}`,
    pubkey: 'relay',
    created_at: 1700000000,
    kind: SNIPPET_KIND,
    tags: [['e', parentId], ['a', `30023:pk:${parentId}`], ['k', '30023'], ...tags],
    content,
    sig: 'sig',
  };
}

function contentEvent(id: string): NostrEvent {
  return { id, pubkey: 'pk', created_at: 1, kind: 30023, tags: [], content: '', sig: 's' };
}

function articleResult(): ArticleResult {
  return { type: 'article', kind: 30023, title: 'T', author: { pubkey: 'pk' }, createdAt: 1 };
}

describe('parseSnippets', () => {
  it('parses content, score and locators keyed by parent e tag', () => {
    const map = parseSnippets([
      snippetEvent('parent1', 'matched passage', [
        ['score', '0.8200'],
        ['page', '12'],
        ['heading', 'Aufmerksamkeit'],
        ['source_url', 'https://example.org/p.pdf'],
      ]),
    ]);
    const s = map.get('parent1')!;
    expect(s.passage).toBe('matched passage');
    expect(s.score).toBeCloseTo(0.82);
    expect(s.page).toBe(12);
    expect(s.heading).toBe('Aufmerksamkeit');
    expect(s.sourceUrl).toBe('https://example.org/p.pdf');
  });

  it('keeps the higher score when a parent has duplicate snippets', () => {
    const map = parseSnippets([
      snippetEvent('p', 'low', [['score', '0.10']]),
      snippetEvent('p', 'high', [['score', '0.90']]),
    ]);
    expect(map.get('p')!.passage).toBe('high');
  });

  it('ignores snippet events with no e tag', () => {
    const noE: NostrEvent = {
      id: 'x', pubkey: 'r', created_at: 1, kind: SNIPPET_KIND,
      tags: [['score', '0.5']], content: 'orphan', sig: 's',
    };
    expect(parseSnippets([noE]).size).toBe(0);
  });
});

describe('attachSnippets', () => {
  it('attaches the snippet to the result whose event id matches', () => {
    const results = [articleResult()];
    const events = [contentEvent('parent1')];
    const map = parseSnippets([
      snippetEvent('parent1', 'the passage', [['score', '0.7'], ['heading', 'H']]),
    ]);
    attachSnippets(results, events, map);
    expect(results[0].snippet).toBe('the passage');
    expect(results[0].score).toBeCloseTo(0.7);
    expect(results[0].heading).toBe('H');
  });

  it('leaves a result without a matching snippet untouched', () => {
    const results = [articleResult()];
    const events = [contentEvent('lonely')];
    attachSnippets(results, events, new Map());
    expect(results[0].snippet).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/content/snippet.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/content/snippet.ts`**

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/content/snippet.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/content/snippet.ts test/content/snippet.test.ts
git commit -m "feat(content): parse + attach kind-21142 snippets by parent e tag"
```

---

### Task 3: `buildContentFilter`

**Files:**
- Modify: `src/relay/filters.ts` (append; do not touch `buildFilter`/`buildGetFilter`)
- Test: `test/relay/contentFilter.test.ts`

**Interfaces:**
- Consumes: `Filter` from `nostr-tools`; `ContentType` from `../content/types.js`; `SNIPPET_KIND` from `../content/snippet.js`.
- Produces:
  - `interface ContentSearchParams { query?: string; types?: ContentType[]; since?: number; until?: number; authors?: string[]; limit?: number }`
  - `buildContentFilter(params: ContentSearchParams): Filter` — kinds = mapped content kinds + `SNIPPET_KIND`; sets `search` from `query`; `since`/`until`/`authors`/`limit` (bounded 1–250, default 20).

- [ ] **Step 1: Write the failing test `test/relay/contentFilter.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { buildContentFilter } from '../../src/relay/filters.js';

describe('buildContentFilter', () => {
  it('defaults to all content kinds plus the 21142 snippet kind', () => {
    const f = buildContentFilter({});
    expect(new Set(f.kinds)).toEqual(new Set([30142, 30023, 30818, 21142]));
    expect(f.limit).toBe(20);
    expect(f.search).toBeUndefined();
  });

  it('maps a types subset to the right kinds (plus 21142)', () => {
    const f = buildContentFilter({ types: ['article', 'wiki'] });
    expect(new Set(f.kinds)).toEqual(new Set([30023, 30818, 21142]));
  });

  it('sets the NIP-50 search string from query', () => {
    const f = buildContentFilter({ query: 'unaufmerksam seminar' });
    expect(f.search).toBe('unaufmerksam seminar');
  });

  it('passes through authors, since, until', () => {
    const f = buildContentFilter({ authors: ['a', 'b'], since: 100, until: 200 });
    expect(f.authors).toEqual(['a', 'b']);
    expect(f.since).toBe(100);
    expect(f.until).toBe(200);
  });

  it('bounds the limit', () => {
    expect(buildContentFilter({ limit: 0 }).limit).toBe(1);
    expect(buildContentFilter({ limit: 999 }).limit).toBe(250);
    expect(buildContentFilter({ limit: 50 }).limit).toBe(50);
  });

  it('always includes the snippet kind even for a single type', () => {
    const f = buildContentFilter({ types: ['resource'] });
    expect(f.kinds).toContain(21142);
    expect(f.kinds).toContain(30142);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/relay/contentFilter.test.ts`
Expected: FAIL — `buildContentFilter` is not exported.

- [ ] **Step 3: Append `buildContentFilter` to `src/relay/filters.ts`**

Add these imports at the top of the file (alongside the existing `import type { Filter } from 'nostr-tools';`):

```ts
import type { ContentType } from '../content/types.js';
import { SNIPPET_KIND } from '../content/snippet.js';
```

Append at the end of the file:

```ts
const CONTENT_TYPE_KINDS: Record<ContentType, number> = {
  resource: 30142,
  article: 30023,
  wiki: 30818,
};

export interface ContentSearchParams {
  /** Free-text topic (NIP-50 search). */
  query?: string;
  /** Content types to include; defaults to all. */
  types?: ContentType[];
  since?: number;
  until?: number;
  authors?: string[];
  limit?: number;
}

/**
 * Build a multi-kind NIP-50 filter for cross-content search. The 21142
 * snippet kind is always added so the relay attaches matched passages; the
 * tool partitions those out of the result stream.
 */
export function buildContentFilter(params: ContentSearchParams): Filter {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 250);
  const types: ContentType[] = params.types?.length
    ? params.types
    : (['resource', 'article', 'wiki'] as ContentType[]);
  const kinds = types.map((t) => CONTENT_TYPE_KINDS[t]);
  kinds.push(SNIPPET_KIND);

  const filter: Filter = { kinds, limit };
  if (params.query?.trim()) filter.search = params.query.trim();
  if (params.since !== undefined) filter.since = params.since;
  if (params.until !== undefined) filter.until = params.until;
  if (params.authors?.length) filter.authors = params.authors;
  return filter;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/relay/contentFilter.test.ts test/relay/filters.test.ts`
Expected: PASS (existing `buildFilter` tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/relay/filters.ts test/relay/contentFilter.test.ts
git commit -m "feat(relay): buildContentFilter — multi-kind NIP-50 + 21142 opt-in"
```

---

### Task 4: `search_content` tool

**Files:**
- Create: `src/tools/searchContent.ts`
- Modify: `src/tools/index.ts` (register the new tool)
- Test: `test/tools/searchContent.test.ts`

**Interfaces:**
- Consumes: `buildContentFilter`/`ContentSearchParams` from `../relay/filters.js`; `transformContentEvents` + `CONTENT_KINDS` from `../content/transform.js`; `parseSnippets`/`attachSnippets`/`SNIPPET_KIND` from `../content/snippet.js`; `AMBRelayClient.queryEvents(filter)` (existing, order-preserving, no kind hardcode).
- Produces:
  - `runContentSearch(client: Pick<AMBRelayClient, 'queryEvents'>, params: ContentSearchParams & { language?: string }): Promise<{ total: number; results: SimplifiedContentResult[] }>` — exported pure orchestrator (testable with a fake client).
  - `registerSearchContentTool(server: McpServer, client: AMBRelayClient): void`.

The handler wiring (registration) calls `runContentSearch` and JSON-stringifies the result, mirroring `search.ts`.

- [ ] **Step 1: Write the failing test `test/tools/searchContent.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { runContentSearch } from '../../src/tools/searchContent.js';
import type { NostrEvent } from 'nostr-tools';

function evt(kind: number, id: string, tags: string[][], content = ''): NostrEvent {
  return { id, pubkey: 'a'.repeat(64), created_at: 1700000000, kind, tags, content, sig: 's' };
}

// A fake client that returns a fixed, ordered event stream (content interleaved
// with the 21142 snippet that follows each result), exactly as the relay emits.
function fakeClient(events: NostrEvent[]) {
  return { queryEvents: async () => events };
}

describe('runContentSearch', () => {
  it('returns typed, relay-ordered results with snippets attached and 21142 excluded', async () => {
    const article = evt(30023, 'art1', [['d', 'a'], ['title', 'Aufmerksamkeit']], 'body a');
    const artSnip = evt(21142, 'snip-art1', [['e', 'art1'], ['k', '30023'], ['score', '0.81']], 'passage A');
    const wiki = evt(30818, 'wiki1', [['d', 'w'], ['title', 'Seminar']], 'body w');
    const wikiSnip = evt(21142, 'snip-wiki1', [['e', 'wiki1'], ['k', '30818'], ['score', '0.66']], 'passage W');
    const resource = evt(30142, 'res1', [['d', 'r'], ['name', 'Video']]);

    const out = await runContentSearch(
      fakeClient([article, artSnip, wiki, wikiSnip, resource]),
      { query: 'aufmerksamkeit', language: 'de' }
    );

    expect(out.total).toBe(3);
    expect(out.results.map((r) => r.type)).toEqual(['article', 'wiki', 'resource']);
    expect(out.results[0].snippet).toBe('passage A');
    expect(out.results[0].score).toBeCloseTo(0.81);
    expect(out.results[1].snippet).toBe('passage W');
    expect(out.results[2].snippet).toBeUndefined(); // no snippet for the resource
    // No 21142 leaks into results
    expect(out.results.some((r) => (r as { kind: number }).kind === 21142)).toBe(false);
  });

  it('returns an empty result set when the relay returns nothing', async () => {
    const out = await runContentSearch(fakeClient([]), { query: 'x' });
    expect(out).toEqual({ total: 0, results: [] });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/tools/searchContent.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/tools/searchContent.ts`**

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AMBRelayClient } from '../relay/client.js';
import { buildContentFilter, type ContentSearchParams } from '../relay/filters.js';
import { transformContentEvents } from '../content/transform.js';
import { parseSnippets, attachSnippets, SNIPPET_KIND } from '../content/snippet.js';
import type { SimplifiedContentResult } from '../content/types.js';

/**
 * Run a cross-content search: one relay-ranked REQ over the selected content
 * kinds (+ 21142), partition out the snippet events, transform the content
 * events in arrival order, and attach each matched passage to its parent.
 */
export async function runContentSearch(
  client: Pick<AMBRelayClient, 'queryEvents'>,
  params: ContentSearchParams & { language?: string }
): Promise<{ total: number; results: SimplifiedContentResult[] }> {
  const language = params.language || 'de';
  const filter = buildContentFilter(params);
  const events = await client.queryEvents(filter);

  const contentEvents = events.filter((e) => e.kind !== SNIPPET_KIND);
  const snippetEvents = events.filter((e) => e.kind === SNIPPET_KIND);

  const results = transformContentEvents(contentEvents, language);
  // transformContentEvents preserves order and skips invalid events. Rebuild
  // the parallel event list so result[i] ↔ event[i] for snippet attachment.
  const keptEvents = contentEvents.filter((e) => transformContentEvents([e], language).length > 0);
  const snippets = parseSnippets(snippetEvents);
  attachSnippets(results, keptEvents, snippets);

  return { total: results.length, results };
}

export function registerSearchContentTool(server: McpServer, client: AMBRelayClient): void {
  server.registerTool(
    'search_content',
    {
      title: 'Search Educational Content (resources, articles, wikis)',
      description:
        'Topic search across ALL content types on the relay in one ranked call: ' +
        'educational resources (kind 30142), long-form articles/blogs (30023), and ' +
        'wikis (30818). Results are interleaved and ranked by semantic passage match, ' +
        'and each carries the matched passage ("snippet") when available — use it to ' +
        'answer the user, not just list links. This is the default tool for ' +
        'natural-language questions like "what can I do about inattentive students?". ' +
        'For upcoming events on the same topic, follow up with search_calendar_events.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Free-text topic (e.g., "Unaufmerksamkeit im Seminar").'),
        types: z
          .array(z.enum(['resource', 'article', 'wiki']))
          .optional()
          .describe('Restrict to a subset of content types. Default: all three.'),
        language: z.string().optional().default('de').describe('Label language (default "de").'),
        since: z.number().optional().describe('Created at or after this Unix timestamp.'),
        until: z.number().optional().describe('Created at or before this Unix timestamp.'),
        authors: z.array(z.string()).optional().describe('Filter by author pubkeys (hex).'),
        limit: z
          .number()
          .min(1)
          .max(250)
          .optional()
          .default(20)
          .describe('Max results (1-250, default 20).'),
      },
    },
    async (params) => {
      const out = await runContentSearch(client, {
        query: params.query,
        types: params.types,
        language: params.language,
        since: params.since,
        until: params.until,
        authors: params.authors,
        limit: params.limit,
      });
      return { content: [{ type: 'text', text: JSON.stringify(out) }] };
    }
  );
}
```

- [ ] **Step 4: Register the tool in `src/tools/index.ts`**

Add the import alongside the other tool imports:

```ts
import { registerSearchContentTool } from './searchContent.js';
```

In `registerTools`, in the `// Query tools` block, add after `registerSearchTool(server, client);`:

```ts
  registerSearchContentTool(server, client);
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run test/tools/searchContent.test.ts && npx tsc --noEmit`
Expected: PASS and no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/tools/searchContent.ts src/tools/index.ts test/tools/searchContent.test.ts
git commit -m "feat(tools): search_content unified cross-content search with snippets"
```

---

### Task 5: Topic-aware calendar search

**Files:**
- Modify: `src/calendar/filters.ts` (add `query` → `search`)
- Modify: `src/tools/calendar.ts` (add `query` param + description caveat)
- Test: `test/calendar/filters.test.ts` (append)

**Interfaces:**
- Consumes/Produces: extend `CalendarSearchParams` with `query?: string`; `buildCalendarFilter` sets `filter.search` when `query` is present. No signature change otherwise.

- [ ] **Step 1: Add failing tests to `test/calendar/filters.test.ts`**

Append inside the existing `describe('buildCalendarFilter', ...)` block (or a new describe). First read the file to match its structure; then add:

```ts
  it('sets the NIP-50 search string from query', () => {
    const filter = buildCalendarFilter({ query: 'mathematik' });
    expect(filter.search).toBe('mathematik');
  });

  it('keeps range params and search together (relay decides precedence)', () => {
    const filter = buildCalendarFilter({ query: 'mathe', startAfter: 100 });
    expect(filter.search).toBe('mathe');
    expect((filter as Record<string, unknown>)['#start_after']).toEqual(['100']);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/calendar/filters.test.ts`
Expected: FAIL — `query`/`search` not handled.

- [ ] **Step 3: Add `query` to `src/calendar/filters.ts`**

In `CalendarSearchParams`, add:

```ts
  /** Free-text topic (NIP-50 search on the calendar collection). */
  query?: string;
```

In `buildCalendarFilter`, after the `const filter: Filter = { kinds, limit };` line, add:

```ts
  if (params.query?.trim()) {
    filter.search = params.query.trim();
  }
```

- [ ] **Step 4: Add the `query` param to `src/tools/calendar.ts`**

In the `search_calendar_events` `inputSchema`, add a `query` field (place it first):

```ts
        query: z
          .string()
          .optional()
          .describe(
            'Free-text topic for the events. NOTE: when combined with time/geo ' +
              'filters, the relay prioritises the time/geo range and ignores this ' +
              'search server-side — for "events about X next week", pass the time ' +
              'range and filter the returned events by topic on the client.'
          ),
```

And pass it through in the `buildCalendarFilter({ ... })` call:

```ts
        query: params.query,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/calendar/filters.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/calendar/filters.ts src/tools/calendar.ts test/calendar/filters.test.ts
git commit -m "feat(calendar): topic (query) param for calendar full-text search"
```

---

### Task 6: Config & documentation

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

No tests (docs only). This task documents the consolidation and the new tool.

- [ ] **Step 1: Update `.env.example`**

Change the AMB relay guidance to point at the multi-content relay and note consolidation. Replace the `AMB_RELAYS` block comment and the `CALENDAR_RELAYS` block comment:

```bash
# AMB relay URL(s), comma-separated. The amb-relay now serves ALL content
# types — educational resources (30142), long-form articles (30023), wikis
# (30818) and NIP-52 calendar events — so a single relay covers search_content
# and search_calendar_events. Use ws://localhost:3334 for local docker, or
# wss://dev.amb-relay.edufeed.org for dev.
AMB_RELAYS=wss://relay.edufeed.org
```

```bash
# Calendar relay URL(s), comma-separated. OPTIONAL: if the amb-relay above has
# CALENDAR_ENABLED, point this at the SAME relay (or leave it). A separate
# calendar relay is still supported for split deployments.
CALENDAR_RELAYS=wss://dev.calendar-relay.edufeed.org
```

- [ ] **Step 2: Document `search_content` in `README.md`**

In the `## Available Tools` section, add a `search_content` subsection **before** `search_resources`:

```markdown
### search_content

Topic search across **all** content types in one ranked call — educational
resources (30142), long-form articles (30023), and wikis (30818). Results are
interleaved and ranked by semantic passage match; each carries the matched
passage (`snippet`) when the relay's chunk re-ranking is active. This is the
default entry point for natural-language questions.

Parameters:
| Name | Type | Description |
|------|------|-------------|
| `query` | string | Free-text topic |
| `types` | string[] | Subset of `["resource","article","wiki"]` (default: all) |
| `language` | string | Label language (default `de`) |
| `since` / `until` | number | Unix timestamp bounds |
| `authors` | string[] | Author pubkeys (hex) |
| `limit` | number | Max results, 1-250 (default 20) |

Each result: `{ type, kind, title, url?, naddr?, snippet?, score?, ...type-specific }`.
For upcoming events on the same topic, follow up with `search_calendar_events`.
```

Also update the `### Features → Query & Browse` bullet list to mention cross-content search and snippet passages, and update the `search_calendar_events` docs (if present in README) to mention the new `query` param and its client-side-composition caveat.

- [ ] **Step 3: Build + full test suite (final verification)**

Run: `npx tsc --noEmit && npx vitest run`
Expected: no type errors; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add .env.example README.md
git commit -m "docs: document search_content + relay consolidation"
```

---

## Notes for the executor

- `AMBRelayClient.queryEvents` already preserves arrival order and does NOT hardcode kinds — that is why `search_content` uses it directly instead of the 30142-locked `query`/`search`. Do not "fix" `queryEvents` to add kind hardcoding.
- The relay emits each 21142 snippet immediately after its parent within the same REQ (before EOSE), so a single `queryEvents` call collects both. When chunk re-ranking is off, no 21142 arrives and `snippet` is simply absent — never an error.
- Live smoke (optional, not a unit test): against `wss://dev.amb-relay.edufeed.org` (all gates on), `runContentSearch(client, { query: 'mathematik' })` should return mixed types with snippets.
