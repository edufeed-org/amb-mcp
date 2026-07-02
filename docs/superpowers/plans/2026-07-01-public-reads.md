# amb-mcp Public Reads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve amb-mcp's read tools to anonymous callers (`mcp:read`), while keeping `extract_metadata` gated behind a valid `mcp:extract` token.

**Architecture:** A single localized change to the `authMiddleware` in `src/transport/http.ts`: a request with no `Authorization` token is seeded with scopes `['mcp:read']` and allowed through (instead of 401); a request carrying a token is still fully validated (bad token → 401). The session's tool profile is already derived from scopes at init (`scopesToProfile` in `src/http.ts`), so `extract_metadata` is naturally absent from anonymous sessions with no additional gate.

**Tech Stack:** TypeScript, Express, `@modelcontextprotocol/sdk` StreamableHTTPServerTransport, `jose` (RS256 JWT), Vitest.

## Global Constraints

- Write/signing tools are NEVER exposed over HTTP — `scopesToProfile` hard-sets `write: false`; do not change this.
- `extract_metadata` MUST require a valid token carrying the `mcp:extract` scope. Anonymous sessions MUST NOT be able to call it.
- A *supplied* token MUST still be fully validated (issuer/audience/RS256/JWKS). Only the *absence* of a token is newly permitted. A non-empty token that fails validation MUST return HTTP 401.
- The PRM document at `/.well-known/oauth-protected-resource` and the `WWW-Authenticate` challenge on the 401 path MUST remain unchanged.
- No realm, homelab, or claude.ai configuration change is in scope. `LEGACY_BEARER_TOKEN` behavior (grants read+extract) is preserved unchanged (its removal is a separate plan).
- Test framework is Vitest; run with `npm test` (`vitest run`). Test files live under `test/`, mirroring `src/` paths.

---

### Task 1: Anonymous public reads in the HTTP auth middleware

**Files:**
- Modify: `src/transport/http.ts` (the `authMiddleware`, ~lines 114-140, and the file header comment ~lines 9-11)
- Modify: `test/transport/http.test.ts`
- Modify: `README.md` (the "Public deployment" section, ~lines 132-140)

**Interfaces:**
- Consumes: `startHttpServer(opts: HttpServerOptions)` — `opts.auth.verify(token) → Promise<AuthContext>`, `opts.legacyBearerToken?`, `opts.buildMcpServer({ scopes }) → { server, dispose? }`. `AuthContext = { sub: string; scopes: string[] }`. `AuthError` (imported) has `.status: 401 | 403`.
- Produces: no signature change. Behavioral change only: `res.locals.scopes` is set to `['mcp:read']` for tokenless requests; `buildMcpServer` therefore receives `['mcp:read']` for anonymous sessions.

- [ ] **Step 1: Rewrite the "no token" test and add scope-capture to the shared harness**

In `test/transport/http.test.ts`, add a mutable scope capture to the `beforeAll` server so tests can assert what scopes a session was built with. Replace the `buildMcpServer` line inside the `beforeAll` `startHttpServer({...})` call:

```ts
    buildMcpServer: ({ scopes }) => {
      lastScopes = scopes;
      return { server: new McpServer({ name: 'test', version: '0' }) };
    },
```

Add these module-level declarations near the other `let` bindings (after `let sign: ...`):

```ts
let lastScopes: string[] | undefined;

// Minimal MCP initialize request body (a session is only built for initialize).
const initBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0' },
  },
});
```

Now DELETE the existing test that asserts a 401 for the tokenless case:

```ts
  it('rejects /mcp without a token (401 + WWW-Authenticate pointing at PRM)', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('oauth-protected-resource');
  });
```

and replace it with a test asserting the anonymous read session:

```ts
  it('serves an anonymous read session (no token) with scopes [mcp:read]', async () => {
    lastScopes = undefined;
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Mcp-Protocol-Version': '2025-03-26' },
      body: initBody,
    });
    expect(res.status).not.toBe(401);
    expect(res.headers.get('www-authenticate')).toBeNull();
    expect(lastScopes).toEqual(['mcp:read']);
  });
```

> Note: this test change is mandated by the spec — the old 401-without-token behavior is exactly what we are removing.

- [ ] **Step 2: Run the new test to verify it fails**

Run: `npm test -- test/transport/http.test.ts`
Expected: FAIL — the tokenless request currently returns 401, so `expect(res.status).not.toBe(401)` fails (and `lastScopes` stays `undefined`).

- [ ] **Step 3: Implement anonymous read in `authMiddleware`**

