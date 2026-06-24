# Community-Query Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let amb-mcp answer "what was shared with community X" — add an optional `community` filter to `search_content` and `search_calendar_events`, and make community names resolvable through the existing `resolve_author` tool by indexing community kind-0 profiles on the relay.

**Architecture:** Two repos. (A) **amb-relay** (Go): feed the already-discovered community pubkeys into the existing `ProfileManager` so each community's kind-0 lands in `profiles_0` alongside author profiles — reusing `backfillCommunities`, `shareCommunities`, and `ProfileManager.Enqueue`; no new fetch/index path. (B) **amb-mcp** (TypeScript): a shared `normalizeCommunityPubkey` helper (built on the existing `nostr-tools` `nip19`) plus a `community` param on the two search tools that appends `community:<hex>` to the NIP-50 search string.

**Tech Stack:** Go (amb-relay, `fiatjaf.com/nostr`), TypeScript + Vitest + `nostr-tools` (amb-mcp), Typesense NIP-50 search.

## Global Constraints

- **Reuse, don't reinvent.** Relay: reuse `backfillCommunities` (`community_registry.go:134`), `backfillAuthors` (`profile_manager.go:60`), `shareCommunities` (`shares.go:41`), `ProfileManager.Enqueue` (`profile_manager.go:102`), `nostr.PubKeyFromHex`. amb-mcp: reuse the existing `nostr-tools` `nip19` dependency — do **not** add applesauce or any new dependency.
- **Query via NIP-50 `search:"community:<hex>"`, never a `#h:X` tag filter.** Stamped content carries no `h` tag on its signed event; SDK clients re-validate `#h` against raw tags and drop it. The `search:` form has no tag to re-validate.
- **Community input accepts hex pubkey OR npub; normalize to hex at the filter boundary; reject malformed with a clear error.**
- **Relay change is gated by existing flags** (`PROFILES_ENABLED`, `COMMUNITY_SHARES_ENABLED`). When `profileMgr` is nil, community enqueue is a no-op.
- **TDD throughout:** failing test → minimal impl → green → commit. Run relay tests with `GOWORK=off go test ./...` from `/home/laoc/coding/edufeed/amb-relay`; run amb-mcp tests with `npm test` from `/home/laoc/coding/edufeed/amb-mcp`.
- **Build order:** relay Component 1 (Tasks 1–2) ships first and deploys to dev so `profiles_0` populates; amb-mcp Tasks 3–5 are independently testable against a known community pubkey even before names populate; Task 6 (descriptions) last.

---

## Repo A — amb-relay (Go), Component 1: index community profiles

Working dir: `/home/laoc/coding/edufeed/amb-relay`. Test command: `GOWORK=off go test ./...`.

### Task 1: Union discovered communities into the profile backfill

Fold community pubkeys into the source that feeds `ProfileManager`, so Init **and** the periodic refresh both index community kind-0 — via one change to the existing backfill closure. Extract a small named, unit-testable function rather than inlining a union in the closure.

**Files:**
- Modify: `profile_manager.go` (add `backfillProfileCandidates`)
- Modify: `main.go:470-475` (hoist `communityKinds`), `main.go:578` (swap the closure body)
- Test: `profile_manager_test.go` (add `TestBackfillProfileCandidatesUnionsCommunities`)

**Interfaces:**
- Consumes: `backfillAuthors(q eventQuerier, kinds []nostr.Kind, maxLimit int) []nostr.PubKey`; `backfillCommunities(q eventQuerier, kinds []nostr.Kind, maxLimit int) []string`; `nostr.PubKeyFromHex(string) (nostr.PubKey, error)`.
- Produces: `backfillProfileCandidates(q eventQuerier, contentKinds, communityKinds []nostr.Kind, maxLimit int) []nostr.PubKey` — the de-duplicated union of content authors and discovered community pubkeys. Consumed by the profile backfill closure in `main.go`.

- [ ] **Step 1: Write the failing test**

Add to `profile_manager_test.go` (reuses the existing `sliceQuerier` fake at line 46):

