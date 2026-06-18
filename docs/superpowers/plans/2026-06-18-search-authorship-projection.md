# Search Authorship Projection Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface AMB `creator`/`publisher` on resource search results, rename the ambiguous `author` field to `eventAuthor` (+`npub`) across all content types, and let `get_resource` accept a `naddr` for direct search→detail handoff.

**Architecture:** Pure-function projection changes in `src/content/` (search results) plus one new decode helper in `src/tools/get.ts`. All data is already present in the Nostr events — `toSimplifiedResource` already computes `creator`/`publisher`; they are currently dropped before reaching the search result. No relay-side or network changes.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `nostr-tools` (`nip19`), Vitest.

## Global Constraints

- ESM imports use `.js` extension even for `.ts` source (e.g. `from '../content/types.js'`).
- `npub` and `naddr` encode/decode must never throw — wrap in try/catch and degrade (omit `npub`, return `null` lookup), mirroring the existing `encodeNaddrAndUrl` pattern in `src/utils/transform.ts`.
- `eventAuthor` is the Nostr event signer/uploader. `creator`/`publisher` are the resource's own authorship from AMB tags. These are distinct and must not be conflated.
- `eventAuthor` shape: `{ pubkey: string; npub?: string }` — applied to **all three** content types (resource, article, wiki).
- `creator`/`publisher` shape: `Array<{ name: string; type: string }>`, emitted as-is (empty `[]` when none), matching existing `get_resource` output.
- Test command (single file): `npx vitest run <path>`. Full suite: `npm test`. Type check: `npm run build`.
- Run all commands from the repo root `/home/laoc/coding/edufeed/amb-mcp`.

---

### Task 1: Rename `author` → `eventAuthor` (+npub) across all content types

**Files:**
- Modify: `src/content/types.ts` (the `ContentResultBase` interface)
- Modify: `src/content/transform.ts` (add `nip19` import, an `eventAuthor` helper, and replace `author:` in all three transforms)
- Test: `test/content/transform.test.ts` (update the one existing `author.pubkey` assertion; add npub assertions)

**Interfaces:**
- Consumes: `nip19` from `nostr-tools`; existing `NostrEvent`.
- Produces:
  - `ContentResultBase.eventAuthor: { pubkey: string; npub?: string }` (replaces `author: { pubkey: string }`).
  - Internal helper `eventAuthor(pubkey: string): { pubkey: string; npub?: string }` in `transform.ts` (not exported).

- [ ] **Step 1: Update the existing test assertion to the new field, and add npub coverage**

In `test/content/transform.test.ts`, the article test currently asserts the old field on line ~45. Replace that single line:

```ts
    // OLD: expect(r!.author.pubkey).toBe('a'.repeat(64));
    expect(r!.eventAuthor.pubkey).toBe('a'.repeat(64));
    expect(r!.eventAuthor.npub).toMatch(/^npub1/);
```

Then add a new test in the wiki describe block (after the "falls back to d-tag value" test, before its closing `});`):

```ts
  it('sets eventAuthor.npub for a wiki', () => {
    const r = transformContentEvent(evt(30818, [['d', 'w'], ['title', 'W']], 'body'), 'de');
    expect(r!.eventAuthor.pubkey).toBe('a'.repeat(64));
    expect(r!.eventAuthor.npub).toMatch(/^npub1/);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/content/transform.test.ts`
Expected: FAIL — TypeScript/runtime error that `author`/`eventAuthor` does not exist (property `eventAuthor` missing on result type).

- [ ] **Step 3: Update the base type**

In `src/content/types.ts`, inside `ContentResultBase`, replace:

```ts
  author: { pubkey: string };
```

with:

```ts
  /** The Nostr event signer (uploader/aggregator) — NOT necessarily the resource's creator/publisher. */
  eventAuthor: { pubkey: string; npub?: string };
```

- [ ] **Step 4: Add the npub helper and use it in all three transforms**

In `src/content/transform.ts`, change the top import from:

```ts
import type { NostrEvent } from 'nostr-tools';
```

to:

```ts
import { nip19, type NostrEvent } from 'nostr-tools';
```

Add this helper just below the `excerpt` function (around line 29):

```ts
/** Build the event-signer descriptor; npub is omitted if the pubkey can't be encoded. */
function eventAuthor(pubkey: string): { pubkey: string; npub?: string } {
  try {
    return { pubkey, npub: nip19.npubEncode(pubkey) };
  } catch {
    return { pubkey };
  }
}
```

In `resourceToContentResult`, `articleToContentResult`, and `wikiToContentResult`, replace every occurrence of:

```ts
    author: { pubkey: event.pubkey },
```

with:

```ts
    eventAuthor: eventAuthor(event.pubkey),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/content/transform.test.ts`
Expected: PASS (all tests in the file green).

- [ ] **Step 6: Type-check the whole project**

Run: `npm run build`
Expected: exits 0, no errors. (This confirms no other consumer still references the removed `author` field.)

