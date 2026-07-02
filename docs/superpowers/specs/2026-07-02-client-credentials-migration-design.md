# Client-Credentials Migration for amb-mcp Consumers — Design

**Date:** 2026-07-02
**Status:** Approved (design), pending implementation plans
**Scope:** Plan C of the access-model work (a.k.a. "Sub-project B"). Migrates the
two first-party consumers of amb-mcp off the shared static `LEGACY_BEARER_TOKEN`
and onto Keycloak client-credentials, then removes the legacy token path from
amb-mcp entirely. This is the last step of the OAuth resource-server initiative.

Public reads (Sub-project A) is already live: anonymous `/mcp` sessions get
`mcp:read`; only `extract_metadata` requires an `mcp:extract` token. This spec
concerns the *authenticated* consumers that call `extract_metadata`.

## Goal

Retire the shared static bearer token (`vault_amb_mcp_bearer_token`) as a
credential for amb-mcp. Each first-party consumer (edufeed-app, edufeed-chat-bot)
authenticates with its own Keycloak client-credentials grant, obtaining a
short-lived RS256 JWT carrying `mcp:read mcp:extract`. Once both consumers use
JWTs, remove the `LEGACY_BEARER_TOKEN` acceptance path from amb-mcp.

## Motivation

The static bearer was always transitional. It is a single shared secret that
grants read+extract to anyone who holds it, with no per-consumer identity, no
expiry, and no revocation short of rotating it everywhere at once. The OAuth
initiative stood up Keycloak precisely so first-party services authenticate as
distinct clients with scoped, expiring tokens. The Keycloak side is already
provisioned (service-account clients exist); this plan finishes the job on the
consumer and resource-server sides and removes the shared secret.

## Current State (facts)

**Keycloak realm** (`homelab/roles/keycloak/templates/edufeed-realm.json.j2`) —
already provisioned, no change required:
- Client `edufeed-app`: `serviceAccountsEnabled: true`, secret
  `{{ keycloak_client_secret_edufeed_app }}`, default scopes
  `["amb-mcp-audience", "mcp:read", "mcp:extract"]`.
- Client `nope-chatbot`: `serviceAccountsEnabled: true`, secret
  `{{ keycloak_client_secret_nope_chatbot }}`, default scopes
  `["amb-mcp-audience", "mcp:read", "mcp:extract"]`.
- Token endpoint:
  `https://auth.edufeed.org/realms/edufeed/protocol/openid-connect/token`.
- A client-credentials grant against either client already mints a JWT with
  `iss=https://auth.edufeed.org/realms/edufeed`, `aud=amb-mcp`,
  `scope="mcp:read mcp:extract"` — exactly what amb-mcp validates.

**amb-mcp** — already validates these JWTs; still also accepts the legacy bearer:
- `src/http.ts:48` reads `LEGACY_BEARER_TOKEN` from env; `:100` passes it to
  `startHttpServer` as `legacyBearerToken`; `:57` logs "+ legacy bearer".
- `src/transport/http.ts:77` binds `legacyBearerToken`; `:127-135` (approx) is
  the constant-time compare branch that grants `['mcp:read', 'mcp:extract']` on
  a match, using `timingSafeEqual`.
- `test/transport/http.test.ts` has a `describe('HTTP transport legacy bearer',
  …)` block plus a "grants read+extract" assertion covering this path.
- OAuth env already wired: `OAUTH_ISSUER`, `OAUTH_AUDIENCE=amb-mcp`, JWKS derived.

**edufeed-app** (SvelteKit, server-side JS) — directly calls `extract_metadata`:
- `src/lib/server/ambMcpClient.js` `callExtractMetadata({ mcpUrl, bearerToken, … })`
  sends `Authorization: Bearer <bearerToken>` on initialize + tool calls.
- `src/routes/api/enrich/+server.js:196` passes
  `bearerToken: env.AMB_MCP_BEARER_TOKEN`, `mcpUrl: env.AMB_MCP_URL`.
