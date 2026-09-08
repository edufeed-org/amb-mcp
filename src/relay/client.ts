import { SimplePool, type Filter, type NostrEvent } from 'nostr-tools';
import { normalizeURL } from 'nostr-tools/utils';
import WebSocket from 'ws';
import { namesFor } from './catalog.js';

// Node 20 (the production runtime image) has no global WebSocket.
// SimplePool from `nostr-tools` root reads its websocketImplementation from a
// module-local variable that's only seeded from globalThis.WebSocket at load
// time, and `nostr-tools/relay`'s `useWebSocketImplementation` does NOT reach
// it. The reliable fix is to pass the impl explicitly per construction.
const WS_IMPL: typeof globalThis.WebSocket =
  (globalThis as { WebSocket?: typeof globalThis.WebSocket }).WebSocket ??
  (WebSocket as unknown as typeof globalThis.WebSocket);

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

/**
 * A per-call relay selection named a relay that is neither in the default set
 * nor in the configured extra (selectable) set. Carries both lists so callers
 * can produce a helpful error message.
 */
export class UnknownRelayError extends Error {
  constructor(
    public readonly unknownRelays: string[],
    public readonly selectableRelays: string[]
  ) {
    super(
      `Unknown relay(s): ${unknownRelays.join(', ')}. ` +
        `Selectable relays: ${selectableRelays.join(', ')}`
    );
    this.name = 'UnknownRelayError';
  }
}

/**
 * A strict query could not produce a trustworthy answer: no relay in the
 * selection accepted a connection, or the query timed out before EOSE.
 * Distinct from an empty result — the relay never (fully) answered.
 */
export class RelayUnreachableError extends Error {
  constructor(public readonly relays: string[], reason: string) {
    super(`relay(s) ${relays.join(', ')} unreachable: ${reason}`);
    this.name = 'RelayUnreachableError';
  }
}

