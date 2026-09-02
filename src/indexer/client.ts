import { normalizeURL } from 'nostr-tools/utils';
import { SpellError } from '../spells/types.js';

export interface PassageHit {
  chunk_id: string;
  event_id: string;
  event_coord: string;
  chunk_idx: number;
  text?: string;
  snippet: string;
  heading?: string;
  section_path?: string;
  page?: number;
  source_url?: string;
  score: number;
  amb?: Record<string, unknown>;
}

function normKey(url: string): string {
  try {
    return normalizeURL(url);
  } catch {
    return url;
  }
}

/** Maps AMB relays to their amb-indexer /search_chunks endpoints. */
export class IndexerClient {
  private readonly endpoints: Map<string, string>;

  constructor(
    endpoints: Map<string, string>,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.endpoints = new Map(Array.from(endpoints).map(([k, v]) => [normKey(k), v]));
  }

  /** INDEXER_ENDPOINTS="wss://relay=https://indexer,..." + INDEXER_API_TOKEN. */
  static fromEnv(spec?: string, token?: string): IndexerClient | null {
    if (!spec || !token) return null;
    const map = new Map<string, string>();
    for (const pair of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
      const i = pair.indexOf('=');
      if (i <= 0) {
        throw new Error(`INDEXER_ENDPOINTS entry is not relay=endpoint: ${pair}`);
      }
      map.set(normKey(pair.slice(0, i)), pair.slice(i + 1).replace(/\/+$/, ''));
    }
    return new IndexerClient(map, token);
  }

  forRelay(relayUrl: string): string | null {
    return this.endpoints.get(normKey(relayUrl)) ?? null;
  }

  async searchChunks(
    relayUrl: string,
    body: { q: string; k: number; filter: Record<string, unknown> }
  ): Promise<{ hits: PassageHit[]; total: number }> {
    const base = this.forRelay(relayUrl);
    if (!base) {
      throw new SpellError('no_indexer', `no passage index configured for relay ${relayUrl}`);
    }
    const res = await this.fetchImpl(`${base}/search_chunks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new SpellError('indexer_error', `indexer at ${base} answered ${res.status}`);
    }
    return (await res.json()) as { hits: PassageHit[]; total: number };
  }
}