- `.env.example`: `AMB_MCP_URL`, commented `AMB_MCP_BEARER_TOKEN`.
- Deployed as **3 instances** (amb/ekw/konfi) via
  `homelab/playbooks/deploy_edufeed_app.yml` (env `AMB_MCP_BEARER_TOKEN=
  {{ vault_amb_mcp_bearer_token }}` at lines 258, 587, 1059).

**edufeed-chat-bot** (SvelteKit/TS, homelab role `nope-chatbot`) — a generic LLM
tool-caller; it exposes whatever tools the amb session advertises. It does **not**
invoke `extract_metadata` itself, but the operator wants the LLM to retain the
extract tool, so it must connect *with* an `mcp:extract` token:
- `mcp-servers.json` `amb` entry: `"url": "${AMB_MCP_URL}"`,
  `"bearerToken": "${AMB_MCP_BEARER_TOKEN}"`.
- `src/lib/llm/mcp/config.ts` substitutes `${VAR}` and copies `bearerToken` onto
  the resolved config.
- `src/lib/llm/mcp/registry.ts` `createTransport()` (lines 70-86) sets
  `headers.Authorization = 'Bearer ' + config.bearerToken` once, at connect time.
  `establish()` (async) calls `createTransport()`; `reconnect()` re-runs
  `establish()` on session drop.
- `src/lib/llm/mcp/types.ts`: `bearerToken?: string` on the http config types.
- `.env.example`: `AMB_MCP_URL`, `AMB_MCP_BEARER_TOKEN=`.
- Homelab `roles/nope-chatbot/templates/env.j2:20`:
  `AMB_MCP_BEARER_TOKEN={{ vault_amb_mcp_bearer_token }}`.

## Design

### Shared component — a cached client-credentials token provider

