# Multi-Content MCP Search — Design

**Date:** 2026-06-18
**Status:** Approved (design); implementation pending plan.

## Goal

Turn `amb-mcp` from a kind-30142-only query surface into a **topic-driven, multi-content concierge** over the new multi-content `amb-relay`. A natural-language question ("Meine Studierenden sind im Seminar immer so unaufmerksam, was kann ich dagegen tun?") should fan out across educational resources (30142), long-form articles (30023), and wikis (30818), return the best matches **with the passage that actually matched**, and let the LLM layer on contextual follow-ups ("…und nächste Woche findet dazu eine Veranstaltung statt" → calendar; later "…und hier wird das gerade diskutiert" → forums/communities).

## Background: what the relay already provides

The `amb-relay` (this session's work) exposes capabilities the MCP does not yet use:

- **Cross-content search in one REQ.** A NIP-50 `search` over `kinds:[30142,30023,30818]` returns results **interleaved and ranked by chunk score** (semantic passage match), via the content-type registry + chunk-rerank layer.
- **kind-21142 snippet events.** When a client adds `21142` to its `kinds`, the relay emits an **ephemeral** kind-21142 event immediately after each result, carrying the best-matching passage. Shape (from `nostrlib/khatru/semantic/snippet.go`):
  - `content` = the matched passage text
  - tag `e` = parent event id
  - tag `a` = parent coord `<kind>:<pubkey>:<d>`
  - tag `k` = parent kind (e.g. `30023`)
  - tag `score` = chunk score (`%.4f`)
  - optional tags `page`, `heading`, `source_url`
  - Snippets are relay-signed, never stored, and never emitted on the plain-Typesense fallback path.
- **Calendar (NIP-52) in the same relay.** 31922/31923/31924/31925 with a BoltDB range/geo index. Full-text `search` is supported on the calendar collection. **Contract caveat:** when a REQ carries both range/geo params (`#start_after`/`#start_before`/`#end_after`/`#end_before`/`#g`) **and** `search`, the Bolt range path wins and `search` is ignored for that REQ. Combined intent ("next week, about X") is therefore composed **client-side**.

The relay event payloads are standard Nostr events of each kind; the MCP transforms them from tags/content.

### Relevant event tag shapes

- **30142 (AMB):** metadata in colon-delimited tags (`name`, `description`, `about:id`, `creator:name`, …). Existing transform in `src/utils/transform.ts`.
- **30023 (long-form, NIP-23):** `d`, `title`, `summary`, `image`, `published_at`, `t[]`; `content` is Markdown.
- **30818 (wiki, NIP-54):** `d`, `title`, `summary`, `t[]`; `content` is Djot.

## Current MCP state (the gap)

- `src/relay/filters.ts:53`, `src/relay/client.ts:75,89` **hardcode `kinds:[30142]`** — long-form and wiki are invisible.
- `search_resources` is 30142-only and 30142-shaped (publisher/resourceType/educationalLevel facets).
- No kind-21142 capture anywhere, so search returns metadata but not the matched passage.
- Calendar is a **separate client** pointed at a separate relay (`CALENDAR_RELAYS=wss://dev.calendar-relay.edufeed.org`); `search_calendar_events` has **no free-text/topic param**.

## Design

### 1. New `search_content` tool (unified, relay-ranked, snippets on by default)

A single tool issuing **one** subscription with `kinds:[30142,30023,30818,21142]` + the NIP-50 `search`, preserving the relay's arrival order as the result order, and attaching each 21142 snippet to its parent by the `e` tag.

**Params:**

| Name | Type | Notes |
|------|------|-------|
| `query` | string | Free-text topic (required for meaningful ranking). |
| `types` | `("resource"\|"article"\|"wiki")[]` | Optional; default all three. Restricts the `kinds` set. |
| `language` | string | Default `"de"`; for label resolution. |
| `since` / `until` | number | NIP-01 created_at bounds. |
| `authors` | string[] | Hex pubkeys. |
| `limit` | number | 1–250, default 20. |

**Output** (interleaved, ranked; one entry per content event):

```jsonc
{ "total": 3, "results": [
  { "type": "resource", "kind": 30142, "title": "...", "description": "...",
    "snippet": "...matched passage...", "score": 0.82,
    "url": "https://app…/<naddr>", "naddr": "...",
    "author": { "pubkey": "..." }, "createdAt": 0,
    /* author carries only pubkey — relay events have no reliable display name */
    /* 30142-specific resolved labels: about, learningResourceType, educationalLevel */ },
  { "type": "article", "kind": 30023, "title": "...", "summary": "...",
    "excerpt": "...", "snippet": "...", "score": 0.79, "url": "...", "naddr": "...",
    "topics": ["..."], "publishedAt": 0 },
  { "type": "wiki", "kind": 30818, "title": "...", "summary": "...",
    "excerpt": "...", "snippet": "...", "score": 0.66, "url": "...", "naddr": "..." }
]}
```

- `snippet`/`score`/`page`/`heading`/`source_url` are present only when the relay emitted a matching 21142 (i.e. chunk-rerank active and a passage matched).
- `excerpt` is a short, length-capped slice of the article/wiki `content` (markdown/Djot) for when no snippet is available.
- `url` present only when `EDUFEED_APP_BASE_URL` is configured (existing behavior).

`search_resources` is **kept** as the specialized 30142-only tool (its facet filters: publisherName/creatorName/subjectLabel/resourceTypeLabel/educationalLevelLabel). `search_content` is the new default entry point for topic questions.

### 2. Relay client changes

- Generalize the client off the hardcoded `kinds:[30142]`: query/search/getById/getByDTag take an explicit kinds set (default 30142 for back-compat).
- Add an **order-preserving** multi-kind search method. It MUST use the `prepareSubscription` path (already used for calendar), not `querySync`: `querySync` does not preserve the relay's ranked arrival order, and the chunk-ranked interleave order is the whole point. The method collects content events and 21142 events together (21142 arrives after its parent, before EOSE), then post-processes: split out 21142 by kind, build `Map<parentEventId, snippet>` keyed on the `e` tag, attach to the matching content result, drop the raw snippet events from the result list.

### 3. Content transforms + registry

- Add `article` transform (30023 → `{title, summary, excerpt, topics, publishedAt, image, naddr, url, author}`).
- Add `wiki` transform (30818 → `{title, summary, excerpt, naddr, url, author}`).
- Define a shared `SimplifiedContentResult` with a `type` discriminant (`"resource" | "article" | "wiki"`), and a small **kind → transform** registry so adding a future forum/community kind is purely additive (register kind + transform).
- Reuse `naddr`/`url` encoding already in `toSimplifiedResource`.

### 4. Calendar: add topic param

- Add `query` to `search_calendar_events` → sets `search` on the calendar filter (relay full-text on the calendar collection).
- Tool description must state the **server-side caveat**: range/geo params win over `search`; for "next week about X", call with the range and then filter the returned events by topic client-side (the full event travels in the result). Range/geo behavior is unchanged. The session's geohash-prefix fix means coarse geohash prefixes now match finer stored values.

### 5. Configuration

- Point `AMB_RELAYS` at the new amb-relay (dev: `wss://dev.amb-relay.edufeed.org`). One relay now serves resources + articles + wikis + calendar.
- `CALENDAR_RELAYS` may be set to the **same** relay; the standalone calendar relay becomes optional. Keep the separate-client code path intact (config-driven) so a distinct calendar relay still works.
- Requires `LONGFORM_ENABLED`, `WIKI_ENABLED`, `CALENDAR_ENABLED`, and chunk-rerank (`CHUNK_RERANK_ENABLED` + `INDEXER_API_TOKEN`) on the relay for the full experience. All on for dev. Snippets degrade gracefully to absent when chunk-rerank is off (results still returned, just without passages).

### 6. The follow-up orchestration ("…and there's an event next week")

Not a new endpoint — LLM orchestration over good, well-described tools:

1. `search_content(query)` → resources + articles + wikis with passages.
2. `search_calendar_events(query=<topic>, startAfter=now, startBefore=now+7d)` → upcoming events.

Tool descriptions are written to nudge this chaining. A future `forum`/`community` content type slots into the same registry + a third orchestration hop.

## Error handling & edge cases

- **Chunk-rerank off / indexer down:** relay falls back to plain Typesense search; no 21142 emitted. `search_content` returns results with `snippet` absent. Never an error.
- **Snippet without a matching parent in the batch:** drop it (defensive; shouldn't happen since snippet follows its parent in the same REQ).
- **Missing required tags** (`title`/`d`): transform returns null and the event is skipped (mirrors existing 30142 behavior).
- **`types` filtering** maps to the `kinds` set; `21142` is always added when any content type is selected.
- **Ordering:** result order = relay arrival order (ranked). Snippet attachment must not reorder.

## Testing

- Vitest unit tests for: the article transform, the wiki transform, the snippet→parent association (given a mixed event array incl. 21142, results carry correct snippets and 21142 is excluded), and the `types`→kinds mapping.
- Calendar `query`→`search` filter-builder test.
- Optional live smoke against `wss://dev.amb-relay.edufeed.org` (all gates on) via the existing test-client pattern.

## Out of scope (future)

- Forum/community content type (slots into the registry when the relay registers the kind).
- Server-side combined topic+range calendar query (currently client-composed by contract).
- Re-ranking across calendar + content in a single list.
```
