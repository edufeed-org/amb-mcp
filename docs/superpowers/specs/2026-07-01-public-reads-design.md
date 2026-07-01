# Public Reads for amb-mcp — Design

**Date:** 2026-07-01
**Status:** Approved (design), pending implementation plan
**Scope:** Sub-project A of the access-model work. Plan C (client-credentials
migration of edufeed-app + nope-chatbot, then `LEGACY_BEARER_TOKEN` removal) is
a separate spec and is explicitly out of scope here.

## Goal

Let any MCP client — and plain HTTP callers — use amb-mcp's **read** tools
without authentication, while keeping the budget-spending `extract_metadata`
tool gated behind a valid `mcp:extract` token.

## Motivation

amb-mcp exists to make already-public educational Nostr content
(kinds 30142/30023/30818/30143/30144/30145 + calendar events) easy to search
and retrieve. Today every `/mcp` request is hard-blocked: no token → 401. That
forces every third party — human or machine — to obtain a Keycloak credential
before they can run a search, even though the underlying data is already
publicly queryable over Nostr on a public relay.

The product decision is: **reads should be public.** The MCP facade exposes no
data that the relay doesn't already expose anonymously, so requiring auth for
reads adds friction without adding a security boundary. Only `extract_metadata`
— which calls the Anthropic API and spends budget — needs a real gate.

## Current State (facts)

- **`src/transport/http.ts` `authMiddleware`** (lines ~114-140): when
  `opts.auth` is configured, a request with no valid token receives
  `401 Unauthorized` with a `WWW-Authenticate` challenge. A `LEGACY_BEARER_TOKEN`
  (constant-time compared) grants `['mcp:read', 'mcp:extract']`.
- **Tool profile is derived from scopes at session init**
  (`src/http.ts` `scopesToProfile`, lines 24-30):
  `read = scopes.includes('mcp:read')`, `extract = scopes.includes('mcp:extract')`,
  `write` hard-set to `false`. The profile is fixed for the session's lifetime
  (`http.ts:163-164`).
- **PRM** (RFC 9728 Protected Resource Metadata) is served unauthenticated at
  `/.well-known/oauth-protected-resource` (`http.ts:99-106`).
- **`src/transport/auth.ts`**: `createJwtVerifier` validates RS256 JWTs against
  the Keycloak JWKS, pinning issuer + audience; any failure throws
  `AuthError(401, ...)`.
- **Realm** (`homelab/roles/keycloak/templates/edufeed-realm.json.j2`):
  `edufeed-app` + `nope-chatbot` (client-credentials, default scopes
  `mcp:read` + `mcp:extract`); `claude-ai` (public auth-code+PKCE, read-only);
  one login user `steffen`. `registrationAllowed: false`; anonymous DCR blocked.

## Design

### Behavior change — `authMiddleware` becomes non-blocking for reads

The change is localized to `authMiddleware` in `src/transport/http.ts`. No
change to `auth.ts`, `prm.ts`, `session.ts`, or `scopesToProfile`.

| Incoming request | Today | New |
| --- | --- | --- |
| No `Authorization` header (or empty bearer) | 401 | **200**, session scopes `['mcp:read']` |
| Valid JWT with `mcp:extract` | 200, read+extract | unchanged |
| Valid JWT with `mcp:read` only | 200, read | unchanged |
| `LEGACY_BEARER_TOKEN` match | 200, read+extract | unchanged (transitional) |
| Non-empty token that fails all validation | 401 | **401** (unchanged) |

Rule of thumb: **absence of a token is anonymous read; presence of a bad token
is an error.** A client that bothers to send a credential still gets it
validated — we never silently downgrade a supplied token to anonymous.

### Why this needs no new gate

`extract_metadata` is only added to a session when its profile has
`extract: true`, which requires `mcp:extract` in the session's scopes. An
anonymous session is seeded with `['mcp:read']`, so `scopesToProfile` yields
`{ read: true, extract: false, write: false }` and `extract_metadata` is simply
absent from `tools/list`. There is no per-tool authorization check to add — the
existing session-init scope gating already does the work. To use extract, a
client must connect *with* a valid `mcp:extract` token.

### PRM and claude.ai

The PRM document keeps being served, and the `WWW-Authenticate` challenge value
is retained for the 401 (invalid-token) path. This preserves OAuth discovery for
clients that choose to authenticate.

**claude.ai must keep its OAuth path.** Verified against Anthropic's own tracker:
claude.ai's custom-connector UI cannot connect to a no-auth MCP server — it
forces OAuth registration even against servers exposing no OAuth metadata
(anthropics/claude-ai-mcp #402, #457, open as of 2026). So the `claude-ai`
client + `steffen` login user stay in the realm; claude.ai continues to obtain
an `mcp:read` token and works exactly as before. Every *other* MCP client
(Claude Code/Desktop, API mcp-connector, MCP Inspector, curl) can now connect
anonymously. No homelab/realm change is required for this sub-project.

### Non-breaking for internal apps

edufeed-app and nope-chatbot keep using `LEGACY_BEARER_TOKEN` (read+extract)
unchanged. Public reads only *adds* an anonymous path; it removes nothing they
rely on. Their migration to client-credentials and the eventual removal of
`LEGACY_BEARER_TOKEN` is Plan C (separate spec).

## Security Considerations

- **No new data exposure.** Read tools query the same public relay that any
  Nostr client can already query anonymously.
- **Write/sign tools remain excluded from the HTTP build** (`write: false`
  hard-set); unchanged.
- **extract_metadata stays gated** behind `mcp:extract`; unchanged.
- **DNS-rebinding protection** (`allowedHosts` / `allowedOrigins`) still applies
  to every session, anonymous or not; unchanged.
- **Token validation is not weakened** — a supplied token is still fully
  validated (issuer/audience/RS256/JWKS); only *absence* of a token is newly
  permitted.
- **Abuse / rate limiting: deferred (YAGNI).** The relay is already publicly
  reachable, so public MCP reads do not widen the attack surface for data
  exfiltration. If read volume becomes a load problem, add a Traefik-level rate
  limit on `mcp.amb.edufeed.org` — noted as future work, not built now.

## Testing

Unit tests in `src/transport/` (extending the existing http/auth test suites):

1. **Anonymous read session** — POST initialize with no `Authorization` header
   → 200; the session's `tools/list` contains read tools and **omits**
   `extract_metadata`.
2. **Anonymous extract is unreachable** — calling `extract_metadata` on an
   anonymous session returns MCP method-not-found (tool absent), not a budget
   spend.
3. **Invalid token still 401** — a non-empty, malformed/expired bearer →
   401 with `WWW-Authenticate`.
4. **Valid extract token** — a token carrying `mcp:extract` → session exposes
   `extract_metadata` (existing behavior, regression guard).
5. **Legacy bearer** — `LEGACY_BEARER_TOKEN` still grants read+extract
   (regression guard for the transitional path).

## Out of Scope

- Plan C: client-credentials migration of edufeed-app + nope-chatbot and removal
  of `LEGACY_BEARER_TOKEN` (separate spec).
- Rate limiting / abuse controls (future Traefik concern).
- Any realm, homelab, or claude.ai configuration change.
