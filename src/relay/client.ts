import { SimplePool, type Filter, type NostrEvent } from 'nostr-tools';

export interface RelayInfo {
  name: string;
  description: string;
  pubkey?: string;
  contact?: string;
  supported_nips?: number[];
  software?: string;
  version?: string;
}

export interface RelayStatus {
  url: string;
}

const DEFAULT_TIMEOUT = 10000;

/** Standard single-letter NIP-01 tag filters that events actually contain */
const STANDARD_TAG_FILTERS = new Set([
  '#e', '#p', '#a', '#d', '#g', '#i', '#k', '#l', '#L', '#r', '#t',
]);

function isStandardTagFilter(key: string): boolean {
  return STANDARD_TAG_FILTERS.has(key);
}

export class AMBRelayClient {
  private pool: SimplePool;
  private relayUrls: Set<string>;

  constructor(relayUrls: string | string[]) {
    this.pool = new SimplePool();
    this.relayUrls = new Set(
      Array.isArray(relayUrls) ? relayUrls : [relayUrls]
    );
  }

  // ============ Runtime relay management ============

  addRelay(url: string): void {
    this.relayUrls.add(url);
  }

  removeRelay(url: string): boolean {
    return this.relayUrls.delete(url);
  }

  getRelays(): string[] {
    return [...this.relayUrls];
  }

  // ============ Query methods ============

  /**
   * Query with NIP-01 filters only
   */
  async query(filter: Partial<Filter>): Promise<NostrEvent[]> {
    const fullFilter: Filter = { ...filter, kinds: [30142] };
    return this.queryRelays(fullFilter);
  }

  /**
   * Query with NIP-50 search string and optional NIP-01 filters
   */
  async search(
    searchString: string,
    filter: Partial<Filter> = {}
  ): Promise<NostrEvent[]> {
    const fullFilter: Filter = {
      ...filter,
      kinds: [30142],
      search: searchString,
    };
    return this.queryRelays(fullFilter);
  }

  /**
   * Get a single event by its ID
   */
  async getById(eventId: string): Promise<NostrEvent | null> {
    const events = await this.queryRelays({
      ids: [eventId],
      kinds: [30142],
    });
    return events[0] ?? null;
  }

  /**
   * Get a single event by d-tag (and optionally author)
   */
  async getByDTag(dTag: string, author?: string): Promise<NostrEvent | null> {
    const filter: Filter = {
      kinds: [30142],
      '#d': [dTag],
    };
    if (author) {
      filter.authors = [author];
    }
    const events = await this.queryRelays(filter);
    return events[0] ?? null;
  }

  // ============ Generic query ============

