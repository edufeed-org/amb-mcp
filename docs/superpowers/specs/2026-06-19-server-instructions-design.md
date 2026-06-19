# Server-Level MCP Instructions — Design

**Date:** 2026-06-19
**Status:** Approved (design)

## Problem

amb-mcp constructs its `McpServer` at three entrypoints (`stdio.ts`, `http.ts`,
`index.ts`) passing only `{ name, version }`. The SDK's optional
`instructions` field — returned in the `initialize` response and surfaced to
the model by every MCP client — is never set. So the only cross-model guidance
lives in individual tool descriptions; there is no holistic "how to use this
server" orientation. A connecting LLM has no up-front map of the discovery
flows or the authorship distinction that previously caused wrong answers
(conflating the Nostr event signer with the resource's publisher).

This is the durable, cross-model fix: tool descriptions and a personal memory
note reach only some consumers; the server `instructions` blob reaches every
client/model that connects.

## Goals

- Set a discovery-focused server-level `instructions` string at all server
  construction sites, consistently.
- Orient the model on: what the server is, the two main discovery flows, the
  `eventAuthor` vs `creator`/`publisher` distinction, and a light Nostr/abstraction note.
- Keep the three entrypoints DRY via one shared source of server identity.

## Non-goals

- No change to individual tool descriptions (already updated in the prior feature).
- No exhaustive tool-by-tool tour in the instructions (discovery-focused; other
  capability groups get one-line mentions only).
- No new runtime behavior, no relay change.

## Design

### Shared server-info module

Create `src/server-info.ts` exporting:

```ts
export const SERVER_NAME = 'amb-relay';
export const SERVER_VERSION = '0.1.0';
export const SERVER_INSTRUCTIONS = `<the text below>`;
```

`src/http.ts` currently declares local `SERVER_NAME`/`SERVER_VERSION` consts —
replace those with imports from the shared module so all three entrypoints
agree.

### Instructions text (verbatim, approved)

> This server is the gateway to the AMB educational-metadata relays — a
> Nostr-based store of learning resources, long-form articles, wiki pages, and
> calendar events. Use these tools to answer questions about educational
> content, its authors, and upcoming events; they abstract the Nostr layer, so
> query them rather than reading the relays directly. Identifiers like `naddr`,
> `npub`, and `pubkey` are NIP-19/Nostr values these tools return — pass them
> back as-is rather than constructing them yourself.
>
> Two flows cover most questions:
> - By name ("materials or events by Jörg Lohrer"): call `resolve_author(name)`
>   to turn a person or organisation name into pubkey candidates, then pass the
>   chosen pubkey to `search_content` (and/or `search_calendar_events`) as
>   `authors:[pubkey]`.
> - By topic ("materials on peace education"): call `search_content`, then hand
>   a result's `naddr` to `get_resource` for full metadata.
>
> Authorship has two distinct layers — never conflate them: `eventAuthor` is
> the Nostr signer/uploader (often an aggregator), while `creator`/`publisher`
> (on resources) are who actually made and published the material. "Who
> published this?" is answered by `publisher`, never by `eventAuthor`.
>
> The server also browses controlled vocabularies (`browse_*`, `skos_*` tools)
> and, for authenticated clients, signs and publishes new metadata
> (`signer_*`, `create_and_publish_*`).

### Wiring

At each of the three `new McpServer(...)` sites, pass the shared info and
`instructions` via the second `ServerOptions` argument:

```ts
const server = new McpServer(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { instructions: SERVER_INSTRUCTIONS },
);
```

`transport/http.ts:114` only invokes the `buildMcpServer` closure passed from
`http.ts`, so it needs no change.

## Files

- Create: `src/server-info.ts`
- Modify: `src/stdio.ts` (import + constructor), `src/index.ts` (import +
  constructor), `src/http.ts` (drop local consts → import; constructor).

## Risk / compatibility

Additive — the `instructions` field is optional and ignored by clients that
don't surface it. No output-shape or behavior change. `tsc` and the existing
suite must stay green.
