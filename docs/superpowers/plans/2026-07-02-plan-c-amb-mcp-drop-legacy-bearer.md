# Plan C — amb-mcp: Drop the Legacy Static Bearer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the transitional `LEGACY_BEARER_TOKEN` code path from amb-mcp so the HTTP transport authenticates solely via anonymous public reads + validated Keycloak JWTs.

**Architecture:** amb-mcp's HTTP `authMiddleware` currently has three branches: no token → `mcp:read`; token equals the static legacy secret → `mcp:read`+`mcp:extract`; otherwise → validate as JWT. This plan deletes the middle branch and every wire that fed it (`http.ts` env const + option, `transport/http.ts` option/field/compare, the `timingSafeEqual` import, tests, `.env.example`). After this change, the only way to obtain `mcp:extract` over HTTP is a valid JWT with that scope.

**Tech Stack:** TypeScript, Node.js, Express, `@modelcontextprotocol/sdk`, Vitest.

## Global Constraints

- **Sequencing — THIS PLAN RUNS LAST.** Execute only after edufeed-app and edufeed-chat-bot are migrated to client-credentials AND verified live, and after the homelab config plan has removed `LEGACY_BEARER_TOKEN` from deployed env. Removing the branch while any consumer still sends the static token breaks that consumer with a 401. See `docs/superpowers/specs/2026-07-02-client-credentials-migration-design.md`.
- **Repo:** amb-mcp, branch `main` (or a feature branch off it — confirm with the user before starting).
- Write/signing tools stay never-exposed over HTTP (`write: false` is unchanged and out of scope here).
- `extract_metadata` MUST still require a valid `mcp:extract` token — this plan tightens that (removes the static bypass), never loosens it.
- A supplied-but-invalid token MUST still yield 401; anonymous (no token) MUST still yield an `mcp:read` session. Both behaviors are preserved.
- PRM + `WWW-Authenticate` challenge behavior is unchanged.
- Never log or echo secrets.
- Commit only the files each task names, and only with explicit user OK.

---

### Task 1: Remove the legacy branch from the HTTP transport

**Files:**
- Modify: `src/transport/http.ts` (import line 16; option `legacyBearerToken?` line 41; local binding line 77; compare branch lines 126-134; file-header comment lines 9-13)
- Test: `test/transport/http.test.ts` (delete the `describe('HTTP transport legacy bearer', ...)` block, lines 145-196)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `HttpServerOptions` no longer has a `legacyBearerToken` field. Task 2 (`src/http.ts`) must stop passing it.

- [ ] **Step 1: Delete the legacy tests first (they pin the behavior we're removing)**

In `test/transport/http.test.ts`, delete the entire block from line 145 through line 196:

```ts
describe('HTTP transport legacy bearer', () => {
  let legacyHandle: HttpServerHandle;
  let legacyBase: string;
  let capturedScopes: string[] | undefined;

  beforeAll(async () => {
    legacyHandle = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      legacyBearerToken: 'legacy-secret',
      buildMcpServer: ({ scopes }) => {
        capturedScopes = scopes;
        return { server: new McpServer({ name: 'test', version: '0' }) };
      },
    });
    legacyBase = `http://127.0.0.1:${legacyHandle.port}`;
  });

  afterAll(async () => { await legacyHandle.close(); });

  it('legacy bearer grants read+extract', async () => {
    // ...
  });

  it('anonymous request on a legacy-only server still gets a read session', async () => {
    // ...
  });
});
```

Note: the "anonymous → read session" behavior is still covered by the existing anonymous/JWT test suites elsewhere in this file (the anonymous branch of `authMiddleware` is untouched). If, after deleting this block, no remaining test asserts that a tokenless POST yields `['mcp:read']`, add one small `it` to the nearest surviving `describe` that starts a server *without* `auth` still isn't representative — prefer asserting it against the JWT-configured server used by the rest of the file. Only add it if the grep in Step 2 shows the assertion is otherwise absent.

- [ ] **Step 2: Confirm anonymous coverage survives**

Run: `grep -n "mcp:read" test/transport/http.test.ts`
Expected: at least one remaining assertion that a tokenless request yields `['mcp:read']` (in a non-legacy `describe`). If none exists, add a minimal test asserting anonymous POST to the JWT-configured server captures `['mcp:read']` before proceeding.

- [ ] **Step 3: Run the suite to confirm it fails to compile / references removed symbols**

Run: `npm test -- test/transport/http.test.ts`
Expected: the file compiles and remaining tests PASS (we removed the tests referencing `legacyBearerToken`; nothing else should reference it yet). If TypeScript still sees `legacyBearerToken` as valid, that's fine at this step — it's removed in the next steps.

- [ ] **Step 4: Remove the compare branch in `authMiddleware`**

In `src/transport/http.ts`, delete lines 126-134 (the transitional static-bearer block):

```ts
    // Transitional static bearer → full read+extract.
    if (legacyBearerToken) {
      const a = Buffer.from(token);
      const b = Buffer.from(legacyBearerToken);
      if (a.length === b.length && timingSafeEqual(a, b)) {
        res.locals.scopes = ['mcp:read', 'mcp:extract'];
        return next();
      }
    }

