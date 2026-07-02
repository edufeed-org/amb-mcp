# Plan C — edufeed-app Client-Credentials Migration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Target repo:** `/home/laoc/coding/edufeed/edufeed-app` (branch `dev`). This plan doc lives in amb-mcp for discoverability, but ALL edits + commits happen in edufeed-app.

**Goal:** Make edufeed-app authenticate to amb-mcp's `extract_metadata` with a Keycloak client-credentials JWT instead of the shared static `AMB_MCP_BEARER_TOKEN`.

**Architecture:** A pure `createTokenProvider(config)` factory (cached, single-flight, 60s skew) plus a thin env-bound `getAmbMcpToken()` singleton. `/api/enrich/+server.js` calls `await getAmbMcpToken()` and passes the result as the existing `bearerToken` argument to `callExtractMetadata`. No change to `ambMcpClient.js` (it already accepts a bearer string).

**Tech Stack:** SvelteKit (server-side JS + JSDoc), `$env/dynamic/private`, Vitest 4 (`vitest run`, node environment), global `fetch`.

## Global Constraints

- Keycloak token endpoint: `https://auth.edufeed.org/realms/edufeed/protocol/openid-connect/token`; grant `client_credentials`; client `edufeed-app`; the client's default scopes already include `mcp:read mcp:extract` (no explicit `scope` required).
- Token request MUST be `application/x-www-form-urlencoded` with `grant_type`, `client_id`, `client_secret` (client_secret_post). Never log the secret or the access token.
- New env vars (identical names in both consumers): `AMB_MCP_TOKEN_URL`, `AMB_MCP_CLIENT_ID`, `AMB_MCP_CLIENT_SECRET`, optional `AMB_MCP_SCOPE`. Remove `AMB_MCP_BEARER_TOKEN`.
- Token-fetch failure MUST surface through the existing `/api/enrich` `ai_unavailable` error envelope (no crash, no silent anonymous fallback).
- Test framework is Vitest; unit tests target the pure factory (no env mock). Mock `fetch` with `vi.stubGlobal`; never hit live Keycloak.

---

### Task 1: Cached client-credentials token provider

**Files:**
- Create: `src/lib/server/ambMcpToken.js`
- Test: `src/lib/server/__tests__/ambMcpToken.test.js`

**Interfaces:**
- Consumes: global `fetch`; `$env/dynamic/private` `env` (only inside the `getAmbMcpToken` singleton).
- Produces:
  - `createTokenProvider(config: { tokenUrl: string, clientId: string, clientSecret: string, scope?: string }) => (() => Promise<string>)` — pure factory returning a cached async getter.
  - `getAmbMcpToken(): Promise<string>` — env-bound singleton getter used by the route.

- [ ] **Step 1: Write the failing test**

Create `src/lib/server/__tests__/ambMcpToken.test.js`:

```js
/** @vitest-environment node */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTokenProvider } from '../ambMcpToken.js';

/** Build a Keycloak-shaped token response. */
function tokenResponse(accessToken, expiresIn = 3600, status = 200) {
  return new Response(JSON.stringify({ access_token: accessToken, expires_in: expiresIn }), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

const CONFIG = {
  tokenUrl: 'https://auth.test/realms/edufeed/protocol/openid-connect/token',
  clientId: 'edufeed-app',
  clientSecret: 's3cret'
};

describe('createTokenProvider', () => {
  /** @type {ReturnType<typeof vi.fn>} */
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fetches a token with a form-encoded client_credentials body', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse('tok-1'));
    const getToken = createTokenProvider(CONFIG);

    const token = await getToken();

    expect(token).toBe('tok-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(CONFIG.tokenUrl);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const params = new URLSearchParams(init.body);
    expect(params.get('grant_type')).toBe('client_credentials');
    expect(params.get('client_id')).toBe('edufeed-app');
    expect(params.get('client_secret')).toBe('s3cret');
    expect(params.get('scope')).toBeNull();
  });

  it('caches the token across calls within its lifetime (one network call)', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse('tok-1', 3600));
    const getToken = createTokenProvider(CONFIG);

    expect(await getToken()).toBe('tok-1');
    expect(await getToken()).toBe('tok-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes after the token expires (minus skew)', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse('tok-1', 3600))
      .mockResolvedValueOnce(tokenResponse('tok-2', 3600));
    const getToken = createTokenProvider(CONFIG);

    expect(await getToken()).toBe('tok-1');
    // Advance past expiry (3600s) so the 60s-skew cache is stale.
    vi.advanceTimersByTime(3600_000);
    expect(await getToken()).toBe('tok-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares a single in-flight fetch under concurrent callers', async () => {
    let resolveFetch;
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFetch = () => resolve(tokenResponse('tok-1'));
      })
    );
    const getToken = createTokenProvider(CONFIG);

    const p1 = getToken();
    const p2 = getToken();
    resolveFetch();

    expect(await p1).toBe('tok-1');
    expect(await p2).toBe('tok-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('includes scope when configured', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse('tok-1'));
    const getToken = createTokenProvider({ ...CONFIG, scope: 'mcp:read mcp:extract' });

    await getToken();

    const params = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(params.get('scope')).toBe('mcp:read mcp:extract');
  });

  it('throws with the HTTP status on a non-2xx token response', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{"error":"invalid_client"}', { status: 401 })
    );
    const getToken = createTokenProvider(CONFIG);

    await expect(getToken()).rejects.toThrow(/HTTP 401/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/server/__tests__/ambMcpToken.test.js`
