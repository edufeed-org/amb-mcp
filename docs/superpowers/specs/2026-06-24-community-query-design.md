# Community-query support in amb-mcp — Design

**Date:** 2026-06-24
**Status:** Draft (awaiting review)
**Repos:** `edufeed/amb-mcp` (primary) + `edufeed/amb-relay` (one supporting change)

## 1. Goal

Let amb-mcp answer **"what was shared with community X"** against the
reworked amb-relay. Today amb-mcp has zero community awareness: no tool
accepts a community, none emits the relay's `community:<pubkey>` NIP-50
query. The deliverable is the **shared content itself** (the resources /
articles / wikis / events shared into a community via the relay's Phase-4
stamping), reachable by community name.

Out of scope (YAGNI): exposing raw share *events* (kind 16/30222 pointers)
as a separate tool; bidirectional/aggregation features.

## 2. Background — how the relay models this

- A community is a Nostr **pubkey** (Communikey spec). It has a normal
  kind-0 profile.
- Content shared into a community is **stamped**: the relay denormalizes
  the community pubkey onto the shared content's own Typesense doc
  (`community` field), so a NIP-50 `search:"community:<pubkey>"` over
  content kinds (30142/30023/30818/31922/31923) returns the shared content
  itself. This is member-gated (Phase-4).
- **Must use the NIP-50 `search:"community:X"` form, not a `#h:X` tag
  filter.** Stamped content carries no `h` tag on its signed event, so SDK
  clients that re-validate REQ results against raw tags drop it under `#h`.
  The `search:` form carries no tag to re-validate and surfaces stamped
  content on every client.
- The relay already **discovers the set of community pubkeys** (the
  `CommunityRegistry` backfill scans `h`/`p` targets of shares + content),
  but it does **not** index community kind-0 profiles: the
  `ProfileManager` only enqueues kind-0 for *event authors*, and a
  community is named in a share's `h` tag, never as the author. So
  `resolve_author` (which searches the `profiles_0` index) cannot find
  communities today.

## 3. Components

### Component 1 — Relay: index community profiles

**Problem it solves:** name→pubkey resolution. Without community kind-0 in
`profiles_0`, no name lookup is possible.

**Change:** feed the already-discovered community pubkeys into the existing
`ProfileManager`, so each community's kind-0 is fetched from
`PROFILE_RELAYS` into the `profiles_0` collection — on the same Init +
refresh cadence as author profiles, plus on live discovery when a new share
targets a previously-unseen community.

**Reuses existing machinery — no new fetch/index logic:**
- `CommunityRegistry` already enumerates community pubkeys (the backfill
  feeding `IsMember`).
- `ProfileManager.Enqueue(pk)` + its durable queue + drain loop already
  fetch and index kind-0 from `PROFILE_RELAYS`.

**Wiring:** union the discovered community pubkeys into the source that
feeds `ProfileManager` — i.e. the profile backfill becomes
`content-authors ∪ discovered-communities`, and a community newly
discovered at share-write time is enqueued the same way an author is. Exact
call sites to be fixed in the plan; the design constraint is "reuse
`Enqueue`, add no parallel fetch path."

**Result:** community kind-0 lands in `profiles_0` next to author
profiles, so the existing kind-0 search resolves community names with zero
new query code.

### Component 2 — amb-mcp: `community` filter on `search_content`

Add an optional `community` parameter to `search_content`:

- Accepts a community **hex pubkey or npub**; normalize npub→hex.
- When set, append `community:<hex>` to the NIP-50 search string built in
  `buildContentFilter` (`src/relay/filters.ts`), space-joined with any
  free-text `query` (both can be present: "math resources shared with X").
- Wire through `ContentSearchParams`, `runContentSearch`
  (`src/tools/searchContent.ts`), and the tool `inputSchema`.

Returns the shared content itself across kinds 30142/30023/30818 (the
existing multi-kind path), ranked as usual, with 21142 snippets intact.
This is the core deliverable.