```

After deletion, the middleware flows directly from the "no token → anonymous" branch to the "token supplied → must be a valid JWT" branch.

- [ ] **Step 5: Remove the local binding**

In `src/transport/http.ts`, delete line 77:

```ts
  const legacyBearerToken = opts.legacyBearerToken;
```

- [ ] **Step 6: Remove the option from `HttpServerOptions`**

In `src/transport/http.ts`, delete the `legacyBearerToken?` option (lines 40-41):

```ts
  /** Transitional: also accept this static bearer during migration. Remove post-rollout. */
  legacyBearerToken?: string;
```

- [ ] **Step 7: Drop the now-unused `timingSafeEqual` import**

In `src/transport/http.ts` line 16, change:

```ts
import { randomUUID, timingSafeEqual } from 'node:crypto';
```

to:

```ts
import { randomUUID } from 'node:crypto';
```

(`randomUUID` is still used for session ids; `timingSafeEqual` was only used by the deleted branch. Confirm with `grep -n timingSafeEqual src/transport/http.ts` → no matches.)

- [ ] **Step 8: Update the file-header comment**

In `src/transport/http.ts`, the header comment (lines 9-13) already describes the correct end-state ("read tools are served anonymously… A supplied token is fully validated (bad token → 401); a valid token additionally grants its scopes"). It makes no mention of the legacy bearer, so **no change is needed** — verify by reading lines 9-13 and confirming there is no "legacy"/"transitional" wording. If any such wording exists, remove it.

- [ ] **Step 9: Run the transport tests**

Run: `npm test -- test/transport/http.test.ts`
Expected: PASS. No reference to `legacyBearerToken` remains.

- [ ] **Step 10: Type-check the whole project**

Run: `npm run build` (or `npx tsc --noEmit` if the project exposes it)
Expected: FAIL — `src/http.ts` still passes `legacyBearerToken:` to `startHttpServer`, which no longer accepts it. This failure is expected and fixed in Task 2. (If the build passes, `src/http.ts` was already clean — proceed anyway.)

- [ ] **Step 11: Commit**

```bash
git add src/transport/http.ts test/transport/http.test.ts
git commit -m "refactor(http): remove transitional legacy bearer branch from transport"
```

---

### Task 2: Remove the legacy env wiring from the HTTP entry point

**Files:**
- Modify: `src/http.ts` (const line 48; startup log line 57; option pass line 100)
- Modify: `.env.example` (lines 66-67)

**Interfaces:**
- Consumes: `HttpServerOptions` no longer has `legacyBearerToken` (Task 1).
- Produces: nothing downstream in this plan.

- [ ] **Step 1: Remove the env const**

In `src/http.ts`, delete line 48:

```ts
const LEGACY_BEARER_TOKEN = process.env.LEGACY_BEARER_TOKEN || undefined; // transitional
```

- [ ] **Step 2: Simplify the startup auth log**

In `src/http.ts` line 57, change:

```ts
  console.log(`Auth: OAuth (issuer ${OAUTH_ISSUER})${LEGACY_BEARER_TOKEN ? ' + legacy bearer' : ''}`);
```

to:

```ts
  console.log(`Auth: OAuth (issuer ${OAUTH_ISSUER})`);
```

- [ ] **Step 3: Stop passing the option to `startHttpServer`**

In `src/http.ts`, delete line 100:

```ts
    legacyBearerToken: LEGACY_BEARER_TOKEN,
```

- [ ] **Step 4: Remove the env doc from `.env.example`**

In `.env.example`, delete lines 66-67:

```
# Transitional only: also accept this static bearer during rollout, then remove.
# LEGACY_BEARER_TOKEN=
```

- [ ] **Step 5: Build the project**

Run: `npm run build`
Expected: PASS — no remaining reference to `LEGACY_BEARER_TOKEN` or `legacyBearerToken`.

- [ ] **Step 6: Full grep sweep for stragglers**

Run: `grep -rn -i "legacy_bearer\|legacybearer" src/ test/ .env.example`
Expected: no matches.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: PASS (all suites).

- [ ] **Step 8: Commit**

```bash
git add src/http.ts .env.example
git commit -m "refactor(http): drop LEGACY_BEARER_TOKEN env wiring after consumer migration"
```

---

## Self-Review

- **Spec coverage:** The spec's "amb-mcp: remove legacy path (LAST)" section maps to Task 1 (transport branch + import + tests) and Task 2 (entry-point env + `.env.example`). The Global Constraints section pins the sequencing (run last) and the invariants (anonymous read preserved, extract still needs a valid JWT, invalid token still 401).
- **Placeholder scan:** All steps contain exact file paths, line numbers, and the literal code to delete. The one conditional (Task 1 Step 1/2, "add an anonymous test only if grep shows it's missing") is gated on a concrete grep result, not left vague.
- **Type consistency:** `legacyBearerToken` (option/field) and `LEGACY_BEARER_TOKEN` (env const) are the only two identifiers removed; Task 1 removes the type surface, Task 2 removes the caller, and the build in Task 2 Step 5 is the consistency gate.
