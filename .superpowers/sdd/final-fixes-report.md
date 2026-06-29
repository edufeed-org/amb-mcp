# Final Hardening Fixes Report

## Covering-test command and output

```
npx vitest run test/transport/auth.test.ts test/transport/http.test.ts test/session.test.ts
```

Result:
```
 ✓ test/transport/auth.test.ts (5 tests) 194ms
 ✓ test/session.test.ts (7 tests) 34ms
 ✓ test/transport/http.test.ts (8 tests) 111ms

 Test Files  3 passed (3)
      Tests  20 passed (20)
   Duration  1.13s
```

## Build result

```
npm run build
```

Output: clean (no errors, no warnings).

## Full suite result

```
npx vitest run
```

Result:
```
 Test Files  27 passed (27)
      Tests  245 passed (245)
   Duration  1.54s
```

## Fixes applied

### Fix 1 — Pin RS256 algorithm in jwtVerify (src/transport/auth.ts)
Added `algorithms: ['RS256']` to the `jwtVerify` options object. Defends against algorithm-confusion and `none`-algorithm attacks if the AS JWKS ever exposes a symmetric or none-capable key.

### Fix 2 — Constant-time legacy bearer comparison (src/transport/http.ts)
Replaced `token === legacyBearerToken` with `timingSafeEqual` from `node:crypto`. Guards the unequal-length case (buffers of different length cause `timingSafeEqual` to throw) by treating length mismatch as a non-match without invoking it. Import added: `timingSafeEqual` from `node:crypto`.

### Fix 3 — Document 403 design choice (src/http.ts)
Added a 2-line comment above `scopesToProfile` noting that insufficient scope yields a session built without those tools (absent from tools/list; a call returns MCP method-not-found) rather than an HTTP 403 — a deliberate deviation from the spec's stated 403-on-tools/call behavior.

### Fix 4 — Broaden extract-profile exclusion assertions (test/session.test.ts)
Expanded the `extract profile adds extract_metadata but still no write tools` test to also assert that `sign_event`, `add_relay`, and `skos_create_vocabulary` are absent, matching the thoroughness of the read-only profile test. Uses the same `_registeredTools` registry-introspection mechanism.
