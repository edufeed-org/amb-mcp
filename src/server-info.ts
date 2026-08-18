export const SERVER_NAME = 'amb-relay';
export const SERVER_VERSION = '0.2.0';

export const SERVER_INSTRUCTIONS = `This server is the gateway to the AMB educational-metadata relays — a Nostr-based store of learning resources, long-form articles, wiki pages, scientific publications, and calendar events. Use these tools to answer questions about educational content, its authors, and upcoming events; they abstract the Nostr layer, so query them rather than reading the relays directly. Identifiers like naddr, npub, and pubkey are NIP-19/Nostr values these tools return — pass them back as-is rather than constructing them yourself.

Two flows cover most questions:
- By name ("materials or events by Jörg Lohrer"): call resolve_author(name) to turn a person or organisation name into pubkey candidates, then pass the chosen pubkey to search_content (and/or search_calendar_events) as authors:[pubkey].
- By topic ("materials on peace education"): call search_content, then hand a result's naddr to get_resource for full metadata.

Authorship has two distinct layers — never conflate them: eventAuthor is the Nostr signer/uploader (often an aggregator), while creator/publisher (on resources) are who actually made and published the material. "Who published this?" is answered by publisher, never by eventAuthor.

Searches run against the default relay set. list_relays may advertise extraRelays — additional relays holding different corpora (e.g. a broader aggregation) that are only queried when you pass them via the relays parameter of search_content, search_resources, or get_resource. When a search on the defaults comes up short, or the user asks for a specific relay's holdings, check list_relays and re-search with relays set; fetch follow-up details with the same relays value the search used.

The server also browses controlled vocabularies (browse_*, skos_* tools) and, for authenticated clients, signs and publishes new metadata (signer_*, create_and_publish_*).`;