/** Normalize for comparison only; configured URLs are kept verbatim. */
function normalizeForMatch(url: string): string | null {
  try {
    return normalizeURL(url);
  } catch {
    return null;
  }
}

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
  private extraRelayUrls: Set<string>;

  constructor(
    relayUrls: string | string[],
    options?: { extraRelays?: string[] }
  ) {
    // The SimplePool TS signature only declares `enablePing|enableReconnect`,
    // but its runtime constructor spreads `...options` straight into
    // AbstractSimplePool, which honors `websocketImplementation`. Cast to skip
    // the over-tight surface type — verified at runtime against Node 20.
    this.pool = new SimplePool({
      websocketImplementation: WS_IMPL,
    } as ConstructorParameters<typeof SimplePool>[0]);
    this.relayUrls = new Set(
      Array.isArray(relayUrls) ? relayUrls : [relayUrls]
    );
    const taken = new Set(
      [...this.relayUrls].map((u) => normalizeForMatch(u) ?? u)
    );
    this.extraRelayUrls = new Set();
    for (const url of options?.extraRelays ?? []) {
      const norm = normalizeForMatch(url) ?? url;
      if (taken.has(norm)) continue;
      taken.add(norm);
      this.extraRelayUrls.add(url);
    }
  }

  // ============ Runtime relay management ============

  addRelay(url: string): void {
    // A relay promoted into the default set must leave the extra set, or
    // list_relays would report it in both groups.
    const norm = normalizeForMatch(url) ?? url;
    for (const extra of [...this.extraRelayUrls]) {
      if ((normalizeForMatch(extra) ?? extra) === norm) {
        this.extraRelayUrls.delete(extra);
      }
    }
    this.relayUrls.add(url);
  }

  removeRelay(url: string): boolean {
    return this.relayUrls.delete(url);
  }

  getRelays(): string[] {
    return [...this.relayUrls];
  }

  /** Relays that are selectable per call but not part of the default set. */
  getExtraRelays(): string[] {
    return [...this.extraRelayUrls];
  }

  /** Default ∪ extra — everything a per-call `relays` selection may name. */
  getSelectableRelays(): string[] {
    return [...this.relayUrls, ...this.extraRelayUrls];
  }

  /**
   * Validate a per-call relay selection against the selectable set.
   *
   * No/empty selection falls back to the default relays. A requested value is
   * matched by the SAME rule the `?relays=` connector param uses (see
   * catalog.ts `namesFor`): full URL, host, hostname, or the first hostname
   * label — case-insensitively — plus NIP-01 URL normalization for
   * trailing-slash tolerance. A short label claimed by two selectable relays
   * is ambiguous and does not resolve (the longer forms still reach both).
   * Matches return the relay's configured form (the string the pool knows).
   * Any value outside the selectable set throws UnknownRelayError.
   */
  resolveRelays(requested?: string[]): string[] {
    if (!requested || requested.length === 0) {
      return this.getRelays();
    }
    const selectable = this.getSelectableRelays();
    const byName = new Map<string, string>();
    const ambiguous = new Set<string>();
    const register = (name: string, url: string) => {
      const existing = byName.get(name);
      if (existing === undefined) byName.set(name, url);
      else if (existing !== url) ambiguous.add(name);
    };
    for (const url of selectable) {
      for (const name of namesFor(url)) register(name, url);
      const norm = normalizeForMatch(url);
      if (norm) register(norm.toLowerCase(), url);
    }
    for (const name of ambiguous) byName.delete(name);

    const resolved: string[] = [];
    const unknown: string[] = [];
    for (const req of requested) {
      const match =
        byName.get(req.trim().toLowerCase()) ??
        byName.get((normalizeForMatch(req) ?? '').toLowerCase());
      if (match === undefined) {
        unknown.push(req);
      } else if (!resolved.includes(match)) {
        resolved.push(match);
      }
    }
    if (unknown.length > 0) {
      throw new UnknownRelayError(unknown, selectable);
    }
    return resolved;
  }

  // ============ Query methods ============

  /**
   * Query with NIP-01 filters only
   */
  async query(filter: Partial<Filter>, relays?: string[]): Promise<NostrEvent[]> {
    const fullFilter: Filter = { ...filter, kinds: [30142] };
    return this.queryRelays(fullFilter, relays);
  }

  /**
   * Query with NIP-50 search string and optional NIP-01 filters
   */
  async search(
    searchString: string,
    filter: Partial<Filter> = {},
    relays?: string[]
  ): Promise<NostrEvent[]> {
    const fullFilter: Filter = {
      ...filter,
      kinds: [30142],
      search: searchString,
    };
    return this.queryRelays(fullFilter, relays);
  }

  /**
   * Search the relay's kind-0 author-profile index (NIP-50) by name.
   * Routes through the generic queryEvents path; the hardcoded kinds:[30142]
   * methods above are unaffected.
   */
  async searchProfiles(name: string, limit?: number): Promise<NostrEvent[]> {
    const bounded = Math.min(Math.max(limit ?? 10, 1), 25);
    return this.queryEvents({ kinds: [0], search: name, limit: bounded });
  }

  /**
   * Get a single event by its ID
   */
  async getById(
    eventId: string,
    kinds: number[] = [30142],
    relays?: string[]
  ): Promise<NostrEvent | null> {
    const events = await this.queryRelays(
      {
        ids: [eventId],
        kinds,
      },
      relays
    );
    return events[0] ?? null;
  }

  /**
   * Get a single event by d-tag (and optionally author)
   */
  async getByDTag(
    dTag: string,
    author?: string,
    kinds: number[] = [30142],
    relays?: string[]
  ): Promise<NostrEvent | null> {
    const filter: Filter = {
      kinds,
      '#d': [dTag],
    };
    if (author) {
      filter.authors = [author];
    }
    const events = await this.queryRelays(filter, relays);
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
  async queryEvents(
    filter: Filter,
    relaySelection?: string[],
    opts?: { strict?: boolean }
  ): Promise<NostrEvent[]> {
    const strict = opts?.strict ?? false;
    const relays = this.resolveRelays(relaySelection);
    if (relays.length === 0) {
      if (strict) throw new RelayUnreachableError(relaySelection ?? [], 'no relays in selection');
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
      new Promise<NostrEvent[]>(async (resolve, reject) => {
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
          if (strict) {
            reject(new RelayUnreachableError(relays, 'no relay accepted a connection'));
          } else {
            resolve([]);
          }
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
    ]).catch((err) => {
      // Strict callers need outage/timeout distinguishable from an empty
      // result; everyone else keeps the lenient empty-array behavior.
      if (strict) {
        if (err instanceof RelayUnreachableError) throw err;
        throw new RelayUnreachableError(relays, 'query timed out before EOSE');
      }
      return [] as NostrEvent[];
    });

    return result;
  }

  // ============ Core query implementation ============

  private async queryRelays(filter: Filter, relaySelection?: string[]): Promise<NostrEvent[]> {
    const relays = this.resolveRelays(relaySelection);
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
   * Fetch NIP-11 relay information from all selectable relays (default ∪ extra)
   */
  async getRelayInfo(): Promise<Map<string, RelayInfo>> {
    const results = new Map<string, RelayInfo>();

    await Promise.allSettled(
      this.getSelectableRelays().map(async (url) => {
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
    this.pool.close(this.getSelectableRelays());
  }
}
