/**
 * Publish Service
 *
 * Handles event publishing to Nostr relays using applesauce-relay's RelayPool.
 * Supports NIP-42 authentication for relays that require it.
 */

import { RelayPool, type Relay, type AuthSigner } from 'applesauce-relay';
import type { NostrEvent } from 'nostr-tools';
import type { Signer } from './manager.js';
import { getRelayListService, type RelayListService } from './relay-list.js';

export interface PublishResult {
  successes: string[];
  failures: { relay: string; error: string }[];
}

export interface PublishOptions {
  /** Timeout per relay in milliseconds (default: 5000) */
  timeout?: number;
  /** Auth timeout in milliseconds (default: 3000) */
  authTimeout?: number;
}

/**
 * Authenticate with a relay, with timeout
 *
 * NIP-42 authentication - some relays require this before accepting events.
 * relay.authenticate() has NO built-in timeout, so we wrap with Promise.race.
 */
async function authenticateWithTimeout(
  relay: Relay,
  signer: Signer,
  timeout: number = 3000
): Promise<boolean> {
  try {
    // Cast signer to AuthSigner - our Signer interface is compatible
    // The difference is AuthSigner uses EventTemplate (without pubkey)
    // while our Signer uses UnsignedEvent (with pubkey).
    // Both work because the signer adds the pubkey internally.
    await Promise.race([
      relay.authenticate(signer as unknown as AuthSigner),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Auth timeout')), timeout)
      ),
    ]);
    return true;
  } catch {
    // Auth not required, not supported, or timed out - continue anyway
    return false;
  }
}

/**
 * Publish Service for event publishing
 *
 * Uses applesauce-relay's RelayPool for connection management and publishing.
 */
export class PublishService {
  private pool: RelayPool;

  constructor(pool?: RelayPool) {
    this.pool = pool || new RelayPool();
  }

  /**
   * Publish an event to multiple relays
   *
   * @param event - Signed Nostr event to publish
   * @param relays - Array of relay URLs to publish to
   * @param signer - Optional signer for NIP-42 authentication
   * @param opts - Publish options (timeouts)
   */
  async publish(
    event: NostrEvent,
    relays: string[],
    signer?: Signer,
    opts: PublishOptions = {}
  ): Promise<PublishResult> {
    const timeout = opts.timeout ?? 5000;
    const authTimeout = opts.authTimeout ?? 3000;

    const results = await Promise.allSettled(
      relays.map(async (url) => {
        const relay = this.pool.relay(url);

        // Authenticate first if signer provided (NIP-42)
        if (signer) {
          await authenticateWithTimeout(relay, signer, authTimeout);
        }

        // Publish with timeout
        const response = await relay.publish(event, { timeout });

        if (!response.ok) {
          throw new Error(response.message || 'Publish failed');
        }

        return { relay: url, success: true };
      })
    );

    // Process results
    const successes: string[] = [];
    const failures: { relay: string; error: string }[] = [];

    results.forEach((result, index) => {
      const relayUrl = relays[index];
      if (result.status === 'fulfilled') {
        successes.push(relayUrl);
      } else {
        failures.push({
          relay: relayUrl,
          error: result.reason?.message || String(result.reason),
        });
      }
    });

    return { successes, failures };
  }

  /**
   * Publish to a single relay (convenience method)
   */
  async publishToRelay(
    event: NostrEvent,
    relayUrl: string,
    signer?: Signer,
    opts: PublishOptions = {}
  ): Promise<{ success: boolean; error?: string }> {
    const result = await this.publish(event, [relayUrl], signer, opts);

    if (result.successes.length > 0) {
      return { success: true };
    } else {
      return {
        success: false,
        error: result.failures[0]?.error || 'Unknown error',
      };
    }
  }

  /**
   * Publish an event using NIP-65 outbox model
   *
   * Automatically determines relays based on:
   * - Author's write relays (kind 10002)
   * - Tagged users' read relays
   * - Default relays as fallback
   *
   * @param event - Signed Nostr event to publish
   * @param opts - Publish options including default relays
   * @param signer - Optional signer for NIP-42 authentication
   */
  async publishWithOutbox(
    event: NostrEvent,
    opts: {
      defaultRelays: string[];
      useOutbox?: boolean;
      timeout?: number;
      authTimeout?: number;
    },
    signer?: Signer
  ): Promise<PublishResult> {
    const useOutbox = opts.useOutbox ?? true;

    // If outbox is disabled, just use default relays
    if (!useOutbox) {
      return this.publish(event, opts.defaultRelays, signer, {
        timeout: opts.timeout,
        authTimeout: opts.authTimeout,
      });
    }

    // Extract p-tagged pubkeys for outbox model
    const taggedPubkeys: string[] = [];
    for (const tag of event.tags) {
      if (tag[0] === 'p' && tag[1]) {
        taggedPubkeys.push(tag[1]);
      }
    }

    // Use relay list service to determine publish relays
    const relayListService = getRelayListService(this.pool);
    const relays = await relayListService.getPublishRelays({
      authorPubkey: event.pubkey,
      taggedPubkeys,
      defaultRelays: opts.defaultRelays,
    });

    // Publish to determined relays
    return this.publish(event, relays, signer, {
      timeout: opts.timeout,
      authTimeout: opts.authTimeout,
    });
  }

  /**
   * Get the relay pool (for advanced usage)
   */
  getPool(): RelayPool {
    return this.pool;
  }
}

/**
 * Singleton publish service (can be shared across tools)
 */
let sharedPublishService: PublishService | null = null;

/**
 * Get or create a shared publish service
 */
export function getPublishService(pool?: RelayPool): PublishService {
  if (!sharedPublishService) {
    sharedPublishService = new PublishService(pool);
  }
  return sharedPublishService;
}
