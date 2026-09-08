# Curated Edufeed Spells

This directory holds curated kind-777 grimoire spell templates for the edufeed educational metadata network.

## What These Are

Spells are Nostr kind-777 REQ/COUNT templates saved as signed events. They define named, reusable query scopes for:
- **Clients & tools:** invoke a spell to search a specific subset (e.g., "all AMB educational resources")
- **RAG systems:** use a spell as the query scope for grounding LLM responses on curated data (e.g., "search publications for this prompt")

The spells here are pre-defined scopes over the edufeed relay's content types — educational materials (kind 30142), scientific publications (kind 30040), and calendar events (kind 31923).

## Publishing Spells

**Real key:** stored in the homelab vault as `vault_edufeed_spells_nsec`.

**To publish:**

```bash
EDUFEED_SPELLS_NSEC=$(cat /path/to/key) node spells/publish.mjs [--dry-run]
```

The script reads all `.json` files in this directory, signs each as a kind-777 or kind-0 event, and publishes to the relays listed in `SPELL_RELAYS` (default: `wss://relay.edufeed.org`).

**Dry-run mode** (`--dry-run`): logs each event ID without publishing — safe to run for testing.

## Immutability & Revisions

Spells are **immutable**: they carry no `d` tag, so re-running `publish.mjs` creates NEW events, not replacements.

To revise a spell:
1. Edit the template `.json` file
2. Add an `["e", <old-spell-id>]` fork tag to the template to link the old version
3. Publish the revised template with `publish.mjs` — it gets a new event ID
4. Clients may fetch both versions; the fork tag signals they are related

Example:

```json
{
  "kind": 777,
  "tags": [
    ["cmd", "REQ"],
    ...
    ["e", "abc123def456...", "", "fork"]
  ]
}
```

## Published events (2026-09-08)

Signed by the dedicated edufeed-spells key
`npub15mdyxe583fy4tvjcnrmmt424rrrxgzz8xm2nstuxtvcpqe0xga2s5sccrg`
(pubkey `a6da4366878a4955b25898f7b5d55518c664084736d5382f865b301065e64755`,
nsec in the homelab vault as `vault_edufeed_spells_nsec`), on
`wss://relay.edufeed.org`:

| Template | Kind | Event id |
|---|---|---|
| `edufeed-amb.json` | 777 | `4ff18aa905af38a7dfe6554b43807bed3e8ef332041a9c7c64dbb0dbe086044d` |
| `publications.json` | 777 | `66c28eac15e3b194d182ccaf5d061bae3bb120e66d23f015e53f7d9b9d567f5b` |
| `calendar-events.json` | 777 | `d7fb79130cf35ecfb9a23fde808f5fdd4c1f96811da397c979cbf2bc826fa5a1` |
| `profile.json` | 0 | `4b88840a454e051c48d14fe199c79a4ddfff662fe33d934e5bbe144e8cdca7ea` |
