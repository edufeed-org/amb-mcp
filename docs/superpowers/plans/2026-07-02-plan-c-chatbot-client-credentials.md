# Plan C — edufeed-chat-bot Client-Credentials Migration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Target repo:** `/home/laoc/coding/edufeed/edufeed-chat-bot` (branch `main`). This plan doc lives in amb-mcp for discoverability, but ALL edits + commits happen in edufeed-chat-bot.

**Goal:** Make the chat-bot's `amb` MCP connection authenticate with a Keycloak client-credentials JWT (so the LLM keeps the `extract_metadata` tool) instead of the shared static `AMB_MCP_BEARER_TOKEN`.

**Architecture:** A pure `createTokenProvider(config)` factory (cached, single-flight, 60s skew) identical in shape to edufeed-app's. The MCP config gains an optional `oauth` block; `registry.ts` builds the transport's `Authorization` header from a per-server token provider (memoized so the cache survives reconnects). The existing static-`bearerToken` path stays for any non-OAuth server.

**Tech Stack:** SvelteKit (TypeScript), `@modelcontextprotocol/sdk` **1.29.0** client (`StreamableHTTPClientTransport` with `requestInit.headers`), Vitest 4 (`vitest run`), global `fetch`.

## Global Constraints

- Keycloak token endpoint: `https://auth.edufeed.org/realms/edufeed/protocol/openid-connect/token`; grant `client_credentials`; client `nope-chatbot`; default scopes already include `mcp:read mcp:extract`.
- Token request MUST be `application/x-www-form-urlencoded` with `grant_type`, `client_id`, `client_secret` (client_secret_post). Never log the secret or the access token.
- New env vars (identical names to edufeed-app): `AMB_MCP_TOKEN_URL`, `AMB_MCP_CLIENT_ID`, `AMB_MCP_CLIENT_SECRET`, optional `AMB_MCP_SCOPE`. Remove `AMB_MCP_BEARER_TOKEN`.
- SDK 1.29.0's transport `authProvider` is the heavy redirect-oriented `OAuthClientProvider`; do NOT implement it. Inject the token via `requestInit.headers.Authorization` (the mechanism the code already uses). This is safe because amb-mcp binds a session's scopes at `initialize`; `reconnect()` rebuilds the transport and re-reads a fresh token.
- Keep the static `bearerToken` path working (nostrbook is stdio, but the field stays valid for any future static-token HTTP server); its existing tests stay green.
- Test framework is Vitest; unit-test the pure factory (no env/SDK mock). Mock `fetch` with `vi.stubGlobal`; never hit live Keycloak.

---

### Task 1: Cached client-credentials token provider

**Files:**
- Create: `src/lib/llm/mcp/oauthToken.ts`
- Test: `src/lib/llm/mcp/oauthToken.test.ts`

**Interfaces:**
- Consumes: global `fetch`.
- Produces:
  - `interface ClientCredentialsConfig { tokenUrl: string; clientId: string; clientSecret: string; scope?: string }`
  - `createTokenProvider(config: ClientCredentialsConfig): () => Promise<string>` — cached, single-flight async getter.

- [ ] **Step 1: Write the failing test**

