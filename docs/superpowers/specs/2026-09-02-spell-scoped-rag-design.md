# Spell-scoped RAG grounding (`search_passages`)

**Date:** 2026-09-02
**Status:** approved design
**Repos touched:** amb-mcp (primary), amb-indexer (merge existing branch), homelab (key + env)

## Context

The AMB stack already contains the retrieval half of a RAG system: amb-indexer
extracts, chunks, and embeds the fulltext of resources referenced by content
events, and serves hybrid BM25⊕vector search over those chunks via
`POST /search_chunks`. The `feat/scoped-chunk-search` branch (commit `9f47f5a`)
added the two scope dimensions needed to say "answer only from this set":
`filter.pubkey` and `filter.event_coord`.

What is missing is a user-facing way to (1) *define* such a set and (2) *query*
it for grounding passages. This design uses **grimoire spells** (kind-777
events — portable REQ filters, per the grimoire draft NIP; edufeed runs a
grimoire instance at grimoire.edufeed.org) as the scope language, and adds a
grounding tool to amb-mcp that resolves a spell to a scope and returns ranked,
cited passages. Answer generation stays in the calling LLM — amb-mcp returns
grounding material, never generated answers.

Explicitly rejected in prior sessions (2026-09-01, recorded in project memory):
publishing passages or embedding vectors as Nostr events (copyright, no
consumer, third copy of the text). Chunks stay Typesense-internal; this design
only *reads* them.

## Decisions

- **Grounding tool, not answerer**: `search_passages` returns passages +
  citations; no server-side LLM generation.
- **Spell as the single internal scope representation**: inline scope params
  are converted to an in-memory kind-777 spell structure; exactly one
  resolve→filter→scope→passages code path exists.
- **No auto-publishing**: the tool never signs or publishes spells as a side
  effect. The canonical spell representation is *returned* so the caller can
  publish it (grimoire, `nak`) when a scope is worth keeping.
- **Full spell support**: `$me`/`$contacts` runtime variables and relative
  timestamps (`7d`, `1mo`, `now`) resolve server-side.
- **Curated spells** are published under a dedicated `edufeed-spells` key
  (new nsec in the homelab vault), not the indexer or a personal key.
- **No relay-side spell storage** in amb-relay for now (kind 777/30777 is not
  added to any accepted-kind set). Spells live on `wss://relay.edufeed.org`
  (the general relay) and wherever grimoire publishes them.
- **Never widen scope silently**: on any failure (indexer down, empty scope,
  unresolvable variable) the tool errors; it must not fall back to unscoped
  search.

## 1. Tool interface (amb-mcp)

New tool `search_passages`, registered in `src/tools/index.ts` via the existing
`registerTools` dispatcher (read profile — available on all transports, no
write capability needed).

**Input** (zod schema):

| Param | Type | Notes |
|---|---|---|
| `question` | string, required | natural-language or keyword query for passage ranking |
| `spell` | string, optional | nevent or hex event id of a kind-777 spell |
| `authors` | string[], optional | inline scope (npub/hex; `$me`/`$contacts` allowed) |
| `kinds` | number[], optional | inline scope |
| `tag` | `{letter, values[]}`, optional | inline scope, maps to spell `["tag", letter, ...values]` |
| `search` | string, optional | inline scope, NIP-50 term applied to the *event* scope (distinct from `question`) |
| `since` / `until` | string, optional | absolute Unix or relative (`7d`) |
| `me` | string, optional | explicit `$me` override (npub/hex) |
| `relays` | string[], optional | existing per-call relay selection pattern |
| `limit` | number, optional | passages to return; default 10, max 25 |

`spell` and inline scope are mutually exclusive in effect: if `spell` is given,
inline scope params are rejected with a validation error (not silently
ignored). At least one of them is required.

**Output** (structured content):

```jsonc
{
  "passages": [
    {
      "text": "…",            // omitted when license non-permissive; snippet always present
      "snippet": "…",
      "heading": "…", "page": 4, "source_url": "https://…",
      "event_coord": "30142:<pk>:<d>", "event_id": "…",
      "score": 0.83,
      "amb": { "name": "…", "creator": "…", "license": "…" }
    }
  ],
  "scope": {
    "spell": { "content": "…", "tags": [["cmd","REQ"], …] },  // canonical, ready to sign
    "spell_event_id": "…",        // only when a published spell was used
    "resolved_filter": { … },      // NIP-01 filter after variable/time resolution
    "mode": "passthrough" | "materialized",
    "events_in_scope": 137,
    "truncated": false             // true when the coord cap cut the scope
  }
}
```

## 2. Spell resolution

New module `src/spells/` with a pure core and thin IO edges:

- `parseSpell(event)` — kind-777 tags → internal `Spell` struct. Validates:
  `cmd` present and `REQ` (a `COUNT` spell is rejected — nothing to ground on),
  at least one filter tag. Follows the grimoire draft NIP grammar: `k` (one per
  kind), `authors` (single tag, multi-value), `ids`, `["tag", letter, ...]`
  wrapper for tag filters, `search`, `since`/`until`, `limit`, `relays`.
- `spellFromParams(params)` — inline scope → the same `Spell` struct (and its
  canonical event representation for the response).