- [ ] **Step 7: Commit**

```bash
git add src/content/types.ts src/content/transform.ts test/content/transform.test.ts
git commit -m "refactor(content): rename author→eventAuthor (+npub) on content results"
```

---

### Task 2: Surface resource `creator`/`publisher` in search results

**Files:**
- Modify: `src/content/types.ts` (`ResourceResult` interface)
- Modify: `src/content/transform.ts` (`resourceToContentResult`)
- Modify: `src/tools/searchContent.ts` (tool description only)
- Test: `test/content/transform.test.ts` (extend the resource describe block)

**Interfaces:**
- Consumes: `eventAuthor` helper and `eventAuthor` field from Task 1; `toSimplifiedResource(amb, language)` which already returns `creator?: Array<{ name: string; type: string }>` and `publisher?: Array<{ name: string; type: string }>` (see `src/utils/transform.ts:227-228`).
- Produces: `ResourceResult.creator?` and `ResourceResult.publisher?`, both `Array<{ name: string; type: string }>`.

- [ ] **Step 1: Write the failing test**

In `test/content/transform.test.ts`, inside the `describe('transformContentEvent — resource (30142)', ...)` block, add a test. AMB entity tags are colon-delimited (`publisher:name`, `publisher:type`, `creator:name`, `creator:type`) — see `extractEntities` in `src/utils/transform.ts`:

```ts
  it('surfaces resource publisher/creator distinct from the event signer', () => {
    const e = evt(30142, [
      ['d', 'res-2'],
      ['name', 'Friedensbildung in Schule und Gemeinde'],
      ['publisher:name', 'ptz Stuttgart'],
      ['publisher:type', 'Organization'],
    ]);
    const r = transformContentEvent(e, 'de');
    expect(r!.type).toBe('resource');
    expect((r as any).publisher).toEqual([{ name: 'ptz Stuttgart', type: 'Organization' }]);
    // No creator tags → empty array (mirrors get_resource output).
    expect((r as any).creator).toEqual([]);
    // The event signer is the uploader, NOT the publisher.
    expect(r!.eventAuthor.pubkey).toBe('a'.repeat(64));
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/content/transform.test.ts`
Expected: FAIL — `(r as any).publisher` is `undefined` (field not yet projected).

- [ ] **Step 3: Add the fields to the ResourceResult type**

In `src/content/types.ts`, inside `ResourceResult` (after `educationalLevel?: string[];`), add:

```ts
  /** Resource creator(s) from AMB metadata — who made the resource. */
  creator?: Array<{ name: string; type: string }>;
  /** Resource publisher(s) from AMB metadata — who published it. Distinct from eventAuthor. */
  publisher?: Array<{ name: string; type: string }>;
```

- [ ] **Step 4: Stop dropping the computed values in the transform**

In `src/content/transform.ts`, in `resourceToContentResult`, the local `s` is the result of `toSimplifiedResource(amb, language)`. In the returned object (currently ending with `educationalLevel: s.educationalLevel,` then `eventAuthor: ...`, `createdAt: ...`), add the two passthrough fields:

```ts
    educationalLevel: s.educationalLevel,
    creator: s.creator,
    publisher: s.publisher,
    eventAuthor: eventAuthor(event.pubkey),
    createdAt: event.created_at,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/content/transform.test.ts`
Expected: PASS.

- [ ] **Step 6: Update the search_content tool description**

In `src/tools/searchContent.ts`, the `description` string (lines ~48-55) ends with `'For upcoming events on the same topic, follow up with search_calendar_events.'`. Insert this sentence immediately before that final sentence:

```ts
        'Each result carries eventAuthor (the Nostr signer who uploaded the ' +
        'event — often an aggregator) plus, for resources, creator/publisher ' +
        '(who actually made and published the resource); these can differ, so ' +
        'do not treat eventAuthor as the publisher. For full metadata (license, ' +
        'dates, complete entity lists) pass a result\'s naddr to get_resource. ' +
```

- [ ] **Step 7: Type-check**

Run: `npm run build`
Expected: exits 0, no errors.

- [ ] **Step 8: Commit**

```bash
git add src/content/types.ts src/content/transform.ts src/tools/searchContent.ts test/content/transform.test.ts
git commit -m "feat(search): surface resource creator/publisher distinct from eventAuthor"
```

---

### Task 3: Accept `naddr` in `get_resource` for search→detail handoff

**Files:**
- Modify: `src/tools/get.ts` (add `naddrToLookup` helper, `naddr` input param, resolution branch, description)
- Test: `test/tools/getResource.test.ts` (new file)

**Interfaces:**
- Consumes: `nip19` from `nostr-tools`. `nip19.decode(naddr)` returns `{ type: 'naddr', data: { identifier: string; pubkey: string; kind: number; relays: string[] } }` for a valid naddr.
- Produces: exported `naddrToLookup(naddr: string): { identifier: string; author: string } | null`.

- [ ] **Step 1: Write the failing test (new file)**

