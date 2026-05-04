# AMB Relay MCP Server

An MCP (Model Context Protocol) server for querying educational resources from AMB (Allgemeines Metadatenprofil für Bildungsressourcen) Nostr relays.

## Features

### Query & Browse
- Full-text search with NIP-50
- Filter by publisher, creator, subject, resource type, educational level
- Browse available subjects, resource types, and educational levels
- Get individual resources by identifier
- Relay statistics and info

### URL → Form-Prefill Metadata
- `extract_metadata(url, variant, skosSchemes?)` — fetch a public web page and produce a complete AMB/EKW form-prefill payload. Returns OpenGraph fallback by default; with `ANTHROPIC_API_KEY` set, an LLM grounded in the configured SKOS vocabularies fills SKOS-typed fields with concept IDs and per-field evidence quotes.
- Library export: `import { extractMetadata } from 'amb-mcp/lib'` for direct in-process use (e.g. SvelteKit server routes).

### Signing & Publishing
- NIP-46 remote signing (bunker) with QR code connection flow
- Sign and publish arbitrary Nostr events
- Create and publish kind 0 (profile/metadata) events
- Create and publish kind 30142 (AMB educational resource) events
- NIP-42 relay authentication support
- Multi-user session isolation

## Installation

```bash
bun install
```

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

### Environment variables

| Name | Used by | Default | Description |
|------|---------|---------|-------------|
| `AMB_RELAYS` | both transports | `wss://relay.edufeed.org` | Comma-separated AMB relay URLs queried by `search_resources`/`get_resource` and used as default publish targets. |
| `AMB_AUTHOR_SETS` | both transports | _(empty)_ | Comma-separated `naddr` follow-set identifiers used to scope queries by author. |
| `CALENDAR_RELAYS` | both transports | `wss://dev.calendar-relay.edufeed.org` | Comma-separated NIP-52 calendar relay URLs. |
| `CALENDAR_AUTHOR_SETS` | both transports | _(empty)_ | Comma-separated `naddr` follow-set identifiers for calendar event queries. |
| `SERVER_PRIVATE_KEY` | `src/index.ts` only | **required** | Nostr private key (`nsec` or hex) the server uses for its own ContextVM identity. The pubkey derived from this is what clients connect to via `cvmi use <pubkey>`. Not needed for stdio transport. |
| `RELAYS` | `src/index.ts` only | `wss://relay.contextvm.org`, `wss://cvm.otherstuff.ai` | Comma-separated relay URLs for ContextVM transport announcements and request/response traffic. Not needed for stdio transport. |
| `ANTHROPIC_API_KEY` | `extract_metadata` | _(unset)_ | Enables LLM-grounded SKOS field extraction. When unset the tool degrades to OpenGraph/JSON-LD only. |
| `ANTHROPIC_MODEL` | `extract_metadata` | `claude-sonnet-4-6` | Override the default Anthropic model. |
| `SKOS_SCHEMES` | `extract_metadata` | _(unset)_ | JSON map `{ "<form-field>": "<scheme-uri>" }` of default vocabularies used when the caller does not pass `skosSchemes` explicitly. |

## Usage

### Option 1: Add to Claude Code (Recommended)

```bash
claude mcp add amb-relay -e AMB_RELAYS=ws://localhost:3334 -- bun run /path/to/amb-mcp/src/stdio.ts
```

### Option 2: Run with cvmi (ContextVM)

Start the server:
```bash
cvmi serve -- bun run src/stdio.ts
```

Connect from another machine:
```bash
cvmi use <server-pubkey>
```

### Option 3: Run standalone with Nostr transport

```bash
bun run src/index.ts
```

## Available Tools

### search_resources

Search for educational resources using full-text search and metadata filters.

Parameters:
| Name | Type | Description |
|------|------|-------------|
| `query` | string | Free-text search query |
| `publisherName` | string | Filter by publisher name |
| `creatorName` | string | Filter by creator/author name |
| `subjectLabel` | string | Filter by subject label (e.g., "Mathematik") |
| `resourceTypeLabel` | string | Filter by resource type (e.g., "Video", "Kurs") |
| `educationalLevelLabel` | string | Filter by educational level |
| `language` | string | Language for labels (default: "de") |
| `limit` | number | Max results, 1-250 (default: 20) |

### get_resource

Retrieve a single resource by identifier.

Parameters:
| Name | Type | Description |
|------|------|-------------|
| `identifier` | string | Resource d-tag (URL identifier) |
| `author` | string | Author pubkey for disambiguation |
| `eventId` | string | Direct Nostr event ID lookup |

### browse_subjects

List available subjects/topics with resource counts.

### browse_resource_types

List available learning resource types (Video, Course, Worksheet, etc.).

### browse_educational_levels

List available educational levels (Primary, Secondary, Higher Education, etc.).

### relay_stats

Get relay information including name, description, and supported NIPs.

---

## Signing and Publishing

The MCP server supports signing and publishing Nostr events via NIP-46 remote signing (bunker).

### Connecting a Signer

#### Option 1: QR Code Flow (Recommended)