- `resolveSpell(spell, ctx)` — resolves variables and relative timestamps into
  a concrete NIP-01 filter:
  - **`$me`** resolution order: explicit `me` param → ContextVM caller pubkey
    (`extra.authInfo.clientPubkey`, same pattern as `src/tools/signer.ts:31`)
    → connected signer session for that user. Unresolvable → structured error
    instructing the client to pass `me`.
  - **`$contacts`**: resolve `$me`, fetch their kind-3 from `SPELL_RELAYS`
    (fallback `wss://purplepag.es`), expand to p-tag pubkeys. Missing/empty
    kind-3 → error (spec: "MUST NOT send").
  - **Relative timestamps**: `<n><unit>` with units `s m h d w mo y`
    (`mo`=30d, `y`=365d) and `now`, resolved against wall clock at execution.
- Spell fetching (`spell` param): by event id from, in order, nevent relay
  hints, the call's effective relays, `SPELL_RELAYS`. Not found → error naming
  the relays tried.

## 3. Scope → passages

Two automatic modes over the resolved filter:

- **Passthrough**: filter contains only `authors` and/or `kinds` → map
  directly to `/search_chunks` `filter.pubkey` / `filter.kinds`. No relay REQ.
  The pubkey list is subject to the same cap of 200 (a `$contacts` expansion
  can be long); beyond it, truncate and set `scope.truncated`. The spell's own
  `limit` tag is ignored in this mode — the scope is defined by the filter,
  not a result count.
- **Materialize**: anything else (`#x` tags, `search`, `since`/`until`, `ids`)
  → run the REQ via the existing `AMBRelayClient` against the effective AMB
  relay (REQ limit = min(spell `limit`, 500) when the spell carries one, else
  500), collect addressable coords (`kind:pubkey:d`), pass as
  `filter.event_coord`. **Coord cap 200** (Typesense `filter_by` length
  safety): if the scope matched more events, truncate to the 200 newest and
  set `scope.truncated: true` so the client knows grounding is partial.

Then `POST {indexer}/search_chunks` with
`{ q: question, k: limit, filter: {...} }` and
`Authorization: Bearer $INDEXER_API_TOKEN`. Response hits map 1:1 onto the
output passages (the indexer already omits `text` for non-permissive chunks
and always provides `snippet`).

Empty scope (0 events matched) → error "spell matched no events", not an
empty-but-successful grounding.

## 4. Indexer wiring

- amb-mcp env:
  - `INDEXER_ENDPOINTS` — comma-separated `wss://relay=https://indexer-base`
    pairs mapping each AMB relay to its indexer's HTTP base URL.
  - `INDEXER_API_TOKEN` — bearer token for `/search_chunks` (single token to
    start; per-endpoint tokens only if instances ever diverge).
  - `SPELL_RELAYS` — default `wss://relay.edufeed.org`.
- The tool resolves the indexer from the call's effective relay. A relay
  without a mapping → error "no passage index for this relay".
- amb-indexer: merge `feat/scoped-chunk-search` (`9f47f5a`, already reviewed —
  scope filters `pubkey`/`event_coord` on `/search_chunks`); fix the stale
  comment in `cmd/mcp/tool.go:16-18` claiming a four-field allowlist.
- homelab: expose/confirm the indexer HTTP endpoint reachable by the deployed
  amb-mcp, add the env vars to its deployment, add
  `vault_edufeed_spells_nsec` to the vault.

## 5. Curated edufeed spells

- `spells/` directory in the amb-mcp repo: one JSON file per spell holding the
  kind-777 template (`content` description, tags: `cmd`, `name`, filter tags,
  `t` topic tags, `alt`), plus `spells/publish.mjs` — signs with the
  `edufeed-spells` key and publishes to `SPELL_RELAYS` via `nak` or
  nostr-tools; idempotent re-publish creates a new event (spells are
  immutable; a revision forks with an `e` tag to its parent per the draft NIP).
- The key gets a kind-0 profile (`name: edufeed spells`, about text pointing
  at the repo) so curation is a recognizable identity in grimoire.
- Initial set (drafts, refined at implementation time): per-corpus scopes
  (edufeed AMB, OERSI, SODIX), per-content-type (publications 30040,
  calendar 31923), one community-scoped example
  (`["search","community:<pk>"]`).

## 6. Error handling

All errors structured and actionable; the tool never silently degrades:
spell not found (names relays tried) • spell is COUNT • `$me` unresolvable
(says how to fix) • `$contacts` empty • scope matched 0 events • scope
truncated (warning in response, not error) • no indexer for relay • indexer
unreachable/401 (no fallback to unscoped search).

## 7. Testing

- Unit (vitest, existing patterns): spell parsing (valid grammar, all filter
  tags, rejection cases: missing `cmd`, COUNT, no filter tags, `d` tag);
  `spellFromParams` round-trip (params → spell → same resolved filter);
  variable resolution (`$me` order, `$contacts` expansion) and relative
  timestamps (mocked clock); passthrough-vs-materialize routing; coord cap +
  truncation flag; every error path. Relay pool and indexer HTTP mocked.
- Integration: one test against the dev compose stack (Typesense + local
  amb-relay, as in the repo's existing `docker-compose.yml` dev flow) running
  a published spell end-to-end to passages.
- Manual verification: `search_passages` via stdio transport against dev
  (relay.edufeed.org spells + dev indexer), confirming citations resolve to
  real resources.

## Out of scope

- Server-side answer generation (may layer on later for edufeed-app).
- Storing kind 777/30777 on the AMB relays.
- Publishing passages or embedding vectors as events (rejected 2026-09-01).
- Spellbooks (kind 30777) — grimoire workspace snapshots, irrelevant to
  grounding.
- `$contacts`-heavy social scoping beyond plain kind-3 expansion.