Create `test/tools/getResource.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { nip19 } from 'nostr-tools';
import { naddrToLookup } from '../../src/tools/get.js';

function pk(n: number): string {
  return n.toString(16).padStart(64, '0');
}

describe('naddrToLookup', () => {
  it('decodes a valid naddr into identifier + author', () => {
    const naddr = nip19.naddrEncode({
      kind: 30142,
      pubkey: pk(7),
      identifier: 'https://example.org/material/peace/',
      relays: [],
    });
    expect(naddrToLookup(naddr)).toEqual({
      identifier: 'https://example.org/material/peace/',
      author: pk(7),
    });
  });

  it('returns null for a malformed or non-naddr value', () => {
    expect(naddrToLookup('not-an-naddr')).toBeNull();
    expect(naddrToLookup(nip19.npubEncode(pk(7)))).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/tools/getResource.test.ts`
Expected: FAIL — `naddrToLookup` is not exported from `src/tools/get.js`.

- [ ] **Step 3: Add the import and helper**

In `src/tools/get.ts`, change the imports to add `nip19`:

```ts
import { nip19 } from 'nostr-tools';
import { eventToAMBResource, toSimplifiedResource } from '../utils/transform.js';
```

(keep the existing `z` and `McpServer`/`AMBRelayClient` type imports as they are.)

Add this exported helper above `registerGetTool`:

```ts
/** Decode an naddr into a d-tag + author for getByDTag; null on malformed/non-naddr input. */
export function naddrToLookup(naddr: string): { identifier: string; author: string } | null {
  try {
    const decoded = nip19.decode(naddr);
    if (decoded.type !== 'naddr') return null;
    return { identifier: decoded.data.identifier, author: decoded.data.pubkey };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/tools/getResource.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the `naddr` input param to the tool schema**

In `src/tools/get.ts`, inside the `inputSchema` object, add a `naddr` entry after `eventId`:

```ts
        naddr: z
          .string()
          .optional()
          .describe('NIP-19 naddr from a search result — the preferred handoff to fetch full metadata.'),
```

- [ ] **Step 6: Wire `naddr` into the handler with precedence eventId → naddr → identifier**

In `src/tools/get.ts`, update the guard and the resolution block. Replace the guard:

```ts
      if (!params.identifier && !params.eventId) {
```

with:

```ts
      if (!params.identifier && !params.eventId && !params.naddr) {
```

(and update its error message text to `'Either identifier, eventId, or naddr must be provided'`.)

Replace the resolution block:

```ts
      let event;
      if (params.eventId) {
        event = await client.getById(params.eventId);
      } else if (params.identifier) {
        event = await client.getByDTag(params.identifier, params.author);
      }
```

with:

```ts
      let event;
      if (params.eventId) {
        event = await client.getById(params.eventId);
      } else if (params.naddr) {
        const lookup = naddrToLookup(params.naddr);
        if (!lookup) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: 'Invalid naddr', resource: null }),
              },
            ],
          };
        }
        event = await client.getByDTag(lookup.identifier, lookup.author);
      } else if (params.identifier) {
        event = await client.getByDTag(params.identifier, params.author);
      }
```

- [ ] **Step 7: Update the get_resource tool description**

In `src/tools/get.ts`, replace the `description` string:

```ts
        'Retrieve a single educational resource by its identifier (d-tag) or event ID. Returns the full resource metadata including educational properties.',
```

with:

```ts
        'Retrieve a single educational resource by naddr (preferred — pass a ' +
        'search_content result\'s naddr), d-tag identifier, or event ID. Returns ' +
        'the full resource metadata including creator/publisher and educational properties.',
```

- [ ] **Step 8: Type-check and run the full suite**

Run: `npm run build && npm test`
Expected: build exits 0; all tests pass (existing suite plus the new file).

- [ ] **Step 9: Commit**

```bash
git add src/tools/get.ts test/tools/getResource.test.ts
git commit -m "feat(get_resource): accept naddr for direct search→detail handoff"
```

---

## Self-Review

**Spec coverage:**
- Issue 1 (resource creator/publisher) → Task 2. ✓
- `eventAuthor` rename + npub, all three types → Task 1. ✓
- Issue 2 (`get_resource` naddr) → Task 3. ✓
- Descriptions → folded into Task 2 (search_content) and Task 3 (get_resource). ✓
- TDD tests for transforms and naddr decode → Tasks 1-3, tests-first. ✓
- Non-goals (no kind-0 resolution, no relay change) → respected; no task adds them. ✓

**Type consistency:** `eventAuthor: { pubkey: string; npub?: string }` defined in Task 1, consumed in Task 2. `creator`/`publisher` typed `Array<{ name: string; type: string }>` in both `ResourceResult` (Task 2) and matched to `toSimplifiedResource`'s output. `naddrToLookup` returns `{ identifier, author } | null`, used by the handler with `getByDTag(identifier, author)` — matches `getByDTag(dTag, author?)`. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code and exact commands. ✓
