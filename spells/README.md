# Curated Edufeed Spells

This directory holds curated kind-777 grimoire spell templates for the edufeed educational metadata network.

## What These Are

Spells are Nostr kind-777 REQ/COUNT templates saved as signed events. They define named, reusable query scopes for:
- **Clients & tools:** invoke a spell to search a specific subset (e.g., "all AMB educational resources")
- **RAG systems:** use a spell as the query scope for grounding LLM responses on curated data (e.g., "search publications for this prompt")

The spells here are pre-defined scopes over the edufeed relay's content types — educational materials (kind 30142), scientific publications (kind 30040), and upcoming events (kind 31923).

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
