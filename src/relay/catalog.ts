/**
 * Catalog of the relays a deployment knows about, and the short names that
 * reach them.
 *
 * The HTTP transport lets a connector pick its default relay set from the
 * URL it was added with (`/mcp?relays=sodix,oersi`). That parameter resolves
 * through this catalog rather than accepting arbitrary URLs, so a public
 * endpoint never opens WebSocket connections to caller-chosen hosts.
 *
 * Names are derived, not hand-maintained: every configured relay answers to
 * its full URL, its hostname (with and without port), and the first label of
 * its hostname. A short alias claimed by two relays is dropped rather than
 * resolved arbitrarily — the longer forms still reach both.
 */

export interface RelayCatalogEntry {
  url: string;
  /** First hostname label, when it unambiguously identifies this relay. */
  alias?: string;
}

export class UnknownRelayNameError extends Error {
  constructor(
    public readonly unknownNames: string[],
    public readonly knownNames: string[]
  ) {
    super(
      `Unknown relay name(s): ${unknownNames.join(', ')}. ` +
        `Known names: ${knownNames.join(', ')}`
    );
    this.name = 'UnknownRelayNameError';
  }
}

export interface RelayCatalog {
  /** Configured relays, in configured order, with their short aliases. */
  entries(): RelayCatalogEntry[];
  /** Every name `resolve` accepts. */
  knownNames(): string[];
  /** Map names to configured relay URLs, preserving order and deduplicating. */
  resolve(names: string[]): string[];
}

/** Names a single relay URL answers to, most specific first. */
function namesFor(url: string): string[] {
  const names = [url.toLowerCase()];
  try {
    const parsed = new URL(url);
    names.push(parsed.host.toLowerCase());
    names.push(parsed.hostname.toLowerCase());
    const label = parsed.hostname.split('.')[0];
    if (label) names.push(label.toLowerCase());
  } catch {
    // Not a parseable URL — only the verbatim form reaches it.
  }
  return names;
}

/** First hostname label of a URL, or null when it has none. */
function firstLabel(url: string): string | null {
  try {
    return new URL(url).hostname.split('.')[0]?.toLowerCase() || null;
  } catch {
    return null;
  }
}

export function buildRelayCatalog(urls: string[]): RelayCatalog {
  const byName = new Map<string, string>();
  const ambiguous = new Set<string>();

  for (const url of urls) {
    for (const name of namesFor(url)) {
      const existing = byName.get(name);
      if (existing === undefined) {
        byName.set(name, url);
      } else if (existing !== url) {
        ambiguous.add(name);
      }
    }
  }
  for (const name of ambiguous) byName.delete(name);

  const entries: RelayCatalogEntry[] = urls.map((url) => {
    const label = firstLabel(url);
    return label && byName.get(label) === url ? { url, alias: label } : { url };
  });

  return {
    entries: () => entries,
    knownNames: () => [...byName.keys()],
    resolve(names) {
      const resolved: string[] = [];
      const unknown: string[] = [];
      for (const raw of names) {
        const url = byName.get(raw.trim().toLowerCase());
        if (url === undefined) unknown.push(raw);
        else if (!resolved.includes(url)) resolved.push(url);
      }
      if (unknown.length > 0) {
        throw new UnknownRelayNameError(unknown, [...byName.keys()]);
      }
      return resolved;
    },
  };
}

/** Split a `relays=a,b` parameter value into trimmed, non-empty names. */
export function parseRelayNames(raw: string): string[] {
  return raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}
