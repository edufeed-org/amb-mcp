# Changelog

All notable changes to amb-mcp are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/) (0.x — the API may still change between minors).

## [0.1.0] - 2026-08-11

First public release.

### Added

- **Three transports:** Nostr/ContextVM (`src/index.ts`), stdio for local MCP
  clients (`src/stdio.ts`), and Streamable HTTP (`src/http.ts`).
- **Cross-content search** (`search_content`) across educational resources
  (kind 30142), long-form articles (30023), wikis (30818), transferkiosk
  projects/measures (30143/30144), and NKBIP-01 scientific publications
  (30040/30041), with semantic snippet re-ranking and facet-in-query syntax
  (`type:`, `doi:`, `keywords:`, `partOf:`).
- **Resource tools:** `search_resources`, `get_resource` (naddr/d-tag/event-id,
  generic kind dispatch), `browse_subjects`, `browse_resource_types`,
  `browse_educational_levels`, `relay_stats`, `list_relays`, `relay_list_get`.
- **Author tools:** `resolve_author` (kind-0 profile index search) and
  `list_known_authors` (NIP-51 follow sets).
- **Calendar tools:** `search_calendar_events` (NIP-52, temporal/geohash/hashtag
  filters) and `list_calendar_authors`.
- **SKOS vocabulary tools:** read suite (`skos_search`, `skos_get_concept`,
  `skos_get_vocabulary`, …) and authoring/builder suite for publishing
  vocabularies as Nostr events.
- **`extract_metadata`:** URL/PDF → AMB/EKW form-prefill payload with optional
  LLM-grounded SKOS field extraction (`amb`/`ekw`/`konfi` variants), also
  available as a library export (`amb-mcp/lib`).
- **Signing & publishing** (stdio/Nostr transports only): NIP-46 remote signing
  with QR flow, NIP-65 outbox publishing, kind 0 and kind 30142 event builders.
- **OAuth resource server** on the HTTP transport: anonymous read-only sessions,
  `mcp:read`/`mcp:extract` scopes via Keycloak-issued JWTs, protected-resource
  metadata document; write tools are never exposed over HTTP.

### Changed

- `CALENDAR_RELAYS` now defaults to the main AMB relay
  (`wss://relay.edufeed.org`), which serves NIP-52 calendar events itself; a
  separate calendar relay remains supported for split deployments.