```go
func TestBackfillProfileCandidatesUnionsCommunities(t *testing.T) {
	skAuthor, skCommunity := nostr.Generate(), nostr.Generate()
	authorPk, communityPk := skAuthor.Public(), skCommunity.Public()

	// A content event by authorPk, and a kind-16 share targeting communityPk via its h tag.
	content := nostr.Event{Kind: 30142, PubKey: authorPk, CreatedAt: 1700000000}
	share := nostr.Event{
		Kind:      16,
		PubKey:    nostr.Generate().Public(), // sharer, not a community
		CreatedAt: 1700000001,
		Tags:      nostr.Tags{{"h", communityPk.Hex()}, {"e", "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}},
	}
	q := sliceQuerier{events: []nostr.Event{content, share}}

	got := backfillProfileCandidates(q, []nostr.Kind{30142}, []nostr.Kind{16}, 1000)

	has := func(target nostr.PubKey) bool {
		for _, pk := range got {
			if pk == target {
				return true
			}
		}
		return false
	}
	if !has(authorPk) {
		t.Errorf("union missing content author %s", authorPk.Hex())
	}
	if !has(communityPk) {
		t.Errorf("union missing discovered community %s", communityPk.Hex())
	}
	// No duplicates.
	seen := map[nostr.PubKey]bool{}
	for _, pk := range got {
		if seen[pk] {
			t.Errorf("duplicate pubkey %s in union", pk.Hex())
		}
		seen[pk] = true
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `GOWORK=off go test ./... -run TestBackfillProfileCandidatesUnionsCommunities`
Expected: FAIL — `undefined: backfillProfileCandidates`.

- [ ] **Step 3: Write minimal implementation**

Add to `profile_manager.go` (next to `backfillAuthors`):

```go
// backfillProfileCandidates returns the de-duplicated union of content authors
// and discovered community pubkeys, so the profile index covers communities
// (named in share h/p tags, never as event authors) on the same Init+refresh
// cadence as authors. Reuses backfillAuthors + backfillCommunities; adds no
// fetch path.
func backfillProfileCandidates(q eventQuerier, contentKinds, communityKinds []nostr.Kind, maxLimit int) []nostr.PubKey {
	out := backfillAuthors(q, contentKinds, maxLimit)
	seen := make(map[nostr.PubKey]bool, len(out))
	for _, pk := range out {
		seen[pk] = true
	}
	for _, hexpk := range backfillCommunities(q, communityKinds, maxLimit) {
		pk, err := nostr.PubKeyFromHex(hexpk)
		if err != nil || seen[pk] {
			continue
		}
		seen[pk] = true
		out = append(out, pk)
	}
	return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `GOWORK=off go test ./... -run TestBackfillProfileCandidatesUnionsCommunities`
Expected: PASS.

- [ ] **Step 5: Wire the union into the profile backfill closure**

`communityKinds` is currently declared at `main.go:613`, inside the `sharesEnabled` block — *after* the profile block at line 574. Hoist it so the profile closure can reference it.

In `main.go`, immediately after the `profileContentKinds` loop (currently ending at line 475), add:

```go
	// Discovery scope for communities: share kinds + content kinds (content can
	// carry its own h tag). Declared here so the profile backfill closure below
	// can union communities in; reused by the community registry further down.
	communityKinds := append([]nostr.Kind{16, 30222}, profileContentKinds...)
```

Then delete the now-duplicate declaration at `main.go:611-613` (the `// Discovery scope: share kinds + content kinds...` comment and its `communityKinds :=` line), leaving the `communityReg = NewCommunityRegistry(` call that uses it intact.

Finally, change the profile backfill closure at `main.go:578` from:

```go
			func() []nostr.PubKey { return backfillAuthors(&boltDB, profileContentKinds, 1_000_000) },
```

to:

```go
			func() []nostr.PubKey {
				return backfillProfileCandidates(&boltDB, profileContentKinds, communityKinds, 1_000_000)
			},
```

- [ ] **Step 6: Verify the build and full suite**

Run: `GOWORK=off go build . && GOWORK=off go test ./...`
Expected: build succeeds; all tests PASS. (If `go vet` flags the hoisted `communityKinds` as unused when `sharesEnabled` is false — it won't, because the profile closure references it unconditionally — re-check the edit.)

- [ ] **Step 7: Commit**

```bash
git add profile_manager.go profile_manager_test.go main.go
git commit -m "feat(community): index discovered community kind-0 via profile backfill union"
```

### Task 2: Enqueue share-target communities on share write (live discovery)

A newly-discovered community should be enqueued the moment a share targets it, not only on the next 6h refresh — mirroring how content authors are enqueued live on write (`main.go:830,850`).

**Files:**
- Modify: `profile_manager.go` (add `enqueueShareCommunities`)
- Modify: `main.go:832-843` (StoreEvent share branch), `main.go:852-863` (ReplaceEvent share branch)
- Test: `profile_manager_test.go` (add `TestEnqueueShareCommunities`)

**Interfaces:**
- Consumes: `shareCommunities(event *nostr.Event) []string` (`shares.go:41`); `ProfileManager.Enqueue(nostr.PubKey)`; `nostr.PubKeyFromHex`.
- Produces: `enqueueShareCommunities(pm *ProfileManager, event nostr.Event)` — nil-safe; enqueues every valid community pubkey targeted by a share event.

- [ ] **Step 1: Write the failing test**

Add to `profile_manager_test.go`:

```go
func TestEnqueueShareCommunities(t *testing.T) {
	communityPk := nostr.Generate().Public()
	share := nostr.Event{
		Kind:      16,
		PubKey:    nostr.Generate().Public(),
		CreatedAt: 1700000000,
		Tags:      nostr.Tags{{"h", communityPk.Hex()}, {"e", "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}},
	}

	q := newFakeQueue()
	mgr := NewProfileManager(q, fakeSource{}, func(nostr.Event) {}, func() []nostr.PubKey { return nil }, []string{"wss://x"}, 50)

	enqueueShareCommunities(mgr, share)

	queued, _ := q.ListProfileQueue()
	if len(queued) != 1 || queued[0] != communityPk.Hex() {
		t.Fatalf("queue = %v, want [%s]", queued, communityPk.Hex())
	}

	// nil ProfileManager must be a safe no-op (profiles disabled).
	enqueueShareCommunities(nil, share)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `GOWORK=off go test ./... -run TestEnqueueShareCommunities`
Expected: FAIL — `undefined: enqueueShareCommunities`.

- [ ] **Step 3: Write minimal implementation**

Add to `profile_manager.go`:

```go
// enqueueShareCommunities enqueues the kind-0 fetch for every community a share
// (kind 16/30222) targets, so a brand-new community's name resolves on the next
// drain instead of waiting for the periodic backfill. nil-safe: a no-op when
// profiles are disabled.
func enqueueShareCommunities(pm *ProfileManager, event nostr.Event) {
	if pm == nil {
		return
	}
	for _, hexpk := range shareCommunities(&event) {
		if pk, err := nostr.PubKeyFromHex(hexpk); err == nil {
			pm.Enqueue(pk)
		}
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `GOWORK=off go test ./... -run TestEnqueueShareCommunities`
Expected: PASS.

- [ ] **Step 5: Wire into the share-write branches**

In `main.go` StoreEvent, the `case 16, 30222:` branch (currently lines 833-835) becomes:

```go
			case 16, 30222:
				enqueueShareCommunities(profileMgr, event)
				go stamper.reconcileShare(event)
```

Apply the identical edit to the ReplaceEvent `case 16, 30222:` branch (currently lines 853-855).

- [ ] **Step 6: Verify the build and full suite**

Run: `GOWORK=off go build . && GOWORK=off go test ./...`
Expected: build succeeds; all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add profile_manager.go profile_manager_test.go main.go
git commit -m "feat(community): enqueue share-target communities for live profile discovery"
```

---

## Repo B — amb-mcp (TypeScript), Components 2–4

Working dir: `/home/laoc/coding/edufeed/amb-mcp`. Test command: `npm test`.

### Task 3: `normalizeCommunityPubkey` helper (shared normalize point)

One DRY helper used by both filters. Accepts hex or npub, returns hex, throws on malformed.

**Files:**
- Create: `src/utils/community.ts`
- Test: `test/utils/community.test.ts`

**Interfaces:**
- Consumes: `nip19` from `nostr-tools` (existing dependency).
- Produces: `normalizeCommunityPubkey(input: string): string` — returns a 64-char lowercase hex pubkey; throws `Error` on malformed input.

- [ ] **Step 1: Write the failing test**

Create `test/utils/community.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { nip19 } from 'nostr-tools';
import { normalizeCommunityPubkey } from '../../src/utils/community.js';

describe('normalizeCommunityPubkey', () => {
  const hex = '660d8c78651f70487ec9b8ddc283e29cf2561693dda3ba246d3fd3c08dbb7083';

  it('passes a 64-char hex pubkey through (lowercased)', () => {
    expect(normalizeCommunityPubkey(hex)).toBe(hex);
    expect(normalizeCommunityPubkey(hex.toUpperCase())).toBe(hex);
  });

  it('decodes an npub to hex', () => {
    const npub = nip19.npubEncode(hex);
    expect(normalizeCommunityPubkey(npub)).toBe(hex);
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeCommunityPubkey(`  ${hex}  `)).toBe(hex);
  });

  it('throws on malformed input', () => {
    expect(() => normalizeCommunityPubkey('not-a-pubkey')).toThrow(/expected/i);
    expect(() => normalizeCommunityPubkey('nsec1xyz')).toThrow(/expected/i);
    expect(() => normalizeCommunityPubkey('abc123')).toThrow(/expected/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- community`
Expected: FAIL — cannot resolve `../../src/utils/community.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/utils/community.ts`:

```typescript
import { nip19 } from 'nostr-tools';

const HEX64 = /^[0-9a-f]{64}$/i;

/**
 * Normalize a community identifier (hex pubkey or npub) to a 64-char lowercase
 * hex pubkey. Throws on malformed input so the tool layer surfaces a clear error.
 */
export function normalizeCommunityPubkey(input: string): string {
  const value = input.trim();
  if (HEX64.test(value)) return value.toLowerCase();
  if (value.startsWith('npub1')) {
    try {
      const decoded = nip19.decode(value);
      if (decoded.type === 'npub') return decoded.data;
    } catch {
      // fall through to the error below
    }
  }
  throw new Error(`Invalid community: expected a 64-char hex pubkey or npub, got "${input}"`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- community`
Expected: PASS (all four cases).

- [ ] **Step 5: Commit**

```bash
git add src/utils/community.ts test/utils/community.test.ts
git commit -m "feat(community): add normalizeCommunityPubkey helper"
```

### Task 4: `community` param on `search_content` (Component 2 — core deliverable)

**Files:**
- Modify: `src/relay/filters.ts` (`ContentSearchParams` interface + `buildContentFilter`, ~lines 8-31 and 156-169)
- Modify: `src/tools/searchContent.ts` (`inputSchema` ~lines 61-80; thread `community` into `ContentSearchParams` inside `runContentSearch`)
- Test: `test/relay/filters.test.ts`

**Interfaces:**
- Consumes: `normalizeCommunityPubkey` (Task 3).
- Produces: `ContentSearchParams.community?: string`; `buildContentFilter` appends `community:<hex>` to `filter.search`, space-joined with any free-text `query`.

- [ ] **Step 1: Write the failing test**

Add to `test/relay/filters.test.ts` (mirror the existing `buildContentFilter` describe block; import `nip19` at top if not present):

```typescript
import { nip19 } from 'nostr-tools';

describe('buildContentFilter community param', () => {
  const hex = '660d8c78651f70487ec9b8ddc283e29cf2561693dda3ba246d3fd3c08dbb7083';

  it('sets search to community:<hex> when only community is given', () => {
    const filter = buildContentFilter({ community: hex });
    expect(filter.search).toBe(`community:${hex}`);
  });

  it('space-joins free-text query and community', () => {
    const filter = buildContentFilter({ query: 'mathematik', community: hex });
    expect(filter.search).toBe(`mathematik community:${hex}`);
  });

  it('normalizes an npub community to hex', () => {
    const npub = nip19.npubEncode(hex);
    const filter = buildContentFilter({ community: npub });
    expect(filter.search).toBe(`community:${hex}`);
  });

  it('throws on malformed community', () => {
    expect(() => buildContentFilter({ community: 'garbage' })).toThrow(/expected/i);
  });
});
```

(If `buildContentFilter` is not yet imported in this file, add it to the existing import from `../../src/relay/filters.js`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- relay/filters`
Expected: FAIL — `community` is not a valid `ContentSearchParams` key / search not assembled.

- [ ] **Step 3: Write minimal implementation**

In `src/relay/filters.ts`, add to the `ContentSearchParams` interface:

```typescript
  /** Community hex pubkey or npub; appends NIP-50 community:<hex> to the search. */
  community?: string;
```

Add the import at the top of the file:

```typescript
import { normalizeCommunityPubkey } from '../utils/community.js';
```

Replace the single search-assignment line in `buildContentFilter` (`if (params.query?.trim()) filter.search = params.query.trim();`) with:

```typescript
  const searchTerms: string[] = [];
  if (params.query?.trim()) searchTerms.push(params.query.trim());
  if (params.community) searchTerms.push(`community:${normalizeCommunityPubkey(params.community)}`);
  if (searchTerms.length) filter.search = searchTerms.join(' ');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- relay/filters`
Expected: PASS (existing query-only tests still pass; new community tests pass).

- [ ] **Step 5: Wire the tool param**

In `src/tools/searchContent.ts`, add to `inputSchema` (after the `authors` entry, ~line 78):

```typescript
    community: z
      .string()
      .optional()
      .describe(
        'Return content shared into this community (Communikey). Accepts a hex pubkey or npub. ' +
          'Resolve a community name to its pubkey with resolve_author. Combine with query to ' +
          'scope a topic to a community (e.g. "math resources shared with X").',
      ),
```

Then, inside `runContentSearch`, where the `ContentSearchParams` object is constructed for `buildContentFilter`, add `community: <args>.community,` (use the same args/params variable the function already destructures for `query`/`authors`/`limit`).

- [ ] **Step 6: Build + full suite**

Run: `npm run build && npm test`
Expected: TypeScript compiles; all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/relay/filters.ts src/tools/searchContent.ts test/relay/filters.test.ts
git commit -m "feat(community): add community filter to search_content"
```

### Task 5: `community` param on `search_calendar_events` (Component 4)

Mirror of Task 4 for the calendar collection, plus the documented Bolt-routing limitation in the param description.

**Files:**
- Modify: `src/calendar/filters.ts` (`CalendarSearchParams` interface + `buildCalendarFilter`, ~lines 9-34 and 42-54)
- Modify: `src/tools/calendar.ts` (`inputSchema` ~lines 23-90; thread `community` into the calendar params)
- Test: `test/calendar/filters.test.ts`

**Interfaces:**
- Consumes: `normalizeCommunityPubkey` (Task 3).
- Produces: `CalendarSearchParams.community?: string`; `buildCalendarFilter` appends `community:<hex>` to `filter.search`.

- [ ] **Step 1: Write the failing test**

Add to `test/calendar/filters.test.ts`:

```typescript
import { nip19 } from 'nostr-tools';

describe('buildCalendarFilter community param', () => {
  const hex = '660d8c78651f70487ec9b8ddc283e29cf2561693dda3ba246d3fd3c08dbb7083';

  it('sets search to community:<hex> when only community is given', () => {
    const filter = buildCalendarFilter({ community: hex });
    expect(filter.search).toBe(`community:${hex}`);
  });

  it('space-joins query and community', () => {
    const filter = buildCalendarFilter({ query: 'mathematik', community: hex });
    expect(filter.search).toBe(`mathematik community:${hex}`);
  });

  it('normalizes an npub community to hex', () => {
    const npub = nip19.npubEncode(hex);
    const filter = buildCalendarFilter({ community: npub });
    expect(filter.search).toBe(`community:${hex}`);
  });

  it('throws on malformed community', () => {
    expect(() => buildCalendarFilter({ community: 'garbage' })).toThrow(/expected/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- calendar/filters`
Expected: FAIL — `community` not a valid key / search not assembled.

- [ ] **Step 3: Write minimal implementation**

In `src/calendar/filters.ts`, add to the `CalendarSearchParams` interface:

```typescript
  /** Community hex pubkey or npub; appends NIP-50 community:<hex> to the search. */
  community?: string;
```

Add the import at the top:

```typescript
import { normalizeCommunityPubkey } from '../utils/community.js';
```

Replace the search-assignment block in `buildCalendarFilter` (`if (params.query?.trim()) { filter.search = params.query.trim(); }`) with:

```typescript
  const searchTerms: string[] = [];
  if (params.query?.trim()) searchTerms.push(params.query.trim());
  if (params.community) searchTerms.push(`community:${normalizeCommunityPubkey(params.community)}`);
  if (searchTerms.length) filter.search = searchTerms.join(' ');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- calendar/filters`
Expected: PASS.

- [ ] **Step 5: Wire the tool param (with the documented limitation)**

In `src/tools/calendar.ts`, add to `inputSchema` (after the `authors` entry):

```typescript
    community: z
      .string()
      .optional()
      .describe(
        'Return calendar events shared into this community (Communikey). Accepts a hex pubkey ' +
          'or npub; resolve a community name with resolve_author. LIMITATION: this filter is ' +
          'silently ignored when combined with a time-range or geo query (startAfter/startBefore/' +
          'endAfter/endBefore/geohash), because those route to the relay time index which ignores ' +
          'full-text search. For "events shared with X next week", query by community alone, then ' +
          'filter the returned events by date client-side.',
      ),
```

Then thread `community: <args>.community,` into the `CalendarSearchParams` object passed to `buildCalendarFilter`.

- [ ] **Step 6: Build + full suite**

Run: `npm run build && npm test`
Expected: compiles; all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/calendar/filters.ts src/tools/calendar.ts test/calendar/filters.test.ts
git commit -m "feat(community): add community filter to search_calendar_events"
```

### Task 6: Update `resolve_author` description (Component 3)

Description-only: state that `resolve_author` also resolves community names and that the returned pubkey feeds the `community` param of the two search tools. No code logic, no test.

**Files:**
- Modify: `src/tools/resolveAuthor.ts` (tool `description`)

- [ ] **Step 1: Update the description**

In `src/tools/resolveAuthor.ts`, extend the tool's `description` string to add a sentence such as:

```
Also resolves community names: communities are Nostr profiles (kind-0), so a
community name returns its pubkey alongside people. Feed that pubkey to the
`community` param of search_content or search_calendar_events to get the content
shared into that community. A wrong pick simply yields empty results.
```

(Integrate it into the existing description prose; keep the existing author/publisher guidance intact.)

- [ ] **Step 2: Build to confirm no type errors**

Run: `npm run build`
Expected: compiles.

- [ ] **Step 3: Commit**

```bash
git add src/tools/resolveAuthor.ts
git commit -m "docs(community): note resolve_author also resolves communities"
```

---

## Self-Review

**Spec coverage:**
- Component 1 (relay indexes discovered community kind-0) → Tasks 1 (backfill union, Init+refresh) and 2 (live discovery on share write). ✓
- Component 2 (`community` on `search_content`) → Task 4. ✓
- Component 3 (reuse `resolve_author`, description only) → Task 6. ✓
- Component 4 (`community` on `search_calendar_events` + documented Bolt limitation) → Task 5 (limitation in the param description at Step 5). ✓
- Error handling (npub/hex normalize, reject malformed; unknown pubkey → empty result) → Task 3 helper (throws on malformed); empty-result behavior is the relay's existing exact-match semantics, no amb-mcp code needed. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. The only "locate the params object" instructions (Tasks 4/5 Step 5) reference a concrete existing function (`runContentSearch` / the calendar handler) where `query`/`authors` are already threaded — the exact sibling line to copy.

**Type consistency:** `normalizeCommunityPubkey(input: string): string` is defined in Task 3 and consumed identically in Tasks 4 and 5. `backfillProfileCandidates` (Task 1) and `enqueueShareCommunities` (Task 2) signatures match their call sites in `main.go`. `community?: string` added to both `ContentSearchParams` and `CalendarSearchParams`.

**Build order:** Tasks 1–2 (relay) deploy to dev first so `profiles_0` populates; Task 3 precedes its consumers (4, 5); Task 6 last. Matches the spec build sequence.