### Component 3 — amb-mcp: name resolution by reusing `resolve_author`

**Decision: no new tool.** With Component 1, community kind-0s are in
`profiles_0`, so `resolve_author(name)` already returns communities
alongside people. We only **update `resolve_author`'s description** to state
that it also resolves communities and that the resulting pubkey feeds
`search_content`'s `community` param (and `search_calendar_events`'s).

A dedicated `resolve_community` would share the identical kind-0 backend;
its only possible value-add is *labeling* which candidates are communities
vs. people, but the relay exposes no community marker, so it cannot do so
cleanly. A wrong pick simply yields empty content results (self-correcting),
so the extra surface area is not justified.

### Component 4 — amb-mcp: `community` filter on `search_calendar_events`

Stamping also covers calendar event kinds (31922/31923), so add the same
`community` param (hex/npub→hex) to `search_calendar_events`, appending
`community:<hex>` to `filter.search` in `buildCalendarFilter`
(`src/calendar/filters.ts`).

**Documented limitation (relay routing):** on the calendar collection,
range/geo params (`#start_after`/`#start_before`/`#end_after`/`#end_before`/
`#g`) route the REQ to the relay's Bolt index, which **ignores `search`**.
So the `community` filter works **standalone** ("events shared with X") but
is **silently dropped when combined with a time-range/geo query** ("events
shared with X next week"). For that combined intent the caller composes it
client-side: query by `community` (full-text path), then post-filter the
returned events by date — matching the existing "combined intent composed
client-side" pattern. The param's tool description must state this.

## 4. Data flow

1. User: "what was shared with the &lt;X&gt; community?"
2. LLM → `resolve_author("X")` → candidate pubkeys (now includes
   communities, via Component 1).
3. LLM picks the community pubkey → `search_content({ community: pubkey })`
   (and/or `search_calendar_events({ community: pubkey })`).
4. amb-mcp builds a REQ with NIP-50 `search:"community:<hex>"`; the relay
   returns the stamped content/events.
5. LLM summarizes from the results (+ snippets).

## 5. Error handling

- Invalid/unknown community pubkey → empty result set, not an error.
- npub vs hex: normalize at the tool boundary; reject malformed input with
  a clear message.
- Content shared but not yet stamped → eventually consistent via the
  relay's existing community sweep; no special handling in amb-mcp.
- Component 1: a community whose kind-0 is absent on `PROFILE_RELAYS` simply
  won't resolve by name — the caller can still pass its pubkey directly.

## 6. Testing

**Relay (Component 1):**
- Unit: discovered community pubkeys are enqueued into the profile queue
  (alongside content authors), on both backfill and live discovery.
- Integration: after a share targeting community C is stored, C's kind-0
  (seeded on a stub `PROFILE_RELAYS`) becomes retrievable via the
  `profiles_0` / kind-0 search path.

**amb-mcp (Components 2–4):**
- Unit: `buildContentFilter` appends `community:<hex>` to `search`; combines
  correctly with a free-text `query`; npub normalizes to hex.
- Unit: `buildCalendarFilter` appends `community:<hex>` to `search`.
- Unit: malformed community input is rejected.
- (Description-only change for Component 3 needs no test.)

## 7. Build sequence

1. **Component 1 (relay)** first — name resolution depends on it; without
   it `resolve_author` can't surface communities. Ship + deploy to dev so
   the index populates.
2. **Component 2** (content `community` param) — the core deliverable;
   independently testable against a known community pubkey even before
   Component 1 populates names.
3. **Component 4** (calendar `community` param) — mirrors Component 2.
4. **Component 3** (description update) — last; only meaningful once
   Component 1 has populated community profiles on dev.

## 8. Open questions

- Exact relay wiring for Component 1 (backfill union vs. explicit enqueue
  hook in the registry) — resolved in the implementation plan.
- Whether to also surface the `community` field on content results (so the
  LLM can read which communities a result belongs to, aiding the
  pubkey-direct path). Deferred unless it proves useful — not required for
  the name→content flow above.