Create `src/lib/llm/mcp/oauthToken.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTokenProvider } from './oauthToken';

function tokenResponse(accessToken: string, expiresIn = 3600, status = 200): Response {
	return new Response(JSON.stringify({ access_token: accessToken, expires_in: expiresIn }), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

const CONFIG = {
	tokenUrl: 'https://auth.test/realms/edufeed/protocol/openid-connect/token',
	clientId: 'nope-chatbot',
	clientSecret: 's3cret'
};

describe('createTokenProvider', () => {
	let fetchMock: ReturnType<typeof vi.fn>;

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

		expect(await getToken()).toBe('tok-1');
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe(CONFIG.tokenUrl);
		expect(init.method).toBe('POST');
		expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
		const params = new URLSearchParams(init.body as string);
		expect(params.get('grant_type')).toBe('client_credentials');
		expect(params.get('client_id')).toBe('nope-chatbot');
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
		vi.advanceTimersByTime(3600_000);
		expect(await getToken()).toBe('tok-2');
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('shares a single in-flight fetch under concurrent callers', async () => {
		let resolveFetch!: () => void;
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
		const params = new URLSearchParams(fetchMock.mock.calls[0][1].body as string);
		expect(params.get('scope')).toBe('mcp:read mcp:extract');
	});

	it('throws with the HTTP status on a non-2xx token response', async () => {
		fetchMock.mockResolvedValueOnce(new Response('{"error":"invalid_client"}', { status: 401 }));
		const getToken = createTokenProvider(CONFIG);

		await expect(getToken()).rejects.toThrow(/HTTP 401/);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/llm/mcp/oauthToken.test.ts`
Expected: FAIL — `./oauthToken` does not exist.

- [ ] **Step 3: Implement the token provider**

Create `src/lib/llm/mcp/oauthToken.ts`:

```ts
/**
 * Cached client-credentials token provider for amb-mcp.
 *
 * amb-mcp gates `extract_metadata` behind an `mcp:extract` token. This module
 * obtains that token from Keycloak via the client-credentials grant and caches
 * it in memory until shortly before expiry, so the amb MCP connection presents
 * a fresh JWT without a token round-trip on every (re)connect.
 */

export interface ClientCredentialsConfig {
	tokenUrl: string;
	clientId: string;
	clientSecret: string;
	scope?: string;
}

/** Refresh this many ms before the token's stated expiry. */
const SKEW_MS = 60_000;

/**
 * Build a cached token getter. Pure (no env access) so it is trivially testable.
 */
export function createTokenProvider(config: ClientCredentialsConfig): () => Promise<string> {
	let cached: { token: string; expiresAt: number } | null = null;
	let inFlight: Promise<string> | null = null;

	async function fetchToken(): Promise<string> {
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
		const json = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
		const token = json.access_token;
		if (typeof token !== 'string' || token === '') {
			throw new Error('amb-mcp token endpoint response missing access_token');
		}
		const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 60;
		cached = { token, expiresAt: Date.now() + expiresIn * 1000 - SKEW_MS };
		return token;
	}

	return async function getToken(): Promise<string> {
		if (cached && Date.now() < cached.expiresAt) return cached.token;
		if (inFlight) return inFlight;
		inFlight = fetchToken().finally(() => {
			inFlight = null;
		});
		return inFlight;
	};
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/llm/mcp/oauthToken.test.ts`
Expected: PASS — all six cases green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/llm/mcp/oauthToken.ts src/lib/llm/mcp/oauthToken.test.ts
git commit -m "feat(mcp): add cached client-credentials token provider"
```

---

### Task 2: Wire the amb server to client-credentials

**Files:**
- Modify: `src/lib/llm/mcp/types.ts` (add `oauth` to http config + resolved config)
- Modify: `src/lib/llm/mcp/config.ts` (`resolveServerConfig`, ~lines 62-73)
- Modify: `src/lib/llm/mcp/registry.ts` (imports; `createTransport` → async, ~lines 70-86; `establish` call site ~line 94; new provider memo)
- Modify: `mcp-servers.json` (the `amb` entry)
- Modify: `.env.example` (lines 1-5)
- Test: `src/lib/llm/mcp/registry.oauth.test.ts`

**Interfaces:**
- Consumes: `createTokenProvider` + `ClientCredentialsConfig` from Task 1.
- Produces: `ClientCredentialsOAuthConfig` type on http server configs; `registry` builds `Authorization: Bearer <token>` for oauth-configured servers.

- [ ] **Step 1: Write the failing integration test**

Create `src/lib/llm/mcp/registry.oauth.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const connect = vi.fn();
const listTools = vi.fn();
const getInstructions = vi.fn();
const transportArgs: Array<{ url: URL; opts: { requestInit?: { headers?: Record<string, string> } } }> = [];

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
	Client: class {
		connect = connect;
		listTools = listTools;
		getInstructions = getInstructions;
		close = vi.fn();
	}
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
	StreamableHTTPClientTransport: class {
		constructor(url: URL, opts: { requestInit?: { headers?: Record<string, string> } }) {
			transportArgs.push({ url, opts });
		}
	}
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: class {} }));

