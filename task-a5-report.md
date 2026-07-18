# Task A5: docs + repo-wide 30145 sweep

## Grounding reads (before writing docs)

- `src/tools/searchContent.ts` — final tool description already lists all six
  types (resource/article/wiki/project/measure/publication) and the
  `type:academic` / `doi:10.1234/abcd.5678` / `partOf:30143:<pubkey>:<d>`
  facet-in-query examples (committed in Task 3, `471ab3c`). Docs below mirror
  this text rather than inventing new phrasing.
- `src/tools/get.ts` (`runGetResource`) — priority order is `eventId` >
  `naddr` > `identifier`. For `naddr`, kind 30142 falls through to the full
  AMB path; any other kind goes through `hasContentTransform` /
  `transformContentEvent`, returning the same shape as a `search_content`
  result (or an explicit "not served" error for an unregistered kind).
  Bare `identifier`/`eventId` (no naddr) always resolve full AMB (30142).
- `src/content/types.ts` (`PublicationResult`) — kind 30040|30041, fields
  `summary`, `excerpt`, `authors`, `doi` (bare, prefix stripped),
  `identifier` (raw `i` tag), `publicationType` (NKBIP-01 `type` tag),
  `additionalType` (schema.org tag), `publishedOn`, `publishedBy`,
  `keywords`, `language`, `license`, `partOf` (isPartOf/isOutputOf coords),
  `sections`.
- `src/relay/filters.ts` (`CONTENT_TYPE_KINDS`) — confirms
  `publication: [30040, 30041]`, and that `type:`/`doi:`/`partOf:` are relay-
  side NIP-50 field filters passed through verbatim in the query string, not
  tool parameters — so the README documents them as query syntax, not as a
  params-table row.

## Changes

### README.md
- Feature bullet (~line 8): added transferkiosk projects/measures and
  NKBIP-01 publications to the `search_content` one-liner (was stuck at
  "resources, long-form articles, and wikis" — predated even transferkiosk).
- `search_content` section (~144-168): rewrote the type list to all six
  (30142/30023/30818/30143/30144/30040+30041); `types` params-table row now
  lists all six enum values; added the `community` param row (present in the
  tool schema but missing from the README table); added a new **"Facet-in-
  query syntax"** paragraph documenting `type:academic`, `doi:10.x/...`
  (bare, no prefix), and `partOf:30143:<pubkey>:<d>`, with a combined-query
  example.
- `get_resource` section (~191-206): rewrote the intro to state it resolves
  naddrs of any content type from `search_content`, that non-resource kinds
  return their search-result shape (not full AMB), and that bare
  `identifier`/`eventId` always resolve kind 30142. Added the missing
  `naddr` row to the params table and annotated `identifier`/`eventId` as
  "kind 30142 only" for contrast.

### src/server-info.ts
- Extended the `SERVER_INSTRUCTIONS` prose list (line 4): "...wiki pages,
  scientific publications, and calendar events." (brief's exact wording).

### .env.example
- Extended the `AMB_RELAYS` comment (lines 1-6) to list transferkiosk
  (30143/30144) and NKBIP-01 publications (30040/30041) alongside the
  existing 30142/30023/30818/NIP-52 mentions. (30145 was never present in
  this comment — nothing to remove here; the "30145 gone" half of the brief
  applies to the repo-wide grep sweep below, not this file specifically.)

## Sweep: `grep -rn 30145 src/ test/ README.md .env.example`

```
test/content/transform.test.ts:373:  it('no longer transforms kind 30145 (retired)', () => {
test/content/transform.test.ts:374:    const e = evt(30145, [['d', 'x'], ['name', 'Old Pub']]);
```

Only remaining hits are in a regression test added in Task 1 (`e720e63`,
`nostrToTransferkiosk`/publication-transform commit) that asserts kind 30145
is **no longer** transformed by the content pipeline — i.e. it's the
guardrail that keeps 30145 retired, not a stale reference to fix. This is
the historical/justified case the brief anticipated; left as-is. No hits in
`src/`, `README.md`, or `.env.example`.

## Verification

`bun run test` (sandbox-disabled — first attempt failed under sandbox with
`EROFS` writing to `node_modules/.vite-temp`, a sandboxed read-only-fs
restriction, not a real failure):

```
 Test Files  27 passed (27)
      Tests  273 passed (273)
```

`bun run build`:

```
src/lib/schema.ts(109,30): error TS2503: Cannot find namespace 'z'.
src/lib/schema.ts(110,30): error TS2503: Cannot find namespace 'z'.
src/lib/schema.ts(111,32): error TS2503: Cannot find namespace 'z'.
src/lib/schema.ts(142,37): error TS2503: Cannot find namespace 'z'.
```

Exactly the 4 pre-existing `schema.ts` errors called out in the brief; no
new errors introduced by the docs edit.

## Commit

Staged exactly `README.md src/server-info.ts .env.example` per the brief's
commit recipe (left `bun.lock` and the pre-existing untracked
`task-a1..a4-report.md` files from earlier tasks untouched — out of scope
for this docs-only task).
