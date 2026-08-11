# amb-mcp Publications (NKBIP-01) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `search_content` covers NKBIP-01 publications (kinds 30040 indices + 30041 sections) and `get_resource` resolves any registered content kind's naddr; all retired kind-30145 wiring is removed.

**Architecture:** Follows the in-repo content-type pattern (`CONTENT_TRANSFORMS` registry + `CONTENT_TYPE_KINDS` map): a new `publicationToContentResult` transform serves both kinds; the type→kind map becomes multi-kind (`number[]`). `get_resource` gains generic kind dispatch: `naddrToLookup` carries the naddr's kind, the client fetch takes a kinds parameter (defaulting to `[30142]` for untouched callers), and non-30142 kinds format through the shared transform registry — extracted into a testable `runGetResource`, mirroring `runContentSearch`.

**Tech Stack:** TypeScript, bun, vitest, nostr-tools, zod. Tests: `bun run test` (vitest run). Build check: `bun run build` (tsc).

**Spec:** `docs/superpowers/specs/2026-07-18-publications-nkbip01-design.md`

## Global Constraints

- Repo: /home/laoc/coding/edufeed/amb-mcp — outside the default sandbox write scope; run commands with the sandbox disabled when needed. Worktree at `.worktrees/publications-nkbip01`, branch `feat/publications-nkbip01` (repo's existing `.worktrees/` convention). Run `bun install` once in the worktree (node_modules are not shared).
- `publication` type = kinds `[30040, 30041]`. Kind 30145 must not remain anywhere in src/ or test/ (README may mention the migration historically).
- The 30142 `get_resource` path must stay byte-identical in behavior (existing full AMB shape).
- a-tag marker rule (mirror the relay): 4th element `isPartOf`/`isOutputOf` → `partOf`; absent/empty/64-hex → `sections`; any other word → neither.
- `doi` = bare code (strip `doi:` prefix from the `i` tag); `identifier` = raw `i` value (existing 67590fd convention).
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Types + publication transform (30145 out, 30040/30041 in)

**Files:**
- Modify: `src/content/types.ts` (PublicationResult ~lines 64-101), `src/content/transform.ts` (transferkiosk fn ~121-164, registry ~170-180)
- Test: `test/content/transform.test.ts`

**Interfaces:**
- Consumes: `ContentResultBase`, `encodeNaddrAndUrl`, `tag`/`tagValues`/`excerpt`/`eventAuthor` helpers (transform.ts).
- Produces (Tasks 2-4 rely on these): `PublicationResult` (`type: 'publication'; kind: 30040 | 30041`), `publicationToContentResult(event)`, registry entries `30040`/`30041`, exported `hasContentTransform(kind: number): boolean`. `transferkioskToContentResult` narrowed to `'project' | 'measure'` / `30143 | 30144`.

- [ ] **Step 1: Write the failing tests** (append to `test/content/transform.test.ts`, reusing its local `evt` helper — check its exact signature first):

```ts
import { transformContentEvent } from '../../src/content/transform.js';

describe('publicationToContentResult (NKBIP-01 30040/30041)', () => {
  const hex64 = 'ab'.repeat(32);

  it('projects a migrated transferkiosk-shape 30040', () => {
    const e = evt(30040, 'pub1', [
      ['d', 'tk-p101658-pub100021'],
      ['title', 'Die Materialität analog-digitaler Schnittstellen'],
      ['type', 'academic'],
      ['additionalType', 'ScholarlyArticle'],
      ['summary', 'Usability-Testung Stift-basierter Eingabegeräte.'],
      ['author', 'Nadine Hahm'],
      ['author', 'Andreas Thor'],
      ['creator:type', 'Person'],
      ['creator:name', 'Nadine Hahm'],
      ['i', 'doi:10.25673/103431.2'],
      ['source', 'https://transferkiosk.net/p/101658/pub/1'],
      ['published_on', '2023-01-01'],
      ['published_by', 'Open Access Publikation'],
      ['inLanguage', 'de'],
      ['license:id', 'https://creativecommons.org/licenses/by/4.0/'],
      ['a', '30143:' + hex64 + ':https://transferkiosk.net/p/101658', 'wss://r', 'isOutputOf'],
      ['a', '39738:' + hex64 + ':tk-publikationsart/100009', 'wss://r', 'publicationType'],
    ]);
    const r = transformContentEvent(e)!;
    expect(r.type).toBe('publication');
    if (r.type !== 'publication') return;
    expect(r.kind).toBe(30040);
    expect(r.title).toBe('Die Materialität analog-digitaler Schnittstellen');
    expect(r.summary).toContain('Usability');
    expect(r.authors).toEqual(['Nadine Hahm', 'Andreas Thor']);
    expect(r.doi).toBe('10.25673/103431.2');
    expect(r.identifier).toBe('doi:10.25673/103431.2');
    expect(r.publicationType).toBe('academic');
    expect(r.additionalType).toBe('ScholarlyArticle');
    expect(r.publishedOn).toBe('2023-01-01');
    expect(r.publishedBy).toBe('Open Access Publikation');
    expect(r.sourcePage).toBe('https://transferkiosk.net/p/101658/pub/1');
    expect(r.language).toBe('de');
    expect(r.license).toBe('https://creativecommons.org/licenses/by/4.0/');
    // isOutputOf → partOf; vocab word marker → neither facet
    expect(r.partOf).toEqual(['30143:' + hex64 + ':https://transferkiosk.net/p/101658']);
    expect(r.sections).toBeUndefined();
    expect(r.naddr).toBeTruthy();
  });

  it('projects a wild Alexandria-shape 30040 (bare + event-id-hinted sections)', () => {
    const e = evt(30040, 'pub2', [
      ['d', 'aesops-fables'],
      ['title', "Aesop's Fables"],
      ['author', 'Aesop'],
      ['i', 'isbn:9780765382030'],
      ['a', '30041:' + hex64 + ':chapter-1', 'wss://r'],
      ['a', '30041:' + hex64 + ':chapter-2', 'wss://r', hex64],
    ]);
    const r = transformContentEvent(e)!;
    if (r.type !== 'publication') throw new Error('wrong type');
    expect(r.doi).toBeUndefined();
    expect(r.identifier).toBe('isbn:9780765382030');
    expect(r.sections).toEqual([
      '30041:' + hex64 + ':chapter-1',
      '30041:' + hex64 + ':chapter-2',
    ]);
    expect(r.partOf).toBeUndefined();
  });

  it('projects a 30041 section with a body excerpt', () => {
    const e = evt(
      30041,
      'sec1',
      [['d', 'chapter-1'], ['title', 'The Farmer and The Snake']],
      'ONE WINTER a Farmer found a Snake stiff and frozen with cold.'
    );
    const r = transformContentEvent(e)!;
    if (r.type !== 'publication') throw new Error('wrong type');
    expect(r.kind).toBe(30041);
    expect(r.excerpt).toContain('ONE WINTER a Farmer');
    expect(r.summary).toBeUndefined();
  });

  it('no longer transforms kind 30145 (retired)', () => {
    const e = evt(30145, 'old1', [['d', 'x'], ['name', 'Old Pub']]);
    expect(transformContentEvent(e)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test -- test/content/transform.test.ts`
Expected: FAIL (30040/30041 return null; 30145 still transforms)

- [ ] **Step 3: Implement `src/content/types.ts`**

Replace the transferkiosk base's doc comment (two kinds now) and the old `PublicationResult`:

```ts
/**
 * NIP-DIDACTIC transferkiosk content (kinds 30143 Projekt / 30144 Maßnahme).
 * `partOf` carries the parent project coord (`30143:<pub>:<d>`) for measures
 * and is absent on root projects. Publikationen migrated to NKBIP-01 kind
 * 30040 (see PublicationResult).
 */
interface TransferkioskResultBase extends ContentResultBase {
  description?: string;
  summary?: string;
  excerpt?: string;
  /** Parent project coord `30143:<pub>:<d>` (measures only). */
  partOf?: string;
}
```

```ts
/**
 * NKBIP-01 curated publication: kind 30040 (index — bibliographic metadata
 * in tags) or 30041 (section — chapter body in content). Sparse: section
 * results carry title + excerpt; index results carry the metadata fields.
 */
export interface PublicationResult extends ContentResultBase {
  type: 'publication';
  kind: 30040 | 30041;
  summary?: string;
  excerpt?: string;
  /** Plain author display names (`author` tags). */
  authors?: string[];
  /** Bare DOI code, `doi:` prefix stripped from the `i` tag. */
  doi?: string;
  /** Raw external identifier (`i` tag) — doi:/isbn:/URN as published. */
  identifier?: string;
  /** NKBIP-01 display type: academic, book, magazine, … (`type` tag). */
  publicationType?: string;
  /** schema.org type extension tag (ScholarlyArticle, Book, Chapter). */
  additionalType?: string;
  publishedOn?: string;
  publishedBy?: string;
  keywords?: string[];
  language?: string;
  license?: string;
  /** Coords of a-tags marked isPartOf/isOutputOf (e.g. parent project). */
  partOf?: string[];
  /** Coords of the publication's parts (bare or event-id-hinted a-tags). */
  sections?: string[];
}
```

`ProjectResult`/`MeasureResult` unchanged; `SimplifiedContentResult` union keeps the same six members.

- [ ] **Step 4: Implement `src/content/transform.ts`**

Narrow the transferkiosk function (drop the 30145 branch):

```ts
function transferkioskToContentResult(
  event: NostrEvent,
  type: 'project' | 'measure',
  kind: 30143 | 30144
): ProjectResult | MeasureResult | null {
```

(body unchanged except: delete the `if (type === 'publication') { … identifier … }` block and the union cast mentions of `PublicationResult`).

Add:

```ts
/** 64-char hex — the shape of an NKBIP-01 optional event-id hint in an a-tag's 4th position. */
function isHex64(s: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(s);
}

/**
 * NKBIP-01 publication: kind 30040 (index) or 30041 (section). Mirrors the
 * relay's a-tag marker rule: isPartOf/isOutputOf → partOf; absent/empty/
 * 64-hex 4th element → sections; any other word marker (vocab concept refs)
 * → neither.
 */
function publicationToContentResult(event: NostrEvent): PublicationResult | null {
  const d = tag(event, 'd');
  const title = tag(event, 'title');
  if (!d || !title) return null;
  const { naddr, url } = encodeNaddrAndUrl(event.kind, event.pubkey, d);
  const result: PublicationResult = {
    type: 'publication',
    kind: event.kind as 30040 | 30041,
    title,
    naddr,
    url,
    eventAuthor: eventAuthor(event.pubkey),
    createdAt: event.created_at,
  };

  if (event.kind === 30041) {
    const ex = excerpt(event.content);
    if (ex) result.excerpt = ex;
    return result;
  }

  const summary = tag(event, 'summary');
  if (summary) result.summary = summary;
  const authors = tagValues(event, 'author');
  if (authors.length) result.authors = authors;
  const identifier = tag(event, 'i');
  if (identifier) {
    result.identifier = identifier;
    if (identifier.startsWith('doi:')) result.doi = identifier.slice(4);
  }
  const publicationType = tag(event, 'type');
  if (publicationType) result.publicationType = publicationType;
  const additionalType = tag(event, 'additionalType');
  if (additionalType) result.additionalType = additionalType;
  const publishedOn = tag(event, 'published_on');
  if (publishedOn) result.publishedOn = publishedOn;
  const publishedBy = tag(event, 'published_by');
  if (publishedBy) result.publishedBy = publishedBy;
  const source = tag(event, 'source');
  if (source && /^https?:\/\//.test(source)) result.sourcePage = source;
  const keywords = tagValues(event, 't');
  if (keywords.length) result.keywords = keywords;
  const language = tag(event, 'inLanguage');
  if (language) result.language = language;
  const license = tag(event, 'license:id');
  if (license) result.license = license;

  const partOf: string[] = [];
  const sections: string[] = [];
  for (const t of event.tags) {
    if (t[0] !== 'a' || !t[1]) continue;
    const marker = t[3] ?? '';
    if (marker === 'isPartOf' || marker === 'isOutputOf') partOf.push(t[1]);
    else if (marker === '' || isHex64(marker)) sections.push(t[1]);
    // other word markers (vocab concept refs) → neither
  }
  if (partOf.length) result.partOf = partOf;
  if (sections.length) result.sections = sections;
  return result;
}
```

Registry:

```ts
const CONTENT_TRANSFORMS: Record<
  number,
  (event: NostrEvent, language: string) => SimplifiedContentResult | null
> = {
  30142: (event, language) => resourceToContentResult(event, language),
  30023: (event) => articleToContentResult(event),
  30818: (event) => wikiToContentResult(event),
  30143: (event) => transferkioskToContentResult(event, 'project', 30143),
  30144: (event) => transferkioskToContentResult(event, 'measure', 30144),
  30040: (event) => publicationToContentResult(event),
  30041: (event) => publicationToContentResult(event),
};

/** True when transformContentEvent can format this kind (get_resource dispatch). */
export function hasContentTransform(kind: number): boolean {
  return kind in CONTENT_TRANSFORMS;
}
```

- [ ] **Step 5: Run tests**

Run: `bun run test -- test/content/transform.test.ts`
Expected: PASS (new block + all pre-existing transform tests except any 30145-specific ones — if the existing transferkiosk describe-block has 30145 publication cases, DELETE those cases in this step and note it)

- [ ] **Step 6: Commit**

```bash
git add src/content/types.ts src/content/transform.ts test/content/transform.test.ts
git commit -m "feat(content): NKBIP-01 publication transform (30040/30041); retire 30145"
```

---

### Task 2: Filters — multi-kind type map

**Files:**
- Modify: `src/relay/filters.ts` (~lines 135-168)
- Test: `test/relay/contentFilter.test.ts`

**Interfaces:**
- Produces: `CONTENT_TYPE_KINDS: Record<ContentType, number[]>`; `buildContentFilter` behavior otherwise identical.

- [ ] **Step 1: Update the failing tests first** — in `test/relay/contentFilter.test.ts`, change the defaults assertion to:

```ts
expect(filter.kinds).toEqual([30142, 30023, 30818, 30143, 30144, 30040, 30041, 21142]);
```

and add:

```ts
it('maps types:["publication"] to both NKBIP-01 kinds', () => {
  const filter = buildContentFilter({ types: ['publication'] });
  expect(filter.kinds).toEqual([30040, 30041, 21142]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test -- test/relay/contentFilter.test.ts`
Expected: FAIL (30145 in kinds; single-kind map)

- [ ] **Step 3: Implement**

```ts
const CONTENT_TYPE_KINDS: Record<ContentType, number[]> = {
  resource: [30142],
  article: [30023],
  wiki: [30818],
  project: [30143],
  measure: [30144],
  publication: [30040, 30041],
};
```

and in `buildContentFilter`: `const kinds = types.flatMap((t) => CONTENT_TYPE_KINDS[t]);`

- [ ] **Step 4: Run tests** — `bun run test -- test/relay/contentFilter.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/relay/filters.ts test/relay/contentFilter.test.ts
git commit -m "feat(filters): publication type maps to kinds 30040+30041"
```

---

### Task 3: search_content description + integration test

**Files:**
- Modify: `src/tools/searchContent.ts` (title ~47, description ~48-65)
- Test: `test/tools/searchContent.test.ts`

**Interfaces:** none new (enum literal `publication` unchanged; its meaning changes).

- [ ] **Step 1: Write the failing integration test** (append; reuse `evt`/`fakeClient`):

```ts
it('surfaces publication indices and sections with their snippets', async () => {
  const pub = evt(30040, 'pub1', [
    ['d', 'tk-p1-pub2'],
    ['title', 'Digitale Prüfungen'],
    ['type', 'academic'],
    ['i', 'doi:10.1/x'],
  ]);
  const pubSnip = evt(21142, 'snip-pub1', [['e', 'pub1'], ['k', '30040'], ['score', '0.9']], 'passage P');
  const section = evt(30041, 'sec1', [['d', 'ch-1'], ['title', 'Kapitel 1']], 'section body text');
  const out = await runContentSearch(fakeClient([pub, pubSnip, section]), { query: 'prüfungen' });
  expect(out.total).toBe(2);
  expect(out.results.map((r) => r.kind)).toEqual([30040, 30041]);
  expect(out.results[0].type).toBe('publication');
  expect(out.results[0].snippet).toBe('passage P');
});
```

- [ ] **Step 2: Run to verify failure** — `bun run test -- test/tools/searchContent.test.ts` (fails only if Task 1 unmerged; if green already, still keep the test)

- [ ] **Step 3: Update the tool text** in `src/tools/searchContent.ts`:

- Title: `'Search Educational Content (resources, articles, wikis, projects, measures, publications)'` (unchanged wording is fine).
- Description: replace the kind enumeration sentence with: `'educational resources (kind 30142), long-form articles/blogs (30023), wikis (30818), projects (30143), measures (30144), and NKBIP-01 publications (30040 indices + 30041 sections — scientific articles, books).'` and append after the naddr sentence: `'Publication facets ride inside the query string as NIP-50 field filters: append type:academic, doi:10.1234/abcd.5678, or partOf:30143:<pubkey>:<d> ("publications of a project") to the query — the relay resolves them server-side.'`

- [ ] **Step 4: Full suite + build**

Run: `bun run test && bun run build`
Expected: PASS / tsc clean

- [ ] **Step 5: Commit**

```bash
git add src/tools/searchContent.ts test/tools/searchContent.test.ts
git commit -m "feat(search): NKBIP-01 publications in search_content with facet hints"
```

---

### Task 4: get_resource generic kind dispatch

**Files:**
- Modify: `src/relay/client.ts` (`getById` ~107-113, `getByDTag` ~118-128), `src/tools/get.ts` (rewrite: export `runGetResource`, kind-aware `naddrToLookup`)
- Test: `test/tools/getResource.test.ts`

**Interfaces:**
- Consumes: `hasContentTransform`, `transformContentEvent` (Task 1); existing `eventToAMBResource`/`toSimplifiedResource`.
- Produces: `naddrToLookup(naddr): { identifier; author; kind } | null`; `runGetResource(client, params): Promise<object>` (the JSON payload the tool serializes); `client.getByDTag(dTag, author?, kinds?)` / `client.getById(eventId, kinds?)` with `kinds` defaulting to `[30142]`.

- [ ] **Step 1: Update + write failing tests** in `test/tools/getResource.test.ts`:

- Existing `naddrToLookup` assertions gain `kind: 30142` (they encode kind 30142 naddrs — update each `toEqual`).
- New dispatch tests:

```ts
import { runGetResource } from '../../src/tools/get.js';
import { nip19 } from 'nostr-tools';

function fakeGetClient(event: any) {
  const calls: any[] = [];
  return {
    calls,
    getByDTag: async (d: string, author?: string, kinds?: number[]) => {
      calls.push({ d, author, kinds });
      return event;
    },
    getById: async () => event,
  };
}

describe('runGetResource kind dispatch', () => {
  const author = 'a'.repeat(64);

  it('fetches a publication naddr with its own kind and returns the publication shape', async () => {
    const event = {
      id: 'e1', pubkey: author, created_at: 1700000000, kind: 30040, sig: 's', content: '',
      tags: [['d', 'tk-p1-pub2'], ['title', 'Paper'], ['type', 'academic'], ['i', 'doi:10.1/x']],
    };
    const client = fakeGetClient(event);
    const naddr = nip19.naddrEncode({ kind: 30040, pubkey: author, identifier: 'tk-p1-pub2', relays: [] });
    const out = await runGetResource(client, { naddr });
    expect(client.calls[0].kinds).toEqual([30040]);
    expect(out.resource.type).toBe('publication');
    expect(out.resource.doi).toBe('10.1/x');
  });

  it('fetches a projekt naddr (transferkiosk fixed for free)', async () => {
    const event = {
      id: 'e2', pubkey: author, created_at: 1700000000, kind: 30143, sig: 's', content: '',
      tags: [['d', 'https://transferkiosk.net/p/1'], ['name', 'Projekt X']],
    };
    const client = fakeGetClient(event);
    const naddr = nip19.naddrEncode({ kind: 30143, pubkey: author, identifier: 'https://transferkiosk.net/p/1', relays: [] });
    const out = await runGetResource(client, { naddr });
    expect(client.calls[0].kinds).toEqual([30143]);
    expect(out.resource.type).toBe('project');
  });

  it('errors clearly on an unregistered kind', async () => {
    const client = fakeGetClient(null);
    const naddr = nip19.naddrEncode({ kind: 31337, pubkey: author, identifier: 'x', relays: [] });
    const out = await runGetResource(client, { naddr });
    expect(out.error).toMatch(/kind 31337/);
    expect(client.calls.length).toBe(0);
  });
});
```

(Adjust typing pragmatically — the fake client only needs the two methods `runGetResource` calls; use a structural parameter type in get.ts, mirroring `runContentSearch`'s minimal client interface.)

- [ ] **Step 2: Run to verify failure** — `bun run test -- test/tools/getResource.test.ts` → FAIL (`runGetResource` undefined; naddrToLookup missing kind)

- [ ] **Step 3: Implement `client.ts`** — kinds parameters, defaults preserve current behavior:

```ts
  async getById(eventId: string, kinds: number[] = [30142]): Promise<NostrEvent | null> {
    const events = await this.queryRelays({ ids: [eventId], kinds });
    return events[0] ?? null;
  }

  async getByDTag(dTag: string, author?: string, kinds: number[] = [30142]): Promise<NostrEvent | null> {
    const filter: Filter = { kinds, '#d': [dTag] };
    if (author) filter.authors = [author];
    const events = await this.queryRelays(filter);
    return events[0] ?? null;
  }
```

- [ ] **Step 4: Implement `get.ts`** — `naddrToLookup` returns `kind: decoded.data.kind`; extract the tool callback body into:

```ts
interface GetClient {
  getByDTag(dTag: string, author?: string, kinds?: number[]): Promise<NostrEvent | null>;
  getById(eventId: string, kinds?: number[]): Promise<NostrEvent | null>;
}

export async function runGetResource(
  client: GetClient,
  params: { identifier?: string; author?: string; eventId?: string; naddr?: string; language?: string }
): Promise<Record<string, unknown>> {
  if (!params.identifier && !params.eventId && !params.naddr) {
    return { error: 'Either identifier, eventId, or naddr must be provided', resource: null };
  }
  const lang = params.language || 'de';

  if (params.naddr) {
    const lookup = naddrToLookup(params.naddr);
    if (!lookup) return { error: 'Invalid naddr', resource: null };
    if (lookup.kind !== 30142) {
      if (!hasContentTransform(lookup.kind)) {
        return { error: `naddr kind ${lookup.kind} is not served by this server`, resource: null };
      }
      const event = await client.getByDTag(lookup.identifier, lookup.author, [lookup.kind]);
      if (!event) return { resource: null, message: 'Resource not found' };
      const result = transformContentEvent(event, lang);
      if (!result) return { resource: null, message: 'Failed to parse resource' };
      return { resource: result };
    }
    // 30142 falls through to the existing full-AMB path below.
    const event = await client.getByDTag(lookup.identifier, lookup.author);
    return formatAMB(event, lang);
  }

  const event = params.eventId
    ? await client.getById(params.eventId)
    : await client.getByDTag(params.identifier!, params.author);
  return formatAMB(event, lang);
}

/** The pre-existing 30142 formatting, byte-identical in behavior. */
function formatAMB(event: NostrEvent | null, lang: string): Record<string, unknown> {
  if (!event) return { resource: null, message: 'Resource not found' };
  const ambResource = eventToAMBResource(event);
  if (!ambResource) {
    return {
      resource: null,
      message: 'Failed to parse resource',
      rawEvent: { id: event.id, pubkey: event.pubkey, created_at: event.created_at },
    };
  }
  return { resource: toSimplifiedResource(ambResource, lang) };
}
```

The tool callback becomes `const payload = await runGetResource(client, params); return { content: [{ type: 'text', text: JSON.stringify(payload) }] };`. Update the tool description: naddrs of ANY content type from search_content work (resources, articles, wikis, projects, measures, publications); non-resource kinds return the same shape as their search results.

- [ ] **Step 5: Full suite + build** — `bun run test && bun run build` → PASS

- [ ] **Step 6: Commit**

```bash
git add src/relay/client.ts src/tools/get.ts test/tools/getResource.test.ts
git commit -m "feat(get): generic naddr kind dispatch — publications, transferkiosk, articles, wikis resolvable"
```

---

### Task 5: Docs + repo-wide 30145 sweep

**Files:**
- Modify: `README.md` (search_content section ~144-163, params table), `src/server-info.ts` (~line 4), `.env.example` (~lines 1-6 comment)

- [ ] **Step 1: README** — fix the stale type list (it predates transferkiosk): search_content covers resources (30142), articles (30023), wikis (30818), projects (30143), measures (30144), publications (NKBIP-01 30040/30041); `types` values `["resource","article","wiki","project","measure","publication"]`; note the facet-in-query syntax (`type:academic`, `doi:…`, `partOf:…`); get_resource section: resolves any of these types' naddrs.
- [ ] **Step 2: server-info.ts** — extend the prose: "…learning resources, long-form articles, wiki pages, scientific publications, and calendar events."
- [ ] **Step 3: .env.example** — update the relay-kinds comment (30040/30041 in, 30145 gone).
- [ ] **Step 4: Sweep** — `grep -rn 30145 src/ test/ README.md` → only historical-migration mentions allowed (ideally zero); fix stragglers.
- [ ] **Step 5: Full suite + build + commit**

```bash
bun run test && bun run build
git add README.md src/server-info.ts .env.example
git commit -m "docs: publications type, facet syntax, get_resource kind coverage"
```

---

### Task 6: Live smoke against dev + finish

- [ ] **Step 1: Live smoke** (from the worktree; the dev relay serves the 189 migrated publications):

```bash
# search_content equivalent via the stdio server is heavyweight; drive the exported functions:
bun run - <<'EOF'
import { AMBRelayClient } from './src/relay/client.js';
import { runContentSearch } from './src/tools/searchContent.js';
import { runGetResource } from './src/tools/get.js';
const client = new AMBRelayClient(['wss://dev.amb-relay.edufeed.org']);
const s = await runContentSearch(client, { query: 'Usability Eingabegeräte', types: ['publication'], limit: 3 });
console.log('search total:', s.total, s.results.map(r => [r.kind, r.title?.slice(0, 50)]));
const naddr = s.results[0]?.naddr;
const g = await runGetResource(client, { naddr });
console.log('get_resource:', g.resource?.type, g.resource?.doi, g.resource?.partOf);
process.exit(0);
EOF
```

Expected: search total ≥ 1 with kind-30040 results; get_resource returns type publication with doi + partOf. (Adapt constructor/signature to the actual `AMBRelayClient` API — read its constructor first; if a helper script fits better, write it under scratch, not the repo.)

- [ ] **Step 2: Also smoke a projekt naddr** (encode from a live 30143 via `nak req -k 30143 --limit 1` + nip19) → `runGetResource` returns type project.
- [ ] **Step 3: Invoke superpowers:finishing-a-development-branch** (merge to the repo's default branch per its convention).