vi.mock('./config', () => ({
	loadMCPConfig: () => [
		{
			id: 'amb',
			name: 'AMB',
			description: 'test',
			enabled: true,
			transport: 'http',
			url: 'https://mcp.example.org/mcp',
			oauth: {
				tokenUrl: 'https://auth.test/token',
				clientId: 'nope-chatbot',
				clientSecret: 's3cret'
			}
		}
	]
}));

vi.mock('./oauthToken', () => ({
	createTokenProvider: () => () => Promise.resolve('tok-xyz')
}));

import { MCPRegistry } from './registry';

beforeEach(() => {
	transportArgs.length = 0;
	connect.mockResolvedValue(undefined);
	getInstructions.mockReturnValue('');
	listTools.mockResolvedValue({ tools: [] });
});

describe('MCPRegistry OAuth client-credentials', () => {
	it('sets Authorization from a fetched client-credentials token', async () => {
		const registry = new MCPRegistry();
		await registry.initialize();

		expect(transportArgs).toHaveLength(1);
		expect(transportArgs[0].opts.requestInit?.headers?.Authorization).toBe('Bearer tok-xyz');
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/llm/mcp/registry.oauth.test.ts`
Expected: FAIL — the registry ignores the `oauth` block today, so no Authorization header is set (`toBe('Bearer tok-xyz')` fails, value is `undefined`).

- [ ] **Step 3: Add the `oauth` type**

In `src/lib/llm/mcp/types.ts`, add the interface after `MCPServerConfigBase` (before `MCPHttpServerConfig`):

```ts
/**
 * Client-credentials OAuth config for authenticating to an HTTP MCP server.
 * All fields can use ${ENV_VAR} syntax.
 */
export interface ClientCredentialsOAuthConfig {
	/** Token endpoint, e.g. https://auth.example/realms/x/protocol/openid-connect/token */
	tokenUrl: string;
	clientId: string;
	clientSecret: string;
	/** Optional space-separated scopes */
	scope?: string;
}
```

Add `oauth?: ClientCredentialsOAuthConfig;` to both `MCPHttpServerConfig` (after `bearerToken?`) and `ResolvedHttpMCPServerConfig` (after `bearerToken?`).

- [ ] **Step 4: Resolve the `oauth` block in config.ts**

In `src/lib/llm/mcp/config.ts` `resolveServerConfig`, after the `bearerToken` block (currently ending at line 72, before `return resolved;`), add:

```ts
	if (config.oauth) {
		resolved.oauth = {
			tokenUrl: substituteEnvVars(config.oauth.tokenUrl),
			clientId: substituteEnvVars(config.oauth.clientId),
			clientSecret: substituteEnvVars(config.oauth.clientSecret),
			...(config.oauth.scope ? { scope: substituteEnvVars(config.oauth.scope) } : {})
		};
	}
```

- [ ] **Step 5: Build the header from a memoized provider in registry.ts**

In `src/lib/llm/mcp/registry.ts`:

Add imports near the top (after the existing type import on line 12):

```ts
import { createTokenProvider } from './oauthToken';
import type { ClientCredentialsOAuthConfig } from './types';
```

Add a field to the class (near `private connections` on line 49):

```ts
	private tokenProviders: Map<string, () => Promise<string>> = new Map();
```

Replace `createTransport` (lines 70-86) with an async version and add a token helper:

```ts
	/**
	 * Create a fresh transport for a server config.
	 */
	private async createTransport(config: ResolvedMCPServerConfig): Promise<MCPTransport> {
		if (config.transport === 'stdio') {
			return new StdioClientTransport({
				command: config.command,
				args: config.args,
				env: config.env
			});
		}

		const headers: Record<string, string> = {};
		if (config.oauth) {
			headers.Authorization = `Bearer ${await this.getOAuthToken(config.id, config.oauth)}`;
		} else if (config.bearerToken) {
			headers.Authorization = `Bearer ${config.bearerToken}`;
		}
		return new StreamableHTTPClientTransport(new URL(config.url), {
			requestInit: { headers }
		});
	}

	/**
	 * Resolve a client-credentials token for a server, memoizing the provider per
	 * server id so its in-memory cache survives reconnects.
	 */
	private getOAuthToken(id: string, oauth: ClientCredentialsOAuthConfig): Promise<string> {
		let provider = this.tokenProviders.get(id);
		if (!provider) {
			provider = createTokenProvider(oauth);
			this.tokenProviders.set(id, provider);
		}
		return provider();
	}
```

In `establish` (line 94), await the now-async factory:

```ts
		const transport = await this.createTransport(connection.config);
```

- [ ] **Step 6: Run the integration test to verify it passes**

Run: `npm test -- src/lib/llm/mcp/registry.oauth.test.ts`
Expected: PASS — Authorization header is `Bearer tok-xyz`.

- [ ] **Step 7: Point mcp-servers.json + .env.example at client-credentials**

In `mcp-servers.json`, replace the `amb` server's `"bearerToken": "${AMB_MCP_BEARER_TOKEN}"` line with an `oauth` block:

```json
    {
      "id": "amb",
      "name": "AMB Educational Resources",
      "description": "Search and browse educational resources using AMB metadata standard",
      "url": "${AMB_MCP_URL}",
      "oauth": {
        "tokenUrl": "${AMB_MCP_TOKEN_URL}",
        "clientId": "${AMB_MCP_CLIENT_ID}",
        "clientSecret": "${AMB_MCP_CLIENT_SECRET}"
      },
      "enabled": true
    },
```

In `.env.example`, replace lines 1-5:

```
# MCP Server Configuration (Streamable HTTP transport)
# URL of the AMB MCP server (referenced in mcp-servers.json via ${VAR})
AMB_MCP_URL=https://mcp.amb.edufeed.org/mcp
# amb-mcp gates extract_metadata behind an mcp:extract token; the bot
# authenticates with a Keycloak client-credentials grant (client "nope-chatbot").
# Read tools are public — only the LLM's extract tool needs these.
AMB_MCP_TOKEN_URL=https://auth.edufeed.org/realms/edufeed/protocol/openid-connect/token
AMB_MCP_CLIENT_ID=nope-chatbot
AMB_MCP_CLIENT_SECRET=
# AMB_MCP_SCOPE=  # optional; the client's default scopes already grant mcp:read mcp:extract
```

- [ ] **Step 8: Run the full suite + typecheck**

Run: `npm test`
Expected: PASS — including the existing `registry.test.ts` (static/stdio path unchanged) and the new oauth tests.

Run: `npm run check` (svelte-check / tsc)
Expected: no type errors. (If the repo uses a different typecheck script, run that — check `package.json` `scripts`.)

- [ ] **Step 9: Commit**

```bash
git add src/lib/llm/mcp/types.ts src/lib/llm/mcp/config.ts src/lib/llm/mcp/registry.ts src/lib/llm/mcp/registry.oauth.test.ts mcp-servers.json .env.example
git commit -m "feat(mcp): authenticate amb server via client-credentials"
```

---

## Notes for the executor

- Do NOT deploy from this plan. The homelab env swap for `nope-chatbot` is in the homelab plan, sequenced with edufeed-app; amb-mcp keeps accepting the legacy bearer until both consumers are live.
- The static `bearerToken` path is deliberately retained — do not delete it.
- `AGENTS.md` / `README.md` in the repo mention `AMB_MCP_BEARER_TOKEN`; if the executor sees a quick doc reference, update it to the new vars, but do not expand scope beyond the amb auth change.