1. Call `signer_init` to generate a nostrconnect:// URL and QR code
2. Scan the QR code with your bunker app (Amber, nsecBunker, etc.)
3. Call `signer_await` to wait for the connection to complete

#### Option 2: Bunker URL

If you have a bunker:// URL from your signer app, use `signer_connect` directly.

#### Option 3: Private Key (Development Only)

For testing, use `signer_connect` with an nsec and `allowInsecure=true`. **Never use this in production.**

### Signer Tools

### signer_init

Generate a QR code for connecting a signer app.

Parameters:
| Name | Type | Description |
|------|------|-------------|
| `relays` | string[] | Relays for NIP-46 communication (defaults to AMB relays) |
| `name` | string | Client name shown in the bunker app |
| `permissions` | string[] | Requested permissions (e.g., `["sign_event:0", "sign_event:30142"]`) |

Returns:
- `sessionId` - Session ID for `signer_await`
- `nostrconnectUrl` - The nostrconnect:// URL
- `qrCode` - ASCII QR code for terminal display

### signer_await

Wait for a bunker app to connect after scanning the QR code.

Parameters:
| Name | Type | Description |
|------|------|-------------|
| `sessionId` | string | Session ID from `signer_init` |
| `timeout` | number | Timeout in seconds (default: 120) |

### signer_connect

Connect directly using a bunker URL or private key.

Parameters:
| Name | Type | Description |
|------|------|-------------|
| `bunkerUrl` | string | bunker:// URL from your signer app |
| `nsec` | string | Private key (nsec or hex) - **development only** |
| `allowInsecure` | boolean | Required when using nsec |

### signer_disconnect

Disconnect the current signer session.

### signer_status

Check the current signer connection status.

Returns:
- `connected` - Whether a signer is connected
- `userPubkey` - The connected user's public key
- `connectedAt` - ISO timestamp of connection time

---

## Publishing Tools

### sign_event

Sign an unsigned Nostr event using the connected signer.

Parameters:
| Name | Type | Description |
|------|------|-------------|
| `kind` | number | Event kind (e.g., 0 for metadata, 1 for note) |
| `content` | string | Event content |
| `tags` | string[][] | Event tags as array of arrays |

### publish_event

Publish a pre-signed Nostr event to relays.

Parameters:
| Name | Type | Description |
|------|------|-------------|
| `event` | object | Signed Nostr event with id, pubkey, created_at, kind, tags, content, sig |
| `relays` | string[] | Relays to publish to (defaults to AMB relays) |
| `useOutbox` | boolean | Use NIP-65 outbox model for relay selection (default: true) |

### create_and_publish_metadata

Build, sign, and publish a kind 0 profile metadata event.

Parameters:
| Name | Type | Description |
|------|------|-------------|
| `name` | string | Display name |
| `about` | string | Bio/description |
| `picture` | string | Avatar URL |
| `banner` | string | Banner image URL |
| `nip05` | string | NIP-05 identifier (e.g., user@domain.com) |
| `lud16` | string | Lightning address |
| `website` | string | Website URL |
| `relays` | string[] | Relays to publish to |
| `useOutbox` | boolean | Use NIP-65 outbox model for relay selection (default: true) |

### create_and_publish_resource

Build, sign, and publish a kind 30142 AMB educational resource event.

Parameters:
| Name | Type | Description |
|------|------|-------------|
| `identifier` | string | Unique identifier (d-tag) for the resource |
| `name` | string | Resource name/title |
| `description` | string | Resource description |
| `url` | string | Resource URL |
| `image` | string | Image/thumbnail URL |
| `type` | string[] | Resource types (e.g., `["LearningResource", "VideoObject"]`) |
| `inLanguage` | string[] | Language codes (e.g., `["de", "en"]`) |
| `about` | object[] | Subject concepts with `id` and optional `prefLabel` |
| `learningResourceType` | object[] | Learning resource types from HCRT vocabulary |
| `educationalLevel` | object[] | Educational level concepts |
| `creator` | object[] | Content creators with `name`, `type`, `id` |
| `publisher` | object[] | Publishers with `name`, `type`, `id` |
| `license` | object | License with `id` (URL) and optional `name` |
| `isAccessibleForFree` | boolean | Whether the resource is free to access |
| `datePublished` | string | Publication date (ISO 8601) |
| `relays` | string[] | Relays to publish to |
| `useOutbox` | boolean | Use NIP-65 outbox model for relay selection (default: true) |

---

## NIP-65 Outbox Model

Publishing tools use the NIP-65 outbox model by default for intelligent relay selection:

1. **Author's write relays** - Fetched from kind 10002 events
2. **Tagged users' read relays** - For p-tagged mentions, fetches their read relays
3. **Default relays** - Falls back to configured AMB relays

This ensures events are delivered to relays where both the author publishes and where tagged users expect to receive events.

### relay_list_get

Fetch a user's NIP-65 relay list (kind 10002).

Parameters:
| Name | Type | Description |
|------|------|-------------|
| `pubkey` | string | Public key to fetch relay list for (defaults to connected signer) |

