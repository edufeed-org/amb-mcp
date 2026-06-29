# amb-mcp OAuth Resource Server + Keycloak Authorization Server

**Date:** 2026-06-29
**Status:** Design — awaiting review

## Problem

amb-mcp must be reachable by two fundamentally different kinds of consumers:

1. **Interactive clients** (claude.ai's custom connector, other MCP-enabled apps used by humans) that authenticate through a browser.
2. **Non-interactive machine-to-machine consumers** — our own services (edufeed-app, nope-chatbot) and *third-party* services/agents — that have no browser and no human to grant consent.

Today amb-mcp is exposed at `https://mcp.amb.edufeed.org/mcp` with a single static bearer token (`src/transport/http.ts:78`). To make it a claude.ai connector we previously considered fronting it with the interactive-only `sigbit/mcp-auth-proxy` (as done for mem-mcp). That proxy cannot serve non-interactive consumers at all, and third parties (both humans via apps and machines) now want access. A static bearer is also unsuitable for third parties we don't control.

The accepted industry pattern (MCP spec 2025-11-25; OAuth 2.1 + RFC 9728) is a single OAuth Authorization Server issuing tokens via two grant types — Authorization Code + PKCE for humans, Client Credentials for machines — with the MCP server acting as an OAuth **resource server** that validates those tokens uniformly. This spec adopts that pattern.

## Goals

- amb-mcp becomes a standards-compliant OAuth 2.1 resource server: serves RFC 9728 Protected Resource Metadata (PRM), validates Keycloak-issued JWTs, enforces scopes.
- Stand up Keycloak as a general-purpose homelab Authorization Server (reusable by future services).
- Support both human (auth-code+PKCE) and machine (client-credentials) consumers, first-party and third-party.
- Protect the budget-spending `extract_metadata` tool behind a distinct scope.
- Migrate first-party consumers (edufeed-app, nope-chatbot) to OAuth and remove the static bearer entirely.
- Retire the sigbit `mcp-auth-proxy` for amb-mcp.

## Non-goals

- Migrating mem-mcp to Keycloak (can follow later; out of scope here).
- Open/self-service human registration (admin-controlled accounts to start).
- Per-tool scopes beyond the read/extract split.
- Nostr-native login federation (possible future Keycloak flow; not now).
- Making Keycloak the SSO for unrelated homelab services in this iteration (the deployment is designed to allow it later, but only amb-mcp is wired up now).

## Architecture

Because amb-mcp itself becomes the resource server, the sigbit proxy is removed and no second hostname is needed. `mcp.amb.edufeed.org` continues to point straight at amb-mcp.

```
                    ┌─────────────────────────────────────┐
                    │  Keycloak (NEW)  auth.edufeed.org     │
                    │  realm: edufeed                       │
                    │  • auth-code+PKCE (humans)            │
                    │  • client-credentials (machines)      │
                    │  • DCR enabled (claude.ai self-reg)   │
                    │  • issues JWTs w/ scopes + aud        │
                    └───────────┬───────────────▲──────────┘
          discover/login/token  │               │ JWKS (validate)
   ┌───────────────┬────────────┴──────┐        │
   │ claude.ai (auth-code+PKCE)         │        │
   │ 3rd-party human app (auth-code)    │        │
   │ 3rd-party machine (client-creds)   │        │
   │ edufeed-app, nope-chatbot (c-c)    │        │
   └───────────────┬───────────────────┘        │
                   │ Bearer JWT                  │
                   ▼                             │
        mcp.amb.edufeed.org ──► amb-mcp (resource server)
                                • GET /.well-known/oauth-protected-resource
                                • validate JWT via Keycloak JWKS
                                • enforce scope per tool
```

### Components

1. **Keycloak** — new homelab role (`roles/keycloak`, `playbooks/deploy_keycloak.yml`), postgres backend, Traefik router for `auth.edufeed.org`, new DNS A record. Realm `edufeed`. General-purpose so future services can reuse it.
2. **amb-mcp resource-server layer** — code changes in this repo (see below).

**Retired:** sigbit `mcp-auth-proxy` for amb-mcp.

## Scope & token model

### Scopes

| Scope | Tools | Cost |
|-------|-------|------|
| `mcp:read` | `search_content`, `search_calendar_events`, `get_resource`, `resolve_author` | cheap (relay / typesense) |
| `mcp:extract` | `extract_metadata` | spends Anthropic API budget |

`mcp:extract` does **not** imply `mcp:read`; a token carries whichever scopes it was granted. `tools/list` is filtered to the scopes the token holds, so a read-only client never sees `extract_metadata`.

### Token (Keycloak-issued JWT)

- `iss`: `https://auth.edufeed.org/realms/edufeed`
- `aud`: `amb-mcp` (resource indicator; tokens not audienced to amb-mcp are rejected, preventing cross-service token reuse)
- `scope`: space-delimited subset of `mcp:read mcp:extract`
- `sub`: user id (human) or service-account id (machine)
- standard `exp`, `iat`, `azp`

### Grant type per consumer

| Consumer | Grant | Default scopes |
|----------|-------|----------------|
| claude.ai | auth-code + PKCE (DCR self-registers) | `mcp:read mcp:extract` after consent |
| 3rd-party human (MCP app) | auth-code + PKCE | `mcp:read` (extract on request) |
| 3rd-party machine | client-credentials | `mcp:read` (extract on request) |
| edufeed-app | client-credentials | `mcp:read mcp:extract` |
| nope-chatbot | client-credentials | `mcp:read mcp:extract` |

### Lifetimes & validation

- Access token: **1 hour**. Refresh tokens for interactive clients only; machines re-run client-credentials.
- amb-mcp validates statelessly against Keycloak's JWKS (cached remote keyset via `jose`, `kid` rotation handled automatically) — no per-request introspection.
- Validation order per `/mcp` request: signature → `iss` match → `aud` includes `amb-mcp` → not expired → for `tools/call`, required tool scope ∈ token scopes. Failures → `401` (auth) or `403` (insufficient scope) with `WWW-Authenticate: Bearer resource_metadata="https://mcp.amb.edufeed.org/.well-known/oauth-protected-resource"`.

## amb-mcp code changes

Files: `src/transport/http.ts`, `src/http.ts`, new `src/transport/auth.ts`; `package.json` (+`jose`).

- **`src/transport/auth.ts` (new):** `createJwtVerifier({ issuer, audience, jwksUri })` → Express middleware validating the token and attaching `req.auth = { sub, scopes }`. Uses `jose` `createRemoteJWKSet` + `jwtVerify`.
- **PRM route:** `GET /.well-known/oauth-protected-resource` returns
  `{ resource: "https://mcp.amb.edufeed.org/mcp", authorization_servers: ["https://auth.edufeed.org/realms/edufeed"], scopes_supported: ["mcp:read","mcp:extract"], bearer_methods_supported: ["header"] }`.
  Served unauthenticated.
- **Replace static bearer:** remove the `bearerToken` middleware at `src/transport/http.ts:78` and the `HTTP_BEARER_TOKEN` plumbing in `src/http.ts`; mount the JWT verifier on `POST/GET/DELETE /mcp`.
- **Scope enforcement:** a tool→scope map `{ extract_metadata: 'mcp:extract', default: 'mcp:read' }`. On `tools/call`, parse the JSON-RPC body, resolve the required scope for `params.name`, and reject with `403` if absent. Filter `tools/list` results to allowed scopes.
- **Config (new env, replacing `HTTP_BEARER_TOKEN`):** `OAUTH_ISSUER`, `OAUTH_AUDIENCE`, `OAUTH_JWKS_URI` (derivable from issuer; explicit override allowed).

## Consumer migration (shared MCP-client change)

edufeed-app (`src/lib/server/ambMcpClient.js`, static bearer at line 29) and nope-chatbot's equivalent client each gain a small `getAccessToken()` helper: POST `grant_type=client_credentials` to Keycloak's token endpoint, cache the JWT in memory, refresh ~60s before `exp`. The `Authorization: Bearer` header then carries that token.

Per-service env (replacing `AMB_MCP_BEARER_TOKEN`): `OAUTH_TOKEN_URL`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`. `AMB_MCP_URL` becomes the internal `http://amb-mcp:3000/mcp` for on-host calls (both services are co-located with amb-mcp on the single `docker-host` over the `proxy` network).

Homelab files affected: `playbooks/deploy_edufeed_app.yml` (edufeed.org block ~line 257, dev block ~line 586), `roles/nope-chatbot/templates/env.j2` (~line 19). RPI and STIL-FINDER edufeed-app variants have no AMB_MCP usage — unchanged.

## Keycloak homelab role

- `roles/keycloak` + `playbooks/deploy_keycloak.yml`: Keycloak + postgres containers on the `proxy` network, Traefik router for `auth.edufeed.org`, new DNS A record in `dns/zones/edufeed.org.yaml`.
- Realm `edufeed` provisioned via realm-export JSON or `kcadm` bootstrap: client scopes `mcp:read`/`mcp:extract`; `amb-mcp` audience mapper; DCR enabled; the client-credentials clients (edufeed-app, nope-chatbot, plus a template for third parties); admin-controlled registration (no open signup).
- Secrets in `inventory/group_vars/all/vault.yml`: `vault_keycloak_admin_password`, postgres password, per-client secrets.

## Rollout ordering (zero-downtime)

1. Deploy Keycloak + realm.
2. Deploy amb-mcp accepting **both** JWT and the old static bearer (transient dual-accept).
3. Migrate edufeed-app + nope-chatbot to client-credentials; point them at the internal URL.
4. Flip amb-mcp to JWT-only; retire the sigbit proxy; amb-mcp keeps `mcp.amb.edufeed.org`.
5. Verify the claude.ai connector end-to-end.

The dual-accept in step 2 is a migration scaffold only; the end state is JWT-only (static bearer removed).

## Testing

- amb-mcp unit tests: verifier (valid / expired / wrong-aud / wrong-iss / missing-scope), PRM route shape, scope enforcement on `tools/call`, `tools/list` filtering.
- amb-mcp integration test: Keycloak in docker → real client-credentials token → `tools/call` happy path + `403` for missing `mcp:extract`.
- Manual: claude.ai connector smoke test (discovery → DCR → login → consent → tool call).

## Open questions / risks

- **claude.ai registration mechanism:** verify whether the current claude.ai connector uses DCR or CIMD against Keycloak, and that Keycloak's discovery metadata satisfies it. Validate during step 5; may need a Keycloak config tweak.
- **Audience mapping:** Keycloak must emit `aud: amb-mcp` for both grant types — requires an audience protocol mapper on the relevant client scope.
- **Keycloak resource footprint** on the single docker host (JVM + postgres); monitor memory.
