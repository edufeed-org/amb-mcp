# amb-mcp OAuth Resource Server Implementation Plan (Plan A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn amb-mcp's HTTP transport into an OAuth 2.1 resource server that validates Keycloak-issued JWTs, advertises RFC 9728 Protected Resource Metadata, exposes only read+extract tools, and gates tool registration by scope.

**Architecture:** A new `src/transport/auth.ts` verifies JWTs against Keycloak's JWKS (via `jose`). `registerTools` is split into read / extract / write groups so the HTTP build can omit write/signing tools and gate the extract tool by scope. The Express layer (`src/transport/http.ts`) serves a PRM document, authenticates every `/mcp` request, and at session-init builds a scope-tailored MCP server. A transitional `LEGACY_BEARER_TOKEN` env lets the old static token keep working during rollout, then is removed.

**Tech Stack:** TypeScript (ESM, `node ^20`), Express 4, `@modelcontextprotocol/sdk` ^1.26, `jose` (new), Vitest 3.

## Global Constraints

- Runtime: Node `^20`, ESM (`"type": "module"`); import local modules with `.js` extensions (e.g. `./auth.js`).
- Package manager: `npm@10.8.2`. Test runner: `vitest run` (`npm test`).
- Build check: `npm run build` (`tsc`) must pass — strict typing.
- Issuer (Keycloak realm): `https://auth.edufeed.org/realms/edufeed`. Audience: `amb-mcp`.
- Scopes: `mcp:read` (all read tools), `mcp:extract` (`extract_metadata`). `mcp:extract` does NOT imply `mcp:read`.
- HTTP build MUST NOT register write/signing tools: `sign_event`, `publish_event`, `create_and_publish_metadata`, `create_and_publish_resource`, `signer_*`, `add_relay`, `remove_relay`, SKOS-builder mutators.
- stdio/ContextVM entry points (`src/index.ts`, `src/stdio.ts`) keep the full toolset and MUST be unaffected.

## File Structure

- `src/transport/auth.ts` (new) — JWT verifier factory + `AuthContext` type. One responsibility: token → `{ sub, scopes }`.
- `src/transport/prm.ts` (new) — builds the RFC 9728 PRM document. Pure function, no I/O.
- `src/tools/index.ts` (modify) — split `registerTools` into `registerReadTools` / `registerExtractTools` / `registerWriteTools`; `registerTools` composes them via options (default: all).
- `src/session.ts` (modify) — `buildSessionServer` accepts `{ read, extract, write }` flags; defaults preserve current behavior.
- `src/transport/http.ts` (modify) — PRM route, JWT auth middleware, scope-aware `buildMcpServer(ctx)` factory signature, optional legacy bearer, expose resolved `port` on the handle.
- `src/http.ts` (modify) — read OAuth env, build scope-tailored sessions with `exposeWriteTools: false`, drop `HTTP_BEARER_TOKEN` (replaced by `LEGACY_BEARER_TOKEN` transitional).
- Tests: `test/transport/auth.test.ts`, `test/transport/prm.test.ts`, `test/transport/http.test.ts`, additions to `test/session.test.ts`.

---

### Task 1: JWT verifier (`src/transport/auth.ts`)

**Files:**
- Create: `src/transport/auth.ts`
- Test: `test/transport/auth.test.ts`
- Modify: `package.json` (add `jose`)

**Interfaces:**
- Produces:
  - `interface AuthContext { sub: string; scopes: string[]; }`
  - `interface AuthConfig { issuer: string; audience: string; jwksUri: string; getKey?: import('jose').JWTVerifyGetKey; }`
  - `class AuthError extends Error { status: 401 | 403; }`
  - `function createJwtVerifier(cfg: AuthConfig): (token: string) => Promise<AuthContext>`
  - `function hasScope(ctx: AuthContext, scope: string): boolean`

- [ ] **Step 1: Install jose**

Run: `npm install jose`
Expected: `jose` appears under `dependencies` in `package.json`, install succeeds.

- [ ] **Step 2: Write the failing test**

