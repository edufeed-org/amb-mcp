# Search Authorship Projection Fix — Design

**Date:** 2026-06-18
**Status:** Approved (design), pending spec review

## Problem

Two gaps surfaced while answering "who published this material?" over the MCP:

1. **`search_content` drops resource authorship.** For kind-30142 resources, the
   transform already computes `creator` and `publisher` (via
   `toSimplifiedResource`) but `resourceToContentResult` never copies them into
   the result. The model therefore cannot answer "who made / published this?"
   from a search result and is forced into a second lookup (or, worse, conflates
   the Nostr event signer with the publisher).

2. **No usable handoff key from search → `get_resource`.** Search results carry
   `naddr`, but `get_resource` only accepts `identifier` (d-tag) or `eventId`.
   There is no direct key to pass through, so reaching full metadata requires
   decoding the naddr out-of-band. This friction makes ad-hoc tools (e.g. `nak`)
   feel easier than the MCP.

### Root-cause note: two different "authors"

The reported confusion came from one event: the rpi-virtuell platform signs and
uploads many resources under a single Nostr pubkey (`610df6d6…`). That pubkey is
the **event author / uploader**, NOT the resource's publisher. The resource's
own creator/publisher live in the AMB `creator:*` / `publisher:*` tags
(`friedensbildung-schule-de`, `ptz Stuttgart`, …). The output must make these
two roles unmistakable.

## Goals

- Surface AMB `creator` and `publisher` on resource search results.
- Rename the ambiguous `author` field to `eventAuthor` across all content types,
  and include the signer's `npub`.
- Give `get_resource` a `naddr` input so search results hand off directly.
- Update tool descriptions so the role distinction and the handoff are explicit.

## Non-goals

- No kind-0 profile resolution for article/wiki authors (those kinds carry no
  AMB authorship; their `eventAuthor` pubkey/npub is the only signal). YAGNI.
- No change to `search_resources` output shape beyond what falls out of shared
  types (it already returns full `SimplifiedAMBResource` via a different path).
- No relay-side changes. All data needed is already in the events.

## Design

### Output shape

`ContentResultBase.author: { pubkey }` → `eventAuthor: { pubkey: string; npub: string }`,
applied to **all three** content types (resource, article, wiki). `npub` is a
local `nip19.npubEncode(pubkey)` — no network.

`ResourceResult` additionally gains:

```ts
creator?: Array<{ name: string; type: string }>;
publisher?: Array<{ name: string; type: string }>;
```

These mirror the shape already produced by `toSimplifiedResource`
(`{ name, type }` pairs) and are emitted as-is — i.e. an empty array when the
resource has none. This matches the existing `get_resource` output (the rpi
resources show `creator: []` with a populated `publisher`), so the two tools
agree.

Example (the "Friedensbildung in Schule und Gemeinde" resource):

```json
{
  "type": "resource",
  "kind": 30142,
  "title": "Friedensbildung in Schule und Gemeinde",
  "eventAuthor": { "pubkey": "610df6d6…27ef1", "npub": "npub1…" },
  "creator": [],
  "publisher": [{ "name": "ptz Stuttgart", "type": "Organization" }],
  "naddr": "naddr1…"
}
```

### Transforms (`content/transform.ts`)

- `resourceToContentResult`: add `creator: s.creator`, `publisher: s.publisher`
  (passthrough of already-computed values, emitted as-is incl. empty `[]`), and set
  `eventAuthor: { pubkey, npub: nip19.npubEncode(pubkey) }`.
- `articleToContentResult`, `wikiToContentResult`: replace
  `author: { pubkey }` with `eventAuthor: { pubkey, npub }`.
- A small shared helper builds `{ pubkey, npub }` so the encode logic lives in
  one place. On encode failure (malformed pubkey) it still returns the pubkey
  with `npub` omitted — never throws (consistent with `encodeNaddrAndUrl`).

### `get_resource` naddr input (`tools/get.ts`)

Add an optional `naddr` param. Resolution precedence: `eventId` → `naddr` →
`identifier`. When `naddr` is supplied, `nip19.decode` it; on a valid `naddr`
type, use the decoded `identifier` as the d-tag and the decoded `pubkey` as the
author, then reuse the existing `getByDTag` path. A malformed or non-`naddr`
value returns the existing structured error (`error`, `resource: null`) rather
than throwing.

### Descriptions

- `search_content`: add one line — results carry `eventAuthor` (the Nostr signer
  / uploader) plus, for resources, `creator`/`publisher` (who actually made /
  published the resource); these can differ. For full metadata (license, dates,
  full entity lists) pass a result's `naddr` to `get_resource`.
- `get_resource`: document the `naddr` input as the preferred handoff from search
  results.

## Testing (TDD, tests-first)

`test/content/transform.test.ts` (extend/add):
- resource event with `publisher` tags → result has `publisher: [{name,type}]`
  and `eventAuthor.npub` set; event-signer pubkey ≠ publisher name.
- resource with empty creator → `creator: []`, publisher present.
- article and wiki events → `eventAuthor: { pubkey, npub }`, no `creator`/`publisher`.

`test/tools/getResource.test.ts` (add or extend):
- valid `naddr` → decoded to correct identifier + author, routes to `getByDTag`.
- malformed `naddr` → structured error, no throw.

All pure functions; no network. Existing suite must stay green and `tsc` clean.

## Files

- `src/content/types.ts` — `eventAuthor` on base; `creator`/`publisher` on `ResourceResult`.
- `src/content/transform.ts` — passthrough + npub helper.
- `src/tools/get.ts` — `naddr` input + decode.
- `src/tools/searchContent.ts` — description.
- `test/content/transform.test.ts`, `test/tools/getResource.test.ts` — tests.

## Risk / compatibility

`author` → `eventAuthor` is a breaking rename in the MCP output. Acceptable: the
tool is young, locally consumed, and the rename is the whole point (removing the
ambiguity that caused the bug). No persisted data depends on the field name.