Each consumer gets a small, self-contained token provider (one per app, in that
app's language — not a shared package). Its responsibilities:

1. POST to the Keycloak token endpoint with
   `grant_type=client_credentials`, `client_id`, `client_secret`, and (optional)
   `scope`, `Content-Type: application/x-www-form-urlencoded`.
2. Parse `{ access_token, expires_in }`; cache the token in module memory with an
   absolute expiry = `now + expires_in − skew` (skew = 60s, so a token is
   refreshed slightly before Keycloak considers it expired).
3. `getToken()` returns the cached token when still valid, otherwise fetches a
   new one. Concurrent callers during a refresh share one in-flight fetch
   (single-flight) so a burst of requests does not stampede the token endpoint.
4. On a non-2xx token response, throw with the HTTP status and Keycloak's
   `error`/`error_description` body so misconfiguration is diagnosable.

Configuration (env, identical names across both apps):
- `AMB_MCP_TOKEN_URL` — Keycloak token endpoint.
- `AMB_MCP_CLIENT_ID` — `edufeed-app` or `nope-chatbot`.
- `AMB_MCP_CLIENT_SECRET` — from vault.
- `AMB_MCP_SCOPE` — optional; default omitted (the clients' default scopes
  already include `mcp:read mcp:extract`, so an explicit scope is not required).

### Why per-session token binding makes this safe

amb-mcp validates the JWT at the `initialize` request and binds the session's
tool profile to the token's scopes for the session lifetime; subsequent tool
calls on that session are authorized by the session id, not re-validated against
the JWT. Consequences:
- **edufeed-app** creates a fresh short-lived session per extraction
  (initialize → tool call → close), so it fetches/uses a token per call cycle —
  the cache makes this a single network fetch amortized across many calls.
- **edufeed-chat-bot** holds a long-lived session (registry singleton). It reads
  a token from the provider at connect/reconnect time. A token that later expires
  does not break an already-initialized session; when the session drops and
  `reconnect()` runs, the provider supplies a fresh token. So there is no need to
  rotate the Authorization header on a live connection.

### Per-repo changes

**edufeed-app**
- New `src/lib/server/ambMcpToken.js`: the token provider above; exports
  `getAmbMcpToken()` reading the `AMB_MCP_*` env.
- `src/routes/api/enrich/+server.js`: replace
  `bearerToken: env.AMB_MCP_BEARER_TOKEN` with
  `bearerToken: await getAmbMcpToken()`. If the token fetch throws, surface the
  existing `ai_unavailable` error envelope (same path as an upstream failure).
- `.env.example`: replace the `AMB_MCP_BEARER_TOKEN` line with the four
  `AMB_MCP_*` client-credentials vars, documented.
- `callExtractMetadata` is unchanged — it already accepts a `bearerToken` string.
- Tests (Vitest): token fetch success + cache hit (no second network call);
  refresh after expiry; single-flight under concurrent callers; non-2xx throws
  with status. Mock `fetch`; do not hit live Keycloak.

**edufeed-chat-bot**
- New token provider module (mirrors edufeed-app's, in TS), e.g.
  `src/lib/llm/mcp/oauthToken.ts`.
- `types.ts`: add an optional `oauth` block to the http server config
  (`{ tokenUrl, clientId, clientSecret, scope? }`) alongside `bearerToken`, and
  to the resolved http config type.
- `config.ts` `resolveServerConfig`: when an `oauth` block is present, substitute
  its `${VAR}` fields onto the resolved config (do not pre-fetch a token at load
  time — tokens are fetched lazily at connect time).
- `registry.ts` `createTransport`: make it `async`; when the resolved config has
  an `oauth` block, `await` a token from the provider and set the Authorization
  header from it; otherwise keep the static `bearerToken` behavior. `establish()`
  already `await`s `createTransport` indirectly — update the call site to await.
- `mcp-servers.json` `amb` entry: replace `"bearerToken": "${AMB_MCP_BEARER_TOKEN}"`
  with an `"oauth"` block referencing `${AMB_MCP_TOKEN_URL}`,
  `${AMB_MCP_CLIENT_ID}`, `${AMB_MCP_CLIENT_SECRET}`.
- `.env.example`: replace `AMB_MCP_BEARER_TOKEN` with the four `AMB_MCP_*` vars.
- Tests: provider unit tests (as above); a registry test that a server with an
  `oauth` block builds an Authorization header from a fetched token (mock the
  provider/fetch). The static-`bearerToken` path stays supported (nostrbook stays
  stdio; the mechanism remains for any future static-token server) and its
  existing tests stay green.

**amb-mcp** (executed LAST — see Sequencing)
- `src/http.ts`: remove the `LEGACY_BEARER_TOKEN` const (`:48`), drop it from the
  `startHttpServer` options (`:100`), and simplify the auth log line (`:57`) to
  drop the "+ legacy bearer" suffix.
- `src/transport/http.ts`: remove the `legacyBearerToken` option field, the
  compare branch, and the `timingSafeEqual` import if it becomes unused. The
  middleware keeps: no token → anonymous `['mcp:read']`; supplied token → JWT
  validation (bad → 401). PRM + `WWW-Authenticate` unchanged.
- `test/transport/http.test.ts`: delete the `describe('HTTP transport legacy
  bearer', …)` block and the legacy "grants read+extract" assertion. Keep the
  anonymous-read, garbage-token-401, valid-JWT, and extract-scoped-token tests.
- Update the file-header comment in `src/transport/http.ts` and the README's
  "Public deployment" section to drop mention of the legacy bearer.

**homelab** (config; secrets already in vault)
- `playbooks/deploy_edufeed_app.yml` (all 3 instances): replace the
  `AMB_MCP_BEARER_TOKEN=…` env line with `AMB_MCP_TOKEN_URL`,
  `AMB_MCP_CLIENT_ID=edufeed-app`,
  `AMB_MCP_CLIENT_SECRET={{ keycloak_client_secret_edufeed_app }}`.
- `roles/nope-chatbot/templates/env.j2`: same, with
  `AMB_MCP_CLIENT_ID=nope-chatbot` and
  `AMB_MCP_CLIENT_SECRET={{ keycloak_client_secret_nope_chatbot }}`.
- `roles/amb-mcp/templates/docker-compose.yml.j2`: remove the
  `LEGACY_BEARER_TOKEN={{ vault_amb_mcp_bearer_token }}` env line and its comment
  (this deploy happens last).
- `vault_amb_mcp_bearer_token` becomes unused after the migration; leaving the
  key in vault is harmless. Removing it is optional cleanup, not required.

### Structure

One spec (this document). Implementation is split into **one plan per repo**,
because each is a separate git repository with its own test suite and deploy
pipeline. The plans are coupled only by the deploy ordering below. Suggested
plans: `edufeed-app` migration, `edufeed-chat-bot` migration, `amb-mcp` legacy
removal, `homelab` config. The amb-mcp + homelab-legacy-removal work is gated on
the two consumer migrations being deployed and verified.

## Sequencing (zero-downtime, load-bearing)

amb-mcp accepts *both* legacy bearer and Keycloak JWTs today. This allows a safe,
reversible order:

1. Ship + deploy the **edufeed-app** and **edufeed-chat-bot** migrations. They
   now send client-credentials JWTs, which amb-mcp already accepts. The legacy
   token stays configured on amb-mcp as a safety net; nothing is removed yet.
2. **Verify** in production: edufeed-app `/api/enrich` performs a real extract
   over a JWT; the chat-bot's LLM lists and can call `extract_metadata` over its
   JWT. Confirm no consumer still relies on the static bearer.
3. **Only then** ship the amb-mcp legacy-removal + the homelab compose change
   that drops `LEGACY_BEARER_TOKEN`, and deploy amb-mcp last.

Rollback at any point before step 3 is trivial (the legacy token still works). If
step 2 reveals a problem, fix the consumer before touching amb-mcp.

## Security Considerations

- **Removes a shared, non-expiring secret.** After migration, each consumer holds
  its own client secret and presents short-lived, scoped, revocable JWTs.
- **Client secrets are handled like the existing bearer** — sourced from
  ansible-vault, injected as env, never logged or echoed. The token provider must
  not log the secret or the access token.
- **No scope escalation.** Both clients already default to `mcp:read mcp:extract`;
  no realm change. Write/sign tools remain excluded from the HTTP build.
- **Token endpoint reachability.** edufeed-app and chat-bot reach
  `auth.edufeed.org` (public) for the token grant; both already reach the public
  internet. No new network path inside the docker host is required.
- **Failure mode.** If Keycloak is unreachable, the token fetch fails and the
  consumer surfaces its existing "AI unavailable"/tool-unavailable path — the
  same user-visible outcome as an amb-mcp outage today. No silent fallback to an
  anonymous session for extract (that would just fail at the tool call anyway).

## Testing

Per repo, mock the network (no live Keycloak in unit tests):
- **Token provider (both apps):** success returns the token; a second immediate
  call hits cache (one network call); after simulated expiry a new token is
  fetched; concurrent callers share one in-flight fetch; non-2xx throws with the
  status and Keycloak error body.
- **edufeed-app:** `/api/enrich` uses the provider (integration-style: mock the
  provider + the MCP fetch, assert the Authorization header carries the fetched
  token); token-fetch failure yields the `ai_unavailable` envelope.
- **edufeed-chat-bot:** `resolveServerConfig` maps an `oauth` block; a transport
  built for an `oauth`-configured server carries `Authorization: Bearer <fetched>`
  (mock the provider). Static-`bearerToken` path unchanged.
- **amb-mcp:** after legacy removal, the suite still passes with the legacy tests
  deleted; anonymous read, garbage-token 401, valid JWT, and extract-scoped
  session tests remain green; `npm run build` (tsc) clean.

## Out of Scope

- Any Keycloak realm change (clients + secrets already exist).
- Rotating or removing `vault_amb_mcp_bearer_token` from vault (optional cleanup).
- Rate limiting / abuse controls (a separate future Traefik concern).
- Migrating any other (non-first-party) consumer — there are none using the
  legacy token besides these two.
- Refreshing the Authorization header on an already-live chat-bot session (unnecessary
  given per-session token binding at amb-mcp).
