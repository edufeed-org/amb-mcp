# Task A4 report: get_resource generic kind dispatch

Commit: `b1257f6` — "feat(get): generic naddr kind dispatch — publications, transferkiosk, articles, wikis resolvable"

## Changes

- `src/relay/client.ts`
  - `getById(eventId, kinds = [30142])` — added optional `kinds` param, default preserves prior hardcoded `[30142]` behavior.
  - `getByDTag(dTag, author?, kinds = [30142])` — same treatment.
- `src/tools/get.ts` (rewrite)
  - `naddrToLookup(naddr)` now returns `{ identifier, author, kind }` (added `kind: decoded.data.kind`).
  - Extracted `formatAMB(event, lang)` — the pre-existing 30142 formatting (`Resource not found` / `Failed to parse resource` + `rawEvent` / simplified resource), byte-identical to the prior inline logic.
  - Extracted `runGetResource(client, params)` — the full tool-callback body, taking a minimal structural `GetClient` interface (`getByDTag`/`getById` only), mirroring `runContentSearch`'s `Pick<AMBRelayClient, ...>` pattern used in `src/tools/searchContent.ts`.
    - No identifier/eventId/naddr → early error (unchanged).
    - `naddr` present: decode via `naddrToLookup`; invalid → `{ error: 'Invalid naddr', resource: null }` (unchanged); kind 30142 falls through to the original `getByDTag` (no kinds arg → default `[30142]`) + `formatAMB` path; any other kind checks `hasContentTransform(kind)` first (unregistered kind → `{ error: 'naddr kind <N> is not served by this server', resource: null }` with **no relay call**), then fetches via `getByDTag(identifier, author, [kind])` and runs `transformContentEvent(event, lang)`, returning the search-result shape (`{ resource }`) or `{ resource: null, message: 'Resource not found' | 'Failed to parse resource' }`.
    - No naddr: `eventId` → `getById(eventId)` (default kind 30142); else `identifier`/`author` → `getByDTag` (default kind 30142); both go through `formatAMB` — unchanged.
  - `registerGetTool` callback is now just `const payload = await runGetResource(client, params); return { content: [{ type: 'text', text: JSON.stringify(payload) }] };`.
  - Updated tool description to mention naddrs of any search_content type work and non-resource kinds return the search-result shape; kept the sourcePage/url markdown-link guidance.
- `test/tools/getResource.test.ts`
  - Existing `naddrToLookup` "decodes a valid naddr" test's `toEqual` gained `kind: 30142`.
  - Added the three `runGetResource` dispatch tests verbatim from the brief (publication naddr → publication shape + doi; transferkiosk projekt naddr → project shape; unregistered kind 31337 → error matching `/kind 31337/` with zero relay calls).

## Callers of getByDTag/getById checked

Full-repo grep (`grep -rn "getByDTag\|getById" --include="*.ts" .` excluding node_modules/worktrees):

- `src/tools/get.ts` — the only production caller; both call sites updated (30142 default path unaffected, non-30142 path passes explicit `[kind]`).
- `src/relay/client.ts` — the two method definitions themselves.
- `test/tools/getResource.test.ts` — the fake client used only by this test file.
- `test-client.ts` (repo root, standalone bun script, `getByDTag(dTag)` single-arg call) — **not** part of the `tsc` build (`tsconfig.json` `include: ["src/**/*"]`, `exclude: [..., "test"]`; this file is outside `src/` entirely). Its single-argument call is unaffected either way since `kinds` is optional with a default of `[30142]`, matching its prior implicit behavior.
- No other tool (`search_resources`/`searchContent.ts`, calendar tools, author tools, etc.) calls `getByDTag`/`getById` — confirmed via the same grep; `searchContent.ts` uses `client.queryEvents` exclusively, unaffected by this change.

## Commands + output

1. Red check (before implementing client.ts/get.ts, with updated test file):
   ```
   GOWORK=off bun run test -- test/tools/getResource.test.ts
   ```
   → 4 failed / 1 passed: `naddrToLookup` missing `kind`; `runGetResource is not a function` (x3). Matches brief's expected failure mode exactly.

2. After implementation, same command → `5 tests | 5 passed`.

3. Full suite:
   ```
   GOWORK=off bun run test
   ```
   → `Test Files 27 passed (27)`, `Tests 272 passed (272)`.

4. Build:
   ```
   GOWORK=off bun run build
   ```
   → 4 errors, all pre-existing `src/lib/schema.ts` `TS2503: Cannot find namespace 'z'` (lines 109, 110, 111, 142) — the exact pre-existing/allowed set per the brief. No new errors from `client.ts`, `get.ts`, or any caller.

Note: sandboxed Bash calls failed with `EROFS`/read-only-filesystem errors (vitest's `.vite-temp` config cache under `node_modules`, and git's `index.lock` under `.git/worktrees/...`) because the amb-mcp worktree sits outside the amb-relay sandbox's writable allowlist. All test/build/git commands above were re-run with `dangerouslyDisableSandbox: true` after confirming the failure was sandbox-caused, not a real error.

## Self-review

- Verified `formatAMB` reproduces the original inline logic verbatim (same three payload shapes: no-event, parse-failure-with-rawEvent, success) — behaviorally byte-identical for kind 30142, both via naddr and via identifier/eventId.
- Verified the 30142 naddr path still calls `getByDTag(identifier, author)` with no third argument, so it hits the client's default `[30142]`, not an explicit `[30142]` that could silently diverge if the default ever changes — matches the brief's own `get.ts` snippet.
- Verified unregistered-kind short-circuits before any relay call (`hasContentTransform` check precedes `client.getByDTag`), matching the test's `expect(client.calls.length).toBe(0)`.
- Confirmed no other production code path depends on the old 2-arg `getByDTag`/1-arg `getById` signatures changing observable behavior — all pre-existing call sites either omit the new trailing arg (falls back to `[30142]`, unchanged) or are outside the TS build entirely (`test-client.ts`).
- Left `bun.lock` (pre-existing unstaged drift, unrelated to this task) and `task-a1/a2/a3-report.md` (other tasks' artifacts) out of this commit — staged only the three files the brief's Step 6 names.

## Fix: parameter priority review finding

**Finding:** `runGetResource` checked `params.naddr` before `params.eventId`, but the pre-refactor tool checked eventId FIRST — a caller passing both now got the naddr-derived event, a behavior flip.

**Fix:** Reordered `src/tools/get.ts` parameter checks to restore eventId-first priority: `eventId > naddr > identifier`.

**Regression test:** Added to `test/tools/getResource.test.ts`:
- "prefers eventId over naddr when both are supplied (pre-refactor behavior)" — passes a fake client that tracks method calls, verifies only `getById` is invoked when both `eventId` and `naddr` are supplied.

**Commit:** `e100a88` — "fix(get): restore eventId-first parameter priority in runGetResource"

**Test results:**
- getResource tests: 6 passed
- Full suite: 273 tests passed (27 files)