Returns:
- `pubkey` - The queried public key
- `readRelays` - Array of relay URLs marked as read
- `writeRelays` - Array of relay URLs marked as write
- `totalRead` - Count of read relays
- `totalWrite` - Count of write relays

---

## Available Resources

| URI | Description |
|-----|-------------|
| `amb://schema` | AMB JSON-LD schema |
| `amb://vocabularies/subjects` | Subject vocabulary |
| `amb://vocabularies/resource-types` | Learning resource types vocabulary |
| `amb://vocabularies/educational-levels` | Educational levels vocabulary |
| `amb://relay-info` | NIP-11 relay information |

## Deployment

The server runs over Nostr transport (`src/index.ts`) — there is no HTTP listener and no port to expose. Clients reach it by addressing its pubkey on the configured ContextVM `RELAYS`.

### Prerequisites on the host

- Node ≥ 20 (or Bun ≥ 1.1) for runtime.
- Outbound WebSocket access to the configured AMB and ContextVM relays.
- Outbound HTTPS for the `extract_metadata` tool (target pages and, optionally, the Anthropic API).
- A sibling checkout of [`amb-nostr-converter`](../amb-nostr-converter) at `../amb-nostr-converter`. `package.json` references it via `file:../amb-nostr-converter`, so `bun install` / `npm install` will fail without it. If you do not have a sibling layout, vendor it into the repo or replace the dep with a published version before deploying.

### Build & run

```bash
bun install              # or: npm install
bun run build            # tsc -> dist/
node dist/index.js       # production entry; uses Nostr transport
```

For development without a build step: `bun run src/index.ts`.

### Identity & secrets

- `SERVER_PRIVATE_KEY` is the server's persistent Nostr identity. **Losing or rotating it changes the pubkey clients use to address the server**, so treat it as long-lived state. Mint one with `nak key generate` (or any Nostr keygen) and store it via your secret manager — never commit it.
- The matching pubkey is what users pass to `cvmi use <pubkey>`. Print it once after first start so operators can record it.
- `ANTHROPIC_API_KEY`, if used, should be scoped to this service; the `extract_metadata` tool will spend tokens on every call where SKOS grounding is requested.

### State & persistence

The server itself is stateless on disk — all state lives on the configured relays. The only thing that needs to persist across restarts is the env file containing `SERVER_PRIVATE_KEY`. No volume is required for the MCP container.

### Discovery

On startup with Nostr transport, the server publishes a ContextVM announcement to `RELAYS`. To remove an old announcement (e.g. after rotating the key or decommissioning), use `scripts/unpublish-server.ts`.

### Operational notes

- **Logging:** plain stdout/stderr. Capture via your process supervisor (systemd journal, Docker logs, etc.).
- **Healthcheck:** there is no HTTP healthcheck. Liveness ≈ "process is up and the relay subscription has not errored"; integrate at the supervisor level.
- **`extract_metadata` egress:** the tool fetches arbitrary URLs supplied by callers. Fetching is SSRF-aware (private/loopback ranges blocked) but you should still consider running it behind an egress proxy if your homelab restricts outbound traffic.
- **Resource footprint:** small — a single Node process with a handful of WebSocket connections. No database, no cache directory.

## Development

### Run tests

```bash
bun test
```

### Test against local relay

Start the AMB relay:
```bash
cd /path/to/amb-relay
docker compose up -d
```

Run the test client:
```bash
AMB_RELAY_URL=ws://localhost:3334 bun run test-client.ts
```

## Scripts

- `scripts/unpublish-server.ts` - Remove server from public ContextVM discovery
- `scripts/delete-announcements.ts` - Attempt to delete announcement events

## Architecture

```
src/
├── index.ts          # Nostr transport entry point
├── stdio.ts          # Stdio transport entry point (for cvmi/Claude Code)
├── relay/
│   ├── client.ts     # AMB relay client (SimplePool wrapper)
│   └── filters.ts    # NIP-50 search string builder
├── signer/
│   ├── manager.ts    # SignerManager for NIP-46 session management
│   ├── publish.ts    # PublishService for relay publishing
│   ├── relay-list.ts # NIP-65 relay list service (outbox model)
│   ├── event-builder.ts # Event builders (metadata, AMB resources)
│   └── index.ts      # Module exports
├── tools/
│   ├── search.ts     # search_resources tool
│   ├── get.ts        # get_resource tool
│   ├── browse.ts     # browse_* tools
│   ├── stats.ts      # relay_stats tool
│   ├── signer.ts     # signer_* tools (init, connect, status, disconnect)
│   └── publish.ts    # sign_event, publish_event, create_and_publish_* tools
├── resources/
│   ├── schema.ts     # amb://schema resource
│   ├── vocabularies.ts # amb://vocabularies/* resources
│   └── relay-info.ts # amb://relay-info resource
├── types/
│   ├── amb.ts        # AMB TypeScript types
│   └── qrcode-terminal.d.ts # Type declarations for qrcode-terminal
└── utils/
    └── transform.ts  # Nostr event to AMB resource transformer
```

## License

This is free and unencumbered software released into the public domain. See [UNLICENSE](UNLICENSE) for details.
