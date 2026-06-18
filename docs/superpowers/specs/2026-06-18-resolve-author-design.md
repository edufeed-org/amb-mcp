# Resolve Author (name → pubkey) — Design

**Date:** 2026-06-18
**Status:** Approved (design); implementation pending plan.

## Goal

Let the MCP resolve an org/person **name** to **pubkey(s)** dynamically, by
querying the relay's kind-0 author-profile index (NIP-50 `search` over
`kinds:[0]`). This unlocks name-driven content queries end-to-end — e.g. "the
recent learning content and blog articles of Jörg Lohrer" — by feeding the
resolved pubkey into the existing `search_content(authors: […])` path.

This is the deferred "MCP consumer" piece from
`2026-06-18-multi-content-mcp-design.md` ("Out of scope: the MCP consumer that
maps names→pubkeys and composes the calendar REQ").

## Background: what already exists (the gap)

- The relay now indexes kind-0 profiles of content authors behind
  `PROFILES_ENABLED` and serves them via `{kinds:[0], search:"<name>"}`
  (amb-relay, already deployed on `wss://dev.amb-relay.edufeed.org`).
- `search_content` (`src/tools/searchContent.ts`) already accepts
  `authors: string[]` (hex) with an **optional** `query`. So **step 2 —
  fetch content by pubkey — is fully supported today.** An author + recency
  query (no topic) is expressible because `buildContentFilter` only sets
  `filter.search` when `query` is present (`src/relay/filters.ts:165`).
- **The missing piece is step 1.** Two reasons:
  - `list_known_authors` (`src/tools/authors.ts`) resolves only curated
    NIP-51 follow-set members (`AMB_AUTHOR_SETS`) — it does **not** query the
    relay's profile index, so non-curated authors are invisible.
  - The relay client (`src/relay/client.ts`) hardcodes `kinds:[30142]` in
    `query`/`search`/`getById`/`getByDTag` (lines 75, 88, 100, 110). There is
    no `kinds:[0]` path. The generic `queryEvents(filter)` method (lines
    135–220), already used by calendar and content search, accepts an
    arbitrary filter and is the path we reuse.

`list_known_authors` stays as-is (curated directory) and `resolve_author` is
added as a **separate** tool — they answer different questions (a hand-curated
directory vs. a dynamic index lookup).

## Architecture

Three small additions, mirroring the existing `search_content` slice
(client method → transform → tool). All read-only; no config changes (dev
`AMB_RELAYS` and relay `PROFILES_ENABLED` already satisfied).

1. **`src/relay/client.ts` — add `searchProfiles(name, limit)`.** A thin method
   that builds `{ kinds:[0], search: name, limit }` and delegates to the
   existing `queryEvents(filter)`. The hardcoded `kinds:[30142]` methods are
   left untouched (back-compat; profiles route through the generic path that
   already works against the dev relay).
2. **`src/profiles/transform.ts` — `transformProfileEvent(event)`.** A pure
   function: kind-0 `nostr.Event` → `ProfileResult` or `null`. Parses the
   JSON `content`, reads `name`, `display_name` **or** `displayName`, `about`,
   `nip05`; encodes `npub` from the pubkey. Returns `null` for non-kind-0
   input or malformed JSON.
3. **`src/tools/resolveAuthor.ts` — `resolve_author` MCP tool.** Calls
   `searchProfiles`, transforms each event (skipping nulls), returns ranked
   candidates in relay arrival order (NIP-50 relevance). Registered in
   `src/tools/index.ts` next to `registerAuthorTools`.

## Data types

```ts
// src/profiles/types.ts
export interface ProfileResult {
  pubkey: string;       // hex
  npub: string;         // NIP-19 encoded
  name?: string;        // kind-0 "name"
  displayName?: string; // kind-0 "display_name" or "displayName"
  about?: string;       // kind-0 "about"
  nip05?: string;       // kind-0 "nip05"
}
```

## Component contracts

### `searchProfiles(name: string, limit?: number): Promise<NostrEvent[]>`

- Builds `{ kinds: [0], search: name, limit: clamp(limit ?? 10, 1, 25) }`.
- Delegates to `this.queryEvents(filter)`.
- Returns the raw kind-0 events (transform is the caller's job, matching how
  `runContentSearch` transforms after `queryEvents`).

### `transformProfileEvent(event: NostrEvent): ProfileResult | null`

- `event.kind !== 0` → `null`.
- `JSON.parse(event.content)` throws → `null` (malformed profile skipped).
- Maps fields; `displayName = meta.display_name ?? meta.displayName`.
- `npub = nip19.npubEncode(event.pubkey)`.
- Optional string fields omitted when absent/empty.

### `resolve_author` tool

- **Input:** `{ name: string (required), limit?: number (1–25, default 10) }`.
- **Output:** `{ total: number, candidates: ProfileResult[] }` as JSON text.
- Candidates preserve relay order (relevance-ranked). Returning several lets
  the LLM disambiguate.
- **Description** nudges the chaining: resolve the name here, take the top
  candidate's `pubkey`, then call
  `search_content({ authors: [pubkey], types, since, limit })` (and/or
  `search_calendar_events`) for that author's content.

## Data flow (full "Jörg Lohrer" query)

```
resolve_author("Jörg Lohrer")
   → { total: 1, candidates: [{ pubkey:"9b…", name:"Jörg Lohrer", … }] }
        ↓  (LLM selects top candidate)
search_content({ authors:["9b…"], types:["resource","article"],
                 since:<now-30d>, limit:20 })
   → recent resources + blog articles by that pubkey
```

No new combined endpoint; orchestration is LLM-driven over well-described
tools — the same pattern the multi-content design uses for the calendar
follow-up.

## Error handling & edge cases

- **Relay unreachable / query timeout** → `queryEvents` already resolves `[]`
  on timeout; tool returns `{ total: 0, candidates: [] }`. Never throws.
- **No match** → empty candidates, not an error.
- **`PROFILES_ENABLED` off on the relay** → relay returns nothing → empty
  result. No special-casing needed.
- **Malformed kind-0 `content`** → that candidate is skipped (`transform`
  returns `null`); other candidates still returned.
- **Sparse source profiles** (e.g. an org whose kind-0 has only an acronym in
  `name`) → resolution reflects what the index holds. A synonym/alias layer is
  explicitly out of scope.

## Testing (Vitest, matching existing suite)

- **`transformProfileEvent`** (table-driven): full kind-0 → all fields;
  `display_name` vs `displayName`; missing optionals omitted; malformed JSON →
  `null`; non-kind-0 input → `null`; `npub` derived correctly.
- **`searchProfiles`** filter shape: produces `{ kinds:[0], search, limit }`
  with limit clamped to 1–25 (assert against a stubbed `queryEvents`).
- **`resolve_author` tool**: given a mixed event array (incl. a non-kind-0 and
  a malformed kind-0), output `candidates` are the valid kind-0 profiles in
  order, with correct fields; `total` matches.
- **Optional live smoke** against `wss://dev.amb-relay.edufeed.org` (profiles
  enabled): `resolve_author("e-teaching")` returns at least one candidate.

## Out of scope (future)

- Synonym/alias resolution for sparse profiles (the MMKH-acronym case).
- Re-ranking candidates by NIP-05 validity or interaction signals.
- Refactoring the legacy `kinds:[30142]` client methods off their hardcoded
  kind.
- A single server-side combined name+content endpoint (kept LLM-orchestrated).