Create `test/transport/auth.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { createJwtVerifier, hasScope, AuthError } from '../../src/transport/auth.js';

const ISSUER = 'https://auth.edufeed.org/realms/edufeed';
const AUDIENCE = 'amb-mcp';

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  jwk.alg = 'RS256';
  const getKey = createLocalJWKSet({ keys: [jwk] });
  const verify = createJwtVerifier({ issuer: ISSUER, audience: AUDIENCE, jwksUri: 'unused', getKey });
  const sign = (claims: Record<string, unknown>, opts: { aud?: string; iss?: string; expSec?: number } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(opts.iss ?? ISSUER)
      .setAudience(opts.aud ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${opts.expSec ?? 3600}s`)
      .setSubject('user-123')
      .sign(privateKey);
  return { verify, sign };
}

describe('createJwtVerifier', () => {
  it('accepts a valid token and parses sub + scopes', async () => {
    const { verify, sign } = await setup();
    const ctx = await verify(await sign({ scope: 'mcp:read mcp:extract' }));
    expect(ctx.sub).toBe('user-123');
    expect(ctx.scopes).toEqual(['mcp:read', 'mcp:extract']);
    expect(hasScope(ctx, 'mcp:read')).toBe(true);
    expect(hasScope(ctx, 'mcp:write')).toBe(false);
  });

  it('rejects a token with the wrong audience (401)', async () => {
    const { verify, sign } = await setup();
    await expect(verify(await sign({ scope: 'mcp:read' }, { aud: 'other' })))
      .rejects.toMatchObject({ status: 401 });
  });

  it('rejects a token with the wrong issuer (401)', async () => {
    const { verify, sign } = await setup();
    await expect(verify(await sign({ scope: 'mcp:read' }, { iss: 'https://evil.example' })))
      .rejects.toMatchObject({ status: 401 });
  });

  it('rejects an expired token (401)', async () => {
    const { verify, sign } = await setup();
    await expect(verify(await sign({ scope: 'mcp:read' }, { expSec: -10 })))
      .rejects.toBeInstanceOf(AuthError);
  });

  it('treats a missing scope claim as no scopes', async () => {
    const { verify, sign } = await setup();
    const ctx = await verify(await sign({}));
    expect(ctx.scopes).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- test/transport/auth.test.ts`
Expected: FAIL — cannot find module `../../src/transport/auth.js`.

- [ ] **Step 4: Write minimal implementation**

Create `src/transport/auth.ts`:

```ts
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface AuthContext {
  sub: string;
  scopes: string[];
}

export interface AuthConfig {
  issuer: string;
  audience: string;
  jwksUri: string;
  /** Override key resolver — tests inject a local JWKS. */
  getKey?: JWTVerifyGetKey;
}

export class AuthError extends Error {
  status: 401 | 403;
  constructor(status: 401 | 403, message: string) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

export function createJwtVerifier(cfg: AuthConfig): (token: string) => Promise<AuthContext> {
  const getKey = cfg.getKey ?? createRemoteJWKSet(new URL(cfg.jwksUri));
  return async function verify(token: string): Promise<AuthContext> {
    try {
      const { payload } = await jwtVerify(token, getKey, {
        issuer: cfg.issuer,
        audience: cfg.audience,
      });
      const scope = typeof payload.scope === 'string' ? payload.scope : '';
      return {
        sub: typeof payload.sub === 'string' ? payload.sub : '',
        scopes: scope.split(' ').filter(Boolean),
      };
    } catch (err) {
      throw new AuthError(401, err instanceof Error ? err.message : 'invalid token');
    }
  };
}

export function hasScope(ctx: AuthContext, scope: string): boolean {
  return ctx.scopes.includes(scope);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- test/transport/auth.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Build check**

Run: `npm run build`
Expected: no type errors.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/transport/auth.ts test/transport/auth.test.ts
git commit -m "feat(auth): add Keycloak JWT verifier for HTTP transport"
```

---

### Task 2: PRM document builder (`src/transport/prm.ts`)

**Files:**
- Create: `src/transport/prm.ts`
- Test: `test/transport/prm.test.ts`

**Interfaces:**
- Produces:
  - `interface PrmConfig { resource: string; issuer: string; scopes: string[]; }`
  - `function buildProtectedResourceMetadata(cfg: PrmConfig): Record<string, unknown>`

- [ ] **Step 1: Write the failing test**

Create `test/transport/prm.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildProtectedResourceMetadata } from '../../src/transport/prm.js';

describe('buildProtectedResourceMetadata', () => {
  it('produces an RFC 9728 document', () => {
    const doc = buildProtectedResourceMetadata({
      resource: 'https://mcp.amb.edufeed.org/mcp',
      issuer: 'https://auth.edufeed.org/realms/edufeed',
      scopes: ['mcp:read', 'mcp:extract'],
    });
    expect(doc).toEqual({
      resource: 'https://mcp.amb.edufeed.org/mcp',
      authorization_servers: ['https://auth.edufeed.org/realms/edufeed'],
      scopes_supported: ['mcp:read', 'mcp:extract'],
      bearer_methods_supported: ['header'],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/transport/prm.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/transport/prm.ts`:

```ts
export interface PrmConfig {
  resource: string;
  issuer: string;
  scopes: string[];
}

export function buildProtectedResourceMetadata(cfg: PrmConfig): Record<string, unknown> {
  return {
    resource: cfg.resource,
    authorization_servers: [cfg.issuer],
    scopes_supported: cfg.scopes,
    bearer_methods_supported: ['header'],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/transport/prm.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/transport/prm.ts test/transport/prm.test.ts
git commit -m "feat(auth): add RFC 9728 protected-resource-metadata builder"
```

---

### Task 3: Tool-profile split (`src/tools/index.ts`, `src/session.ts`)

**Files:**
- Modify: `src/tools/index.ts:30-69`
- Modify: `src/session.ts:18-46`
- Test: `test/session.test.ts` (add cases)

**Interfaces:**
- Consumes: existing `register*` functions from Task-unrelated tool modules (unchanged signatures).
- Produces:
  - `interface ToolProfile { read?: boolean; extract?: boolean; write?: boolean; }`
  - `registerTools(server, client, calendarClient?, profile?: ToolProfile)` — default `{ read: true, extract: true, write: true }`.
  - `buildSessionServer(ambRelays, calendarRelays, profile?: ToolProfile)` — passes the profile through; default unchanged (full).

- [ ] **Step 1: Write the failing test**

Add to `test/session.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildSessionServer } from '../src/session.js';

async function listToolNames(profile?: { read?: boolean; extract?: boolean; write?: boolean }) {
  const s = buildSessionServer(['wss://relay.edufeed.org'], ['wss://dev.calendar-relay.edufeed.org'], profile);
  // McpServer exposes registered tools via its internal registry.
  const names = Object.keys((s.server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
  s.dispose();
  return names;
}

describe('buildSessionServer tool profile', () => {
  it('read-only profile excludes write and extract tools', async () => {
    const names = await listToolNames({ read: true, extract: false, write: false });
    expect(names).toContain('search_content');
    expect(names).toContain('get_resource');
    expect(names).not.toContain('extract_metadata');
    expect(names).not.toContain('publish_event');
    expect(names).not.toContain('sign_event');
    expect(names).not.toContain('add_relay');
  });

  it('extract profile adds extract_metadata but still no write tools', async () => {
    const names = await listToolNames({ read: true, extract: true, write: false });
    expect(names).toContain('extract_metadata');
    expect(names).not.toContain('publish_event');
  });

  it('default profile keeps the full toolset (write tools present)', async () => {
    const names = await listToolNames();
    expect(names).toContain('publish_event');
    expect(names).toContain('sign_event');
    expect(names).toContain('add_relay');
  });
});
```

> Note: confirm the registry property name first. Run `node -e "import('./dist/session.js')"` is unnecessary; instead, before writing the impl, verify with: `npm run build && node -e "const {buildSessionServer}=require('./dist/session.js')"` is NOT valid (ESM). Use the test's `_registeredTools` access; if McpServer's property differs in `@modelcontextprotocol/sdk` ^1.26, adjust the accessor in the helper to the actual private field (grep `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js` for `registeredTools`).

- [ ] **Step 2: Verify the registry accessor**

Run: `grep -n "registeredTools\|_registeredTools" node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js | head`
Expected: shows the private field name (e.g. `_registeredTools`). If it differs, update `listToolNames` in the test to match before proceeding.

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- test/session.test.ts`
Expected: FAIL — `buildSessionServer` ignores the 3rd arg, so read-only profile still contains `publish_event`/`extract_metadata`.

- [ ] **Step 4: Refactor `registerTools`**

Replace `src/tools/index.ts` body (keep all existing imports) so registration is grouped:

```ts
export interface ToolProfile {
  read?: boolean;
  extract?: boolean;
  write?: boolean;
}

export function registerTools(
  server: McpServer,
  client: AMBRelayClient,
  calendarClient?: AMBRelayClient,
  profile: ToolProfile = { read: true, extract: true, write: true },
): void {
  if (profile.read) {
    // Query / read tools
    registerSearchTool(server, client);
    registerSearchContentTool(server, client);
    registerGetTool(server, client);
    registerBrowseSubjectsTool(server, client);
    registerBrowseResourceTypesTool(server, client);
    registerBrowseEducationalLevelsTool(server, client);
    registerStatsTool(server, client);
    registerListRelaysTool(server, client);
    registerRelayListGetTool(server, client);
    registerSKOSTools(server);
    registerAuthorTools(server);
    registerResolveAuthorTool(server, client);
    if (calendarClient) registerCalendarTools(server, calendarClient);
  }

  if (profile.extract) {
    registerExtractTool(server);
  }

  if (profile.write) {
    // Mutating / signing tools — never exposed on the public HTTP endpoint.
    registerAddRelayTool(server, client);
    registerRemoveRelayTool(server, client);
    registerSKOSBuilderTools(server);
    registerSignerTools(server);
    registerPublishTools(server);
  }
}
```

- [ ] **Step 5: Thread the profile through `buildSessionServer`**

In `src/session.ts`, update the signature and the `registerTools` call:

```ts
export function buildSessionServer(
  ambRelays: string | string[],
  calendarRelays: string | string[],
  profile: import('./tools/index.js').ToolProfile = { read: true, extract: true, write: true },
): SessionServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  const ambClient = new AMBRelayClient(ambRelays);
  const calendarClient = new AMBRelayClient(calendarRelays);
  registerTools(server, ambClient, calendarClient, profile);
  registerResources(server, ambClient);

  return {
    server,
    ambClient,
    calendarClient,
    dispose: () => {
      ambClient.close();
      calendarClient.close();
    },
  };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- test/session.test.ts`
Expected: PASS (existing isolation tests + 3 new profile tests).

- [ ] **Step 7: Build check**

Run: `npm run build`
Expected: no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/tools/index.ts src/session.ts test/session.test.ts
git commit -m "feat(tools): split registration into read/extract/write profiles"
```

---

### Task 4: Wire auth, PRM, and scope-gated sessions into the HTTP transport

**Files:**
- Modify: `src/transport/http.ts`
- Modify: `src/http.ts`
- Test: `test/transport/http.test.ts` (new)
- Modify: `.env.example`

**Interfaces:**
- Consumes: `createJwtVerifier`, `AuthError`, `AuthContext` (Task 1); `buildProtectedResourceMetadata` (Task 2); `buildSessionServer` profile arg (Task 3).
- Produces (changes to `HttpServerOptions` / `HttpServerHandle` in `src/transport/http.ts`):
  - `auth?: { verify: (token: string) => Promise<AuthContext>; resourceUrl: string; issuer: string; scopes: string[] }`
  - `legacyBearerToken?: string` (transitional)
  - `buildMcpServer: (ctx: { scopes: string[] }) => { server: McpServer; dispose?: () => void | Promise<void> }`
  - `HttpServerHandle` gains `port: number`.

#### 4a — PRM route + auth middleware in `src/transport/http.ts`

- [ ] **Step 1: Write the failing integration test**

Create `test/transport/http.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { startHttpServer, type HttpServerHandle } from '../../src/transport/http.js';
import { createJwtVerifier } from '../../src/transport/auth.js';

const ISSUER = 'https://auth.edufeed.org/realms/edufeed';
const AUDIENCE = 'amb-mcp';
const RESOURCE = 'https://mcp.amb.edufeed.org/mcp';

let handle: HttpServerHandle;
let base: string;
let sign: (scope: string) => Promise<string>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'k1';
  jwk.alg = 'RS256';
  const getKey = createLocalJWKSet({ keys: [jwk] });
  const verify = createJwtVerifier({ issuer: ISSUER, audience: AUDIENCE, jwksUri: 'unused', getKey });
  sign = (scope: string) =>
    new SignJWT({ scope })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setExpirationTime('1h')
      .setSubject('tester').sign(privateKey);

  handle = await startHttpServer({
    port: 0,
    host: '127.0.0.1',
    auth: { verify, resourceUrl: RESOURCE, issuer: ISSUER, scopes: ['mcp:read', 'mcp:extract'] },
    buildMcpServer: () => ({ server: new McpServer({ name: 'test', version: '0' }) }),
  });
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(async () => { await handle.close(); });

describe('HTTP transport OAuth', () => {
  it('serves PRM unauthenticated', async () => {
    const res = await fetch(`${base}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.resource).toBe(RESOURCE);
    expect(doc.authorization_servers).toEqual([ISSUER]);
  });

  it('rejects /mcp without a token (401 + WWW-Authenticate pointing at PRM)', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('oauth-protected-resource');
  });

  it('rejects /mcp with a garbage token (401)', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer not-a-jwt' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('keeps /healthz open', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/transport/http.test.ts`
Expected: FAIL — `handle.port` is undefined and `auth` option is unknown; PRM route 404s.

- [ ] **Step 3: Extend `HttpServerOptions` / handle and add the PRM route + middleware**

In `src/transport/http.ts`:

1. Add imports at top:

```ts
import type { AuthContext } from './auth.js';
import { AuthError } from './auth.js';
import { buildProtectedResourceMetadata } from './prm.js';
```

2. Replace the `bearerToken?` field and `buildMcpServer` field in `HttpServerOptions` with:

```ts
  /** OAuth resource-server config. When set, every /mcp request needs a valid JWT. */
  auth?: {
    verify: (token: string) => Promise<AuthContext>;
    resourceUrl: string;
    issuer: string;
    scopes: string[];
  };
  /** Transitional: also accept this static bearer during migration. Remove post-rollout. */
  legacyBearerToken?: string;
  buildMcpServer: (ctx: { scopes: string[] }) => {
    server: McpServer;
    dispose?: () => void | Promise<void>;
  };
```

3. Add `port: number;` to `HttpServerHandle`.

4. In `startHttpServer`, destructure `auth` and `legacyBearerToken` instead of `bearerToken`.

5. Add the PRM route (after `/healthz`, unauthenticated):

```ts
  if (opts.auth) {
    const prm = buildProtectedResourceMetadata({
      resource: opts.auth.resourceUrl,
      issuer: opts.auth.issuer,
      scopes: opts.auth.scopes,
    });
    app.get('/.well-known/oauth-protected-resource', (_req, res) => res.json(prm));
  }
```

6. Replace the `bearerAuth` middleware with a JWT middleware that attaches scopes to `res.locals`:

```ts
  const challenge = opts.auth
    ? `Bearer resource_metadata="${opts.auth.resourceUrl.replace(/\/mcp$/, '')}/.well-known/oauth-protected-resource"`
    : 'Bearer realm="amb-mcp"';

  const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    if (!opts.auth && !legacyBearerToken) return next();
    const header = req.headers.authorization;
    const token = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '') : '';

    if (legacyBearerToken && token === legacyBearerToken) {
      res.locals.scopes = ['mcp:read', 'mcp:extract'];
      return next();
    }
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

7. Replace the three `bearerAuth` references on the `/mcp` routes with `authMiddleware`.

8. At session init, pass scopes into the factory:

```ts
      const { server: mcp, dispose } = buildMcpServer({ scopes: (res.locals.scopes as string[]) ?? [] });
```

9. Resolve and return the port:

```ts
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(port, host, () => resolve(s));
  });
  const resolvedPort = (server.address() as import('node:net').AddressInfo).port;
```

and add `port: resolvedPort,` to the returned handle object.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/transport/http.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Build check + commit**

Run: `npm run build`
Expected: no type errors (note: `src/http.ts` still references the old options — it is updated in 4b; if `tsc` fails only there, proceed to 4b before the build gate).

```bash
git add src/transport/http.ts test/transport/http.test.ts
git commit -m "feat(http): serve PRM and require JWT auth on /mcp"
```

#### 4b — Map scopes → tool profile in `src/http.ts`

- [ ] **Step 6: Add a scope→profile test**

Append to `test/transport/http.test.ts`:

```ts
import { scopesToProfile } from '../../src/http.js';

describe('scopesToProfile', () => {
  it('maps mcp:read + mcp:extract to a read+extract, no-write profile', () => {
    expect(scopesToProfile(['mcp:read', 'mcp:extract'])).toEqual({ read: true, extract: true, write: false });
  });
  it('maps read-only', () => {
    expect(scopesToProfile(['mcp:read'])).toEqual({ read: true, extract: false, write: false });
  });
  it('never enables write tools', () => {
    expect(scopesToProfile(['mcp:read', 'mcp:extract', 'mcp:write']).write).toBe(false);
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npm test -- test/transport/http.test.ts -t scopesToProfile`
Expected: FAIL — `scopesToProfile` not exported.

- [ ] **Step 8: Update `src/http.ts`**

1. Add the exported helper near the top (after imports):

```ts
import type { ToolProfile } from './tools/index.js';

export function scopesToProfile(scopes: string[]): ToolProfile {
  return {
    read: scopes.includes('mcp:read'),
    extract: scopes.includes('mcp:extract'),
    write: false, // write/signing tools are never exposed over HTTP
  };
}
```

2. Replace the env block (lines ~27-35) — drop `HTTP_BEARER_TOKEN`, add OAuth env + transitional legacy bearer:

```ts
const HTTP_PORT = Number(process.env.HTTP_PORT ?? 3000);
const HTTP_HOST = process.env.HTTP_HOST ?? '0.0.0.0';
const OAUTH_ISSUER = process.env.OAUTH_ISSUER || 'https://auth.edufeed.org/realms/edufeed';
const OAUTH_AUDIENCE = process.env.OAUTH_AUDIENCE || 'amb-mcp';
const OAUTH_JWKS_URI =
  process.env.OAUTH_JWKS_URI || `${OAUTH_ISSUER}/protocol/openid-connect/certs`;
const OAUTH_RESOURCE_URL =
  process.env.OAUTH_RESOURCE_URL || 'https://mcp.amb.edufeed.org/mcp';
const LEGACY_BEARER_TOKEN = process.env.LEGACY_BEARER_TOKEN || undefined; // transitional
const HTTP_ALLOWED_HOSTS = process.env.HTTP_ALLOWED_HOSTS?.split(',').map((s) => s.trim()).filter(Boolean);
const HTTP_ALLOWED_ORIGINS = process.env.HTTP_ALLOWED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean);
```

3. Add the verifier import and construction in `main()`:

```ts
import { createJwtVerifier } from './transport/auth.js';
// ...inside main(), before startHttpServer:
const verify = createJwtVerifier({ issuer: OAUTH_ISSUER, audience: OAUTH_AUDIENCE, jwksUri: OAUTH_JWKS_URI });
```

4. Replace the `startHttpServer({...})` call's `bearerToken` and `buildMcpServer`:

```ts
  const handle = await startHttpServer({
    port: HTTP_PORT,
    host: HTTP_HOST,
    auth: {
      verify,
      resourceUrl: OAUTH_RESOURCE_URL,
      issuer: OAUTH_ISSUER,
      scopes: ['mcp:read', 'mcp:extract'],
    },
    legacyBearerToken: LEGACY_BEARER_TOKEN,
    allowedHosts: HTTP_ALLOWED_HOSTS,
    allowedOrigins: HTTP_ALLOWED_ORIGINS,
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    buildMcpServer: ({ scopes }) => {
      const { server, dispose } = buildSessionServer(
        AMB_RELAYS,
        CALENDAR_RELAYS,
        scopesToProfile(scopes),
      );
      return { server, dispose };
    },
  });
```

5. Update the startup log line that referenced `HTTP_BEARER_TOKEN`:

```ts
  console.log(`Auth: OAuth (issuer ${OAUTH_ISSUER})${LEGACY_BEARER_TOKEN ? ' + legacy bearer' : ''}`);
```

- [ ] **Step 9: Run the full suite**

Run: `npm test`
Expected: PASS — all suites including the new scope/profile and http tests.

- [ ] **Step 10: Build check**

Run: `npm run build`
Expected: no type errors.

- [ ] **Step 11: Update `.env.example`**

Replace the `HTTP_BEARER_TOKEN` block (lines ~52-54) with:

```
# --- OAuth resource server (HTTP transport) ---
# Keycloak realm issuer and the audience amb-mcp expects in tokens.
# OAUTH_ISSUER=https://auth.edufeed.org/realms/edufeed
# OAUTH_AUDIENCE=amb-mcp
# OAUTH_JWKS_URI defaults to <issuer>/protocol/openid-connect/certs
# OAUTH_JWKS_URI=
# Public resource URL advertised in the PRM document.
# OAUTH_RESOURCE_URL=https://mcp.amb.edufeed.org/mcp
# Transitional only: also accept this static bearer during rollout, then remove.
# LEGACY_BEARER_TOKEN=
```

- [ ] **Step 12: Commit**

```bash
git add src/http.ts test/transport/http.test.ts .env.example
git commit -m "feat(http): map token scopes to tool profile; drop static bearer"
```

---

### Task 5: Manual end-to-end verification (with Keycloak)

> This task runs only after Plan B (Keycloak) exists. It is verification, not code.

- [ ] **Step 1:** Obtain a client-credentials token from Keycloak:
  `curl -s -d grant_type=client_credentials -d client_id=edufeed-app -d client_secret=<secret> -d scope='mcp:read mcp:extract' https://auth.edufeed.org/realms/edufeed/protocol/openid-connect/token | jq -r .access_token`
- [ ] **Step 2:** `curl https://mcp.amb.edufeed.org/.well-known/oauth-protected-resource` returns the PRM JSON.
- [ ] **Step 3:** Initialize + `tools/list` with the token shows `extract_metadata`; with a `mcp:read`-only token it does NOT.
- [ ] **Step 4:** `tools/list` never shows `publish_event` / `sign_event` regardless of scope.
- [ ] **Step 5:** Add amb-mcp as a claude.ai custom connector; confirm the discovery → login → consent → tool-call flow works. If claude.ai's registration step fails, capture the request to `/.well-known/*` and adjust Keycloak (DCR/CIMD) per the spec's open-questions note.

---

## Follow-on plans (separate, not in this plan)

- **Plan B — Keycloak homelab role** (`/home/laoc/coding/homelab`): `roles/keycloak` + `playbooks/deploy_keycloak.yml`, postgres, Traefik `auth.edufeed.org`, DNS, realm `edufeed` with scopes/audience-mapper/DCR/clients, vault secrets. Author/execute via the homelab agent.
- **Plan C — Consumer migration** (`edufeed-app`, `nope-chatbot`): add a client-credentials token helper to each MCP client, swap env to `OAUTH_*`, point `AMB_MCP_URL` at internal `http://amb-mcp:3000/mcp`; homelab playbook/template edits at `playbooks/deploy_edufeed_app.yml` (~257, ~586) and `roles/nope-chatbot/templates/env.j2` (~19).

**Rollout order:** B → deploy amb-mcp (this plan) with `LEGACY_BEARER_TOKEN` set → C → unset `LEGACY_BEARER_TOKEN` and remove the transitional branch (Task 4a step 6) → retire sigbit proxy → Task 5 verification.

## Self-Review

- **Spec coverage:** PRM (Task 2/4a), JWT validation + iss/aud/exp (Task 1), scope model + `tools/list` filtering via scope-gated registration (Tasks 3+4b), write-tool exclusion (Task 3), env/config + static-bearer removal (Task 4b), zero-downtime dual-accept (Task 4a `legacyBearerToken`), testing (every task), claude.ai DCR risk (Task 5 step 5). Keycloak role + consumer migration are explicitly carved out as Plans B/C.
- **Placeholder scan:** none — every code step shows full code; the one runtime-detail dependency (McpServer registry field) has an explicit verification step (Task 3 step 2).
- **Type consistency:** `AuthContext`/`AuthConfig`/`AuthError` (Task 1) consumed unchanged in Task 4a; `ToolProfile` (Task 3) consumed by `scopesToProfile` (Task 4b) and `buildSessionServer`; `HttpServerHandle.port` produced in 4a and consumed by the test; `buildMcpServer(ctx)` signature consistent between http.ts and the test.
