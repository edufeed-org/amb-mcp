# Publications (NKBIP-01 kinds 30040/30041) in amb-mcp — Design

**Date:** 2026-07-18
**Status:** Approved design, pre-implementation
**Context:** The relay ecosystem migrated publications to NKBIP-01 on
2026-07-17: kind 30145 (transferkiosk Publikation) is retired everywhere —
its 186 events were NIP-09-deleted and re-published as kind-30040 indices;
the dev relay (`wss://dev.amb-relay.edufeed.org`, amb-mcp's configured
`AMB_RELAYS`) serves 30040/30041 first-class (validation, own Typesense
collection, `partOf` facet, chunk snippets). See amb-relay specs
`2026-07-16-publications-30040-design.md` and
`2026-07-16-transferkiosk-nkbip01-migration-design.md`.

## Goal

`search_content` finds publications (indices AND sections) alongside the
other content types, and `get_resource` resolves ANY registered content
kind's naddr — closing the long-standing gap where transferkiosk (and now
publication) naddrs returned nothing.

## Decisions (user-approved 2026-07-18)

| Question | Decision |
|---|---|
| 30041 sections in search | **Yes, same type** — `publication` maps to kinds `[30040, 30041]`; sections surface as publication results with body excerpt |
| get_resource scope | **Generic, all kinds** — dispatch by the naddr's own kind through the shared transform registry; 30142 keeps its exact current full-AMB path |
| Old 30145 wiring | **Deleted** — frees the `publication` type name and `PublicationResult` interface |

## 1. Content type & result shape

- `ContentType` union (`src/content/types.ts`): `publication` replaces the
  retired 30145 meaning; kinds `[30040, 30041]`.
- New `PublicationResult` (the old 30145 interface is removed, name reused):
  - Shared: `type: 'publication'`, `kind: 30040 | 30041`, `title`, `naddr`,
    `url` (when `EDUFEED_APP_BASE_URL` set), `eventAuthor` fields per the
    existing helper.
  - 30040: `summary`, `authors` (plain `author` tags), `doi` (bare code,
    `doi:` prefix stripped from the `i` tag), `publicationType`
    (`academic`/`book`/… from the `type` tag), `additionalType`
    (schema.org type extension tag), `publishedOn` (`published_on`),
    `publishedBy` (`published_by`), `sourcePage`/`identifier` following the
    existing 67590fd conventions (`source` tag → sourcePage; `i` tag →
    identifier), `keywords` (`t` tags), `language` (`inLanguage`),
    `license` (`license:id`), `partOf` (coords of `a` tags with
    `isPartOf`/`isOutputOf` marker), `sections` (coords of bare or
    event-id-hinted `a` tags — mirror the relay's marker rule: 4th element
    empty/absent/64-hex → section; `isPartOf`/`isOutputOf` → partOf; any
    other word marker → neither).
  - 30041: `excerpt` (body text via the existing `excerpt` helper);
    metadata fields stay absent.
- Fields are optional/sparse; absent tags → absent fields (existing
  degradation pattern).

## 2. search_content

- `src/relay/filters.ts`: `CONTENT_TYPE_KINDS` gains `publication` →
  `[30040, 30041]` (adapt the map's value shape if it is currently
  single-kind); the `buildContentFilter` default type list includes
  `publication`; all 30145 references removed.
- `src/content/transform.ts`: `publicationToContentResult(event)` handles
  both kinds by `event.kind`; registered in `CONTENT_TRANSFORMS` under
  30040 and 30041. `transferkioskToContentResult` loses its 30145
  publication branch/fields; kinds 30143/30144 (projekt/massnahme)
  unchanged.
- `src/tools/searchContent.ts`: `types` zod enum keeps the literal
  `publication` (meaning changes to NKBIP-01); tool title/description
  updated — including LLM-facing facet hints: append `type:academic`,
  `doi:10.x/...`, `partOf:30143:<pubkey>:<d>` inside the `search` string
  (NIP-50 field syntax; the relay does not support bare tag filters for
  these).
- Snippets: no changes — the existing kind-21142 attachment works for
  30040 (verified live 2026-07-18).

## 3. get_resource kind dispatch (net-new, generic)

- `naddrToLookup` (`src/tools/get.ts`) returns `kind` alongside
  `identifier`/`author`.
- `src/relay/client.ts`: `getByDTag`/`getById` accept a kinds parameter
  (defaulting to `[30142]` so `search_resources`/legacy callers are
  untouched).
- `get.ts` dispatch:
  - kind 30142 → the EXISTING full path (`eventToAMBResource` +
    `toSimplifiedResource`) byte-identical — zero regression.
  - any other kind present in `CONTENT_TRANSFORMS` (30023, 30818, 30040,
    30041, 30143, 30144, 31922/31923 if registered) → fetch with that
    kind, format via the registry transform, return the content-result
    shape.
  - unregistered kind → explicit error `naddr kind <k> is not served by
    this server` (today's behavior is a silent empty result).

## 4. Docs

- `README.md`: `search_content` section lists the current types
  (resources, articles, wikis, projekt, massnahme, publication) — it is
  stale today (still pre-transferkiosk); fix the whole list. `get_resource`
  section documents the naddr-kind dispatch.
- `src/server-info.ts` SERVER_INSTRUCTIONS: mention publications.
- `.env.example` comment listing relay-served kinds: update.

## 5. Testing

- `test/content/transform.test.ts`: new publication block — (a) migrated
  transferkiosk-shape 30040 (doi, partOf via isOutputOf, creator runs,
  publicationType concept tags present-but-ignored), (b) wild
  Alexandria-shape 30040 (many bare `a` sections, `i` isbn, no license),
  (c) 30041 with body → excerpt, (d) marker-rule cases (64-hex 4th element
  → sections; vocab word marker → neither).
- `test/relay/contentFilter.test.ts`: defaults assertion = [30142, 30023,
  30818, 30143, 30144, 30040, 30041, 21142] (30145 gone); subset case for
  `types:['publication']` → [30040, 30041].
- `test/tools/searchContent.test.ts`: mixed-kind integration including a
  30040 and a 30041.
- `test/tools/getResource.test.ts`: naddr kind propagation; dispatch:
  30142 regression (existing shape unchanged), 30040 → PublicationResult,
  30143 → transferkiosk result, unregistered kind → error.
- Manual smoke against dev after implementation: `search_content` for a
  known migrated publication; `get_resource` with its naddr; `get_resource`
  with a projekt naddr.

## Out of scope

- Signer/publish tools for 30040 (edufeed-app owns authoring).
- Relay changes (none needed — verified live).
- Calendar client changes; resolve_author/list_known_authors (kind-agnostic,
  verified).
- Surfacing snippet events in results beyond the existing attachSnippets
  behavior.