Expected: FAIL — `../ambMcpToken.js` does not exist (import error / "Failed to resolve").

- [ ] **Step 3: Implement the token provider**

Create `src/lib/server/ambMcpToken.js`:

```js
/**
 * Cached client-credentials token provider for amb-mcp.
 *
 * amb-mcp gates `extract_metadata` behind an `mcp:extract` token. This module
 * obtains that token from Keycloak via the client-credentials grant and caches
 * it in memory until shortly before expiry, so `/api/enrich` sends a fresh JWT
 * without a token round-trip on every call.
 */

import { env } from '$env/dynamic/private';

/** Refresh this many ms before the token's stated expiry. */
const SKEW_MS = 60_000;

/**
 * @typedef {object} ClientCredentialsConfig
 * @property {string} tokenUrl
 * @property {string} clientId
 * @property {string} clientSecret
 * @property {string} [scope]
 */

/**
 * Build a cached token getter. Pure (no env access) so it is trivially testable.
 * @param {ClientCredentialsConfig} config
 * @returns {() => Promise<string>}
 */
export function createTokenProvider(config) {
  /** @type {{ token: string, expiresAt: number } | null} */
  let cached = null;
  /** @type {Promise<string> | null} */
  let inFlight = null;

  async function fetchToken() {
    if (!config.tokenUrl || !config.clientId || !config.clientSecret) {
      throw new Error(
        'amb-mcp client-credentials config incomplete (tokenUrl/clientId/clientSecret)'
      );
    }
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.clientId,
      client_secret: config.clientSecret
    });
    if (config.scope) body.set('scope', config.scope);

    const res = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`amb-mcp token endpoint HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = await res.json();
    const token = json.access_token;
    if (typeof token !== 'string' || token === '') {
      throw new Error('amb-mcp token endpoint response missing access_token');
    }
    const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 60;
    cached = { token, expiresAt: Date.now() + expiresIn * 1000 - SKEW_MS };
    return token;
  }

  return async function getToken() {
    if (cached && Date.now() < cached.expiresAt) return cached.token;
    if (inFlight) return inFlight;
    inFlight = fetchToken().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

/** @type {(() => Promise<string>) | null} */
let singleton = null;

/**
 * Env-bound singleton getter used by the /api/enrich route.
 * @returns {Promise<string>} a valid amb-mcp bearer token.
 */
export function getAmbMcpToken() {
  if (!singleton) {
    singleton = createTokenProvider({
      tokenUrl: env.AMB_MCP_TOKEN_URL,
      clientId: env.AMB_MCP_CLIENT_ID,
      clientSecret: env.AMB_MCP_CLIENT_SECRET,
      scope: env.AMB_MCP_SCOPE || undefined
    });
  }
  return singleton();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/server/__tests__/ambMcpToken.test.js`
Expected: PASS — all six cases green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/ambMcpToken.js src/lib/server/__tests__/ambMcpToken.test.js
git commit -m "feat(mcp): add cached client-credentials token provider for amb-mcp"
```

---

### Task 2: Wire /api/enrich to the token provider + drop the static bearer

**Files:**
- Modify: `src/routes/api/enrich/+server.js` (the `callExtractMetadata({...})` call, ~line 194-200; import block ~line 13-16)
- Modify: `.env.example` (the `AMB_MCP_*` block, ~lines 337-343)

**Interfaces:**
- Consumes: `getAmbMcpToken(): Promise<string>` from Task 1.
- Produces: no exported signature change; behavioral change only (route sources its bearer from Keycloak).

- [ ] **Step 1: Add the import**

In `src/routes/api/enrich/+server.js`, add to the import block near the top (next to the existing `callExtractMetadata` import at line 15):

```js
import { getAmbMcpToken } from '$lib/server/ambMcpToken.js';
```

- [ ] **Step 2: Replace the bearer source inside the stream**

In the `ReadableStream` `start`, replace the `callExtractMetadata` call (currently passing `bearerToken: env.AMB_MCP_BEARER_TOKEN`) with a token fetched from Keycloak:

```js
      try {
        const result = await callExtractMetadata({
          mcpUrl,
          bearerToken: await getAmbMcpToken(),
          urls,
          variant,
          skosSchemes: buildSkosSchemes(variant, bildungsbereich)
        });
        controller.enqueue(enc.encode(JSON.stringify(result)));
      } catch (err) {
        console.error('[/api/enrich] extract_metadata failed:', err);
        const code = /** @type {{ code?: unknown }} */ (err)?.code;
        const body = {
          error: 'ai_unavailable',
          code: typeof code === 'string' ? code : 'unknown'
        };
        controller.enqueue(enc.encode(JSON.stringify(body)));
      } finally {
        clearInterval(heartbeat);
        controller.close();
      }
```

(The `catch` already wraps the whole `try`, so a token-fetch throw is caught and returns the `ai_unavailable` envelope — no new error handling needed.)

- [ ] **Step 3: Update `.env.example`**

In `.env.example`, replace the two lines:

```
AMB_MCP_URL=https://mcp.amb.edufeed.org/mcp
# AMB_MCP_BEARER_TOKEN=  # required if the MCP host enforces bearer auth
```

with:

```
AMB_MCP_URL=https://mcp.amb.edufeed.org/mcp
# amb-mcp gates extract_metadata behind an mcp:extract token. edufeed-app
# authenticates with a Keycloak client-credentials grant (client "edufeed-app").
# Read tools are public and need none of this; only extraction does.
AMB_MCP_TOKEN_URL=https://auth.edufeed.org/realms/edufeed/protocol/openid-connect/token
AMB_MCP_CLIENT_ID=edufeed-app
AMB_MCP_CLIENT_SECRET=
# AMB_MCP_SCOPE=  # optional; the client's default scopes already grant mcp:read mcp:extract
```

- [ ] **Step 4: Run the enrich route + client tests to confirm no regression**

Run: `npm test -- src/lib/__tests__/api-enrich-route.test.js src/lib/server/__tests__/ambMcpClient.test.js`
Expected: PASS. If any existing enrich-route test stubbed `env.AMB_MCP_BEARER_TOKEN`, update that stub to instead mock `$lib/server/ambMcpToken.js`'s `getAmbMcpToken` (e.g. `vi.mock('$lib/server/ambMcpToken.js', () => ({ getAmbMcpToken: () => Promise.resolve('test-token') }))`) so the route resolves a token in the test; keep the assertions otherwise unchanged.

- [ ] **Step 5: Run the full suite + build**

Run: `npm test`
Expected: PASS — entire suite green.

Run: `npm run build`
Expected: SvelteKit build completes with no errors.

- [ ] **Step 6: Commit**

```bash
git add src/routes/api/enrich/+server.js .env.example
git commit -m "feat(enrich): authenticate to amb-mcp via client-credentials token"
```

---

## Notes for the executor

- Do NOT deploy from this plan. Deployment (homelab env swap for all 3 instances) is a separate homelab plan and is sequenced with the chat-bot migration; amb-mcp keeps accepting the legacy bearer until both consumers are live, so this change is safe to merge independently.
- `ambMcpClient.js` is intentionally untouched — it already forwards whatever `bearerToken` string it is given.
