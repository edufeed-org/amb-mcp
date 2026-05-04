/**
 * Relay List Service (NIP-65)
 *
 * Fetches and caches relay lists (kind 10002) for the outbox model.
 * Used to determine which relays to publish to based on:
 * - Author's write relays
 * - Tagged users' read relays
 */

import { RelayPool } from 'applesauce-relay';
import type { NostrEvent, Filter } from 'nostr-tools';

export interface RelayList {
  readRelays: string[];
  writeRelays: string[];
}

interface CachedRelayList {
  list: RelayList;
  fetchedAt: number;
}

/**
 * Parse a relay list event (kind 10002) into structured format
 * Per NIP-65:
 * - No marker = both read and write
 * - "read" marker = read only
 * - "write" marker = write only
 */
export function parseRelayListEvent(event: NostrEvent): RelayList {
  const readRelays: string[] = [];
  const writeRelays: string[] = [];

  if (!event?.tags) {
    return { readRelays, writeRelays };
  }

  for (const tag of event.tags) {
    if (tag[0] !== 'r') continue;

    const url = tag[1];
    if (!url) continue;

    const marker = tag[2];

    // No marker = both read and write
    if (!marker) {
      readRelays.push(url);
      writeRelays.push(url);
    } else if (marker === 'read') {
      readRelays.push(url);
    } else if (marker === 'write') {
      writeRelays.push(url);
    }
  }

  return { readRelays, writeRelays };
}

/**
 * Relay List Service for NIP-65 outbox model
 *
 * Fetches kind 10002 events to determine relay preferences.
 */
export class RelayListService {
  private cache: Map<string, CachedRelayList> = new Map();
  private pool: RelayPool;
  private indexerRelays: string[];
  private cacheTTL: number;

  /**
   * @param pool - RelayPool for fetching events
   * @param opts - Configuration options
   */
  constructor(
    pool?: RelayPool,
    opts?: {
      indexerRelays?: string[];
      cacheTTL?: number;
    }
  ) {
    this.pool = pool || new RelayPool();
    // Well-known profile/relay list indexer
    this.indexerRelays = opts?.indexerRelays || ['wss://purplepag.es'];
    // Default cache TTL: 5 minutes
    this.cacheTTL = opts?.cacheTTL || 5 * 60 * 1000;
  }

  /**
   * Fetch relay list for a pubkey
   *
   * @param pubkey - Public key to fetch relay list for
   * @param relays - Additional relays to query (beyond indexer)
   */
  async getRelayList(pubkey: string, relays: string[] = []): Promise<RelayList> {
    // Check cache first
    const cached = this.cache.get(pubkey);
    if (cached && Date.now() - cached.fetchedAt < this.cacheTTL) {
      return cached.list;
    }

    // Fetch from relays
    const allRelays = [...new Set([...this.indexerRelays, ...relays])];
    const event = await this.fetchKind10002(pubkey, allRelays);

    const list = event ? parseRelayListEvent(event) : { readRelays: [], writeRelays: [] };

    // Cache the result
    this.cache.set(pubkey, {
      list,
      fetchedAt: Date.now(),
    });

    return list;
  }

  /**
   * Fetch kind 10002 event from relays
   */
  private async fetchKind10002(
    pubkey: string,
    relays: string[]
  ): Promise<NostrEvent | null> {
    const filter: Filter = {
      kinds: [10002],
      authors: [pubkey],
      limit: 1,
    };

    return new Promise((resolve) => {
      let foundEvent: NostrEvent | null = null;
      let completed = 0;
      const total = relays.length;

      // Set a timeout for the entire operation
      const timeout = setTimeout(() => {
        resolve(foundEvent);
      }, 5000);

      // Query each relay
      for (const relayUrl of relays) {
        const relay = this.pool.relay(relayUrl);

        // Subscribe to get the event
        const sub = relay.subscription([filter]);
        const subscription = sub.subscribe({
          next: (response) => {
            // Filter out EOSE strings, only process actual events
            if (typeof response === 'string') return;
            const event = response as NostrEvent;
            // Keep the most recent event
            if (!foundEvent || event.created_at > foundEvent.created_at) {
              foundEvent = event;
            }
          },
          complete: () => {
            completed++;
            if (completed >= total) {
              clearTimeout(timeout);
              resolve(foundEvent);
            }
          },
          error: () => {
            completed++;
            if (completed >= total) {
              clearTimeout(timeout);
              resolve(foundEvent);
            }
          },
        });

        // Close subscription after a short time
        setTimeout(() => {
          subscription.unsubscribe();
        }, 4000);
      }

      // Handle case where no relays
      if (total === 0) {
        clearTimeout(timeout);
        resolve(null);
      }
    });
  }

  /**
   * Determine all relays for publishing with outbox model
   *
   * NIP-65 Outbox Model:
   * - Publish to author's write relays
   * - Publish to tagged users' read relays (so they see mentions)
   * - Add default relays as fallback
   *
   * @param opts - Options for determining publish relays
   */
  async getPublishRelays(opts: {
    authorPubkey: string;
    taggedPubkeys?: string[];
    defaultRelays: string[];
    maxRelays?: number;
  }): Promise<string[]> {
    const relays = new Set<string>();
    const maxRelays = opts.maxRelays || 10;

    // 1. Get author's write relays
    const authorRelayList = await this.getRelayList(opts.authorPubkey, opts.defaultRelays);
    for (const relay of authorRelayList.writeRelays) {
      relays.add(normalizeRelayUrl(relay));
    }

    // 2. Get tagged users' read relays (for mentions)
    if (opts.taggedPubkeys && opts.taggedPubkeys.length > 0) {
      // Limit how many tagged users we query to avoid too many requests
      const pubkeysToQuery = opts.taggedPubkeys.slice(0, 5);

      const relayListPromises = pubkeysToQuery.map((pubkey) =>
        this.getRelayList(pubkey, opts.defaultRelays)
      );

      const relayLists = await Promise.all(relayListPromises);

      for (const list of relayLists) {
        for (const relay of list.readRelays) {
          relays.add(normalizeRelayUrl(relay));
        }
      }
    }

    // 3. Add default relays as fallback
    for (const relay of opts.defaultRelays) {
      relays.add(normalizeRelayUrl(relay));
    }

    // Convert to array and limit
    const relayArray = Array.from(relays).slice(0, maxRelays);

    return relayArray;
  }

  /**
   * Invalidate cached relay list for a pubkey
   * Call this when the user updates their relay list
   */
  invalidateCache(pubkey: string): void {
    this.cache.delete(pubkey);
  }

  /**
   * Clear entire cache
   */
  clearCache(): void {
    this.cache.clear();
  }
}

/**
 * Normalize relay URL for comparison
 * - Lowercase hostname
 * - Add trailing slash
 * - Handle ws:// vs wss://
 */
function normalizeRelayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Lowercase hostname
    parsed.hostname = parsed.hostname.toLowerCase();
    // Get URL without trailing slash, then add one
    let normalized = parsed.toString();
    if (!normalized.endsWith('/')) {
      normalized += '/';
    }
    return normalized;
  } catch {
    // If URL parsing fails, return as-is
    return url;
  }
}

/**
 * Singleton relay list service
 */
let sharedRelayListService: RelayListService | null = null;

/**
 * Get or create a shared relay list service
 */
export function getRelayListService(pool?: RelayPool): RelayListService {
  if (!sharedRelayListService) {
    sharedRelayListService = new RelayListService(pool);
  }
  return sharedRelayListService;
}