  /**
   * Query relays with an arbitrary filter, including extended relay filter
   * properties (e.g. `#start_after` for calendar relay protocol).
   *
   * nostr-tools' SimplePool applies client-side `matchFilters` on incoming
   * events, which rejects events that don't literally contain extended tags
   * like `start_after`. These are relay-level query extensions, not actual
   * event tags.
   *
   * Workaround: Use relay.prepareSubscription to create the subscription with
   * the full filter (so the REQ includes extended props), then immediately
   * patch sub.filters to remove them before any events arrive.
   */
  async queryEvents(filter: Filter): Promise<NostrEvent[]> {
    const relays = this.getRelays();
    if (relays.length === 0) {
      return [];
    }

    // Separate standard filter props from extended relay-only props
    const standardFilter: Filter = {};
    for (const [key, value] of Object.entries(filter)) {
      if (key.startsWith('#') && !isStandardTagFilter(key)) {
        continue; // skip extended props for the client-side filter
      }
      (standardFilter as Record<string, unknown>)[key] = value;
    }

    const events: NostrEvent[] = [];
    const seen = new Set<string>();
    let pendingRelays: number;

    const result = await Promise.race([
      new Promise<NostrEvent[]>(async (resolve) => {
        const subs: Array<{ close(reason?: string): void }> = [];
        const connectedRelays: string[] = [];

        for (const url of relays) {
          try {
            const relay = await this.pool.ensureRelay(url);
            connectedRelays.push(url);
          } catch {
            // skip unreachable relays
          }
        }

        pendingRelays = connectedRelays.length;
        if (pendingRelays === 0) {
          resolve([]);
          return;
        }

        for (const url of connectedRelays) {
          const relay = await this.pool.ensureRelay(url);

          // prepareSubscription creates the sub and registers it, but
          // doesn't send the REQ yet — that happens on fire().
          // We pass the full filter (with extended props) so fire()
          // sends them in the REQ message.
          const sub = relay.prepareSubscription([filter], {
            onevent: (event: NostrEvent) => {
              if (!seen.has(event.id)) {
                seen.add(event.id);
                events.push(event);
              }
            },
            oneose: () => {
              sub.close('eose');
              pendingRelays--;
              if (pendingRelays <= 0) {
                resolve(events);
              }
            },
            onclose: () => {
              pendingRelays--;
              if (pendingRelays <= 0) {
                resolve(events);
              }
            },
          });

          // Send the REQ with full filter (including extended props)
          sub.fire();

          // Immediately patch the stored filters to remove extended props
          // so that matchFilters (called when events arrive asynchronously)
          // won't reject valid events.
          sub.filters = [standardFilter];

          subs.push(sub);
        }
      }),
      new Promise<NostrEvent[]>((_, reject) =>
        setTimeout(() => reject(new Error('Query timeout')), DEFAULT_TIMEOUT)
      ),
    ]).catch(() => [] as NostrEvent[]);

    return result;
  }

  // ============ Core query implementation ============

  private async queryRelays(filter: Filter): Promise<NostrEvent[]> {
    const relays = this.getRelays();
    if (relays.length === 0) {
      return [];
    }

    // Query with timeout
    const events = await Promise.race([
      this.pool.querySync(relays, filter),
      new Promise<NostrEvent[]>((_, reject) =>
        setTimeout(() => reject(new Error('Query timeout')), DEFAULT_TIMEOUT)
      ),
    ]).catch(() => [] as NostrEvent[]);

    // Deduplicate by event ID (same event from multiple relays)
    const seen = new Set<string>();
    return events.filter((event) => {
      if (seen.has(event.id)) return false;
      seen.add(event.id);
      return true;
    });
  }

  // ============ Relay info ============

  /**
   * Fetch NIP-11 relay information from all relays
   */
  async getRelayInfo(): Promise<Map<string, RelayInfo>> {
    const results = new Map<string, RelayInfo>();

    await Promise.allSettled(
      this.getRelays().map(async (url) => {
        const httpUrl = url
          .replace('wss://', 'https://')
          .replace('ws://', 'http://');
        const response = await fetch(httpUrl, {
          headers: { Accept: 'application/nostr+json' },
        });
        if (response.ok) {
          const info = (await response.json()) as RelayInfo;
          results.set(url, info);
        }
      })
    );

    return results;
  }

  /**
   * Get list of configured relays
   */
  getConnectionStatus(): RelayStatus[] {
    return this.getRelays().map((url) => ({ url }));
  }

  /**
   * Test connection to a single relay
   * Returns connection status and optional NIP-11 info
   */
  async testRelayConnection(url: string): Promise<{
    ok: boolean;
    error?: string;
    info?: RelayInfo;
  }> {
    const httpUrl = url
      .replace('wss://', 'https://')
      .replace('ws://', 'http://');

    try {
      const response = await fetch(httpUrl, {
        headers: { Accept: 'application/nostr+json' },
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        const info = (await response.json()) as RelayInfo;
        return { ok: true, info };
      }
      return { ok: false, error: `HTTP ${response.status}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed';
      return { ok: false, error: message };
    }
  }

  // ============ Cleanup ============

  close(): void {
    this.pool.close(this.getRelays());
  }
}