In `src/transport/http.ts`, replace the entire `authMiddleware` body (currently starting `if (!opts.auth && !legacyBearerToken) return next();` through the closing brace of the function) with:

```ts
  const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    const token = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '').trim() : '';

    // No credential supplied → anonymous public read.
    if (!token) {
      res.locals.scopes = ['mcp:read'];
      return next();
    }

    // Transitional static bearer → full read+extract.
    if (legacyBearerToken) {
      const a = Buffer.from(token);
      const b = Buffer.from(legacyBearerToken);
      if (a.length === b.length && timingSafeEqual(a, b)) {
        res.locals.scopes = ['mcp:read', 'mcp:extract'];
        return next();
      }
    }

    // A token was supplied but is not the legacy one → it must be a valid JWT.
    if (!opts.auth) {
      res.setHeader('WWW-Authenticate', challenge);
      return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
    }
    try {
      const ctx = await opts.auth.verify(token);
      res.locals.scopes = ctx.scopes;
      next();
    } catch (err) {
      const status = err instanceof AuthError ? err.status : 401;
      res.setHeader('WWW-Authenticate', challenge);
      res.status(status).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
    }
  };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/transport/http.test.ts`
Expected: PASS for the new anonymous-read test. The existing "garbage token → 401", "valid signed token → 200", PRM, healthz, and `scopesToProfile` tests still pass.

- [ ] **Step 5: Add regression tests for extract gating and the legacy path**

Append these tests inside the `describe('HTTP transport OAuth', ...)` block in `test/transport/http.test.ts`:

```ts
  it('grants mcp:extract to a session initialized with an extract-scoped token', async () => {
    lastScopes = undefined;
    const token = await sign('mcp:read mcp:extract');
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Mcp-Protocol-Version': '2025-03-26',
      },
      body: initBody,
    });
    expect(res.status).not.toBe(401);
    expect(lastScopes).toEqual(['mcp:read', 'mcp:extract']);
  });
```

Then add a separate `describe` (after the existing `describe('HTTP transport OAuth', ...)` block closes) that stands up its own server with a legacy bearer, to guard the transitional path:

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
    capturedScopes = undefined;
    const res = await fetch(`${legacyBase}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer legacy-secret',
        'Mcp-Protocol-Version': '2025-03-26',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    });
    expect(res.status).not.toBe(401);
    expect(capturedScopes).toEqual(['mcp:read', 'mcp:extract']);
  });

  it('anonymous request on a legacy-only server still gets a read session', async () => {
    capturedScopes = undefined;
    const res = await fetch(`${legacyBase}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Mcp-Protocol-Version': '2025-03-26' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    });
    expect(res.status).not.toBe(401);
    expect(capturedScopes).toEqual(['mcp:read']);
  });
});
```

- [ ] **Step 6: Run the full transport test file**

Run: `npm test -- test/transport/http.test.ts`
Expected: PASS — all tests green (anonymous read, garbage-token 401, valid signed token, extract-scoped session, legacy read+extract, legacy-server anonymous read, PRM, healthz, scopesToProfile).

- [ ] **Step 7: Update the code + README documentation**

In `src/transport/http.ts`, replace the "Authentication:" paragraph of the file header comment (~lines 9-11):

```ts
 * Authentication: read tools are served anonymously (a tokenless /mcp request
 * gets an mcp:read session). A supplied token is fully validated (bad token →
 * 401); a valid token additionally grants its scopes (e.g. mcp:extract). The
 * PRM document is served unauthenticated at
 * /.well-known/oauth-protected-resource (RFC 9728).
```

In `README.md`, replace the "Public deployment" paragraph (~lines 132-140) so it reflects public reads. Replace the sentence beginning "It speaks the same streamable-HTTP protocol..." with:

```markdown
It speaks the same streamable-HTTP protocol as the local server. **Read tools are public** — a request with no `Authorization` header gets a read-only session (search/get/browse/resolve). The budget-spending `extract_metadata` tool requires a valid OAuth token carrying the `mcp:extract` scope; tokens are issued by the Keycloak realm out-of-band — ask the operator. The handshake is otherwise identical to the curl example above; just substitute the URL and drop the `Authorization` header for read-only use.
```

- [ ] **Step 8: Run the full suite and typecheck**

Run: `npm test`
Expected: PASS — entire suite green.

Run: `npm run build`
Expected: `tsc` completes with no type errors.

- [ ] **Step 9: Commit**

```bash
git add src/transport/http.ts test/transport/http.test.ts README.md
git commit -m "feat(http): serve read tools anonymously, gate extract behind a token"
```
