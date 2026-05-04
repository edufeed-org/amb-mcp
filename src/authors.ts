/**
 * Known Authors from NIP-51 Follow Sets (kind 30000)
 *
 * Loads author directories from follow set naddrs on startup,
 * allowing the LLM to resolve author names to pubkeys for search_resources calls.
 */

import { nip19, SimplePool, type NostrEvent } from 'nostr-tools';
import type { AddressPointer, ProfilePointer } from 'nostr-tools/nip19';
import { getProfileContent } from 'applesauce-core/helpers';
import { getProfilePointerFromPTag } from 'applesauce-core/helpers';

// ============ Types ============

export interface KnownAuthor {
  pubkey: string;
  name?: string;
  nip05?: string;
  about?: string;
  sets: string[];
}

export interface AuthorSet {
  identifier: string;
  title?: string;
  description?: string;
  ownerPubkey: string;
  authorCount: number;
}

export interface AuthorDirectory {
  authors: KnownAuthor[];
  sets: AuthorSet[];
}

// ============ Pure Functions ============

/**
 * Decode naddr strings into AddressPointers.
 * Silently skips invalid or non-naddr values.
 */
export function decodeAuthorSetNaddrs(naddrs: string[]): AddressPointer[] {
  const pointers: AddressPointer[] = [];
  for (const naddr of naddrs) {
    try {
      const decoded = nip19.decode(naddr.trim());
      if (decoded.type === 'naddr') {
        pointers.push(decoded.data);
      }
    } catch {
      // skip invalid naddrs
    }
  }
  return pointers;
}

/**
 * Parse a kind 30000 follow set event.
 * Extracts p tags as ProfilePointers and title/description from tags.
 */
export function parseFollowSetEvent(event: NostrEvent): {
  profiles: ProfilePointer[];
  title?: string;
  description?: string;
} {
  const profiles: ProfilePointer[] = [];

  for (const tag of event.tags) {
    if (tag[0] === 'p') {
      const pointer = getProfilePointerFromPTag(tag);
      if (pointer) {
        profiles.push(pointer);
      }
    }
  }

  const titleTag = event.tags.find((t) => t[0] === 'title');
  const descTag = event.tags.find((t) => t[0] === 'description');

  return {
    profiles,
    title: titleTag?.[1],
    description: descTag?.[1],
  };
}

interface ParsedSet {
  pointer: AddressPointer;
  event: NostrEvent;
  parsed: ReturnType<typeof parseFollowSetEvent>;
}

/**
 * Build an AuthorDirectory from parsed follow sets and kind 0 profile events.
 */
export function buildAuthorDirectory(
  sets: ParsedSet[],
  profileEvents: NostrEvent[]
): AuthorDirectory {
  // Index profiles by pubkey
  const profileMap = new Map<string, NostrEvent>();
  for (const event of profileEvents) {
    const existing = profileMap.get(event.pubkey);
    if (!existing || existing.created_at < event.created_at) {
      profileMap.set(event.pubkey, event);
    }
  }

  // Track which sets each author belongs to
  const authorSets = new Map<string, Set<string>>();
  for (const set of sets) {
    const identifier = set.pointer.identifier;
    for (const profile of set.parsed.profiles) {
      const existing = authorSets.get(profile.pubkey);
      if (existing) {
        existing.add(identifier);
      } else {
        authorSets.set(profile.pubkey, new Set([identifier]));
      }
    }
  }

  // Build author entries
  const authors: KnownAuthor[] = [];
  for (const [pubkey, setIds] of authorSets) {
    const profileEvent = profileMap.get(pubkey);
    const content = profileEvent ? getProfileContent(profileEvent) : undefined;

    authors.push({
      pubkey,
      name: content?.display_name || content?.name,
      nip05: content?.nip05,
      about: content?.about,
      sets: [...setIds],
    });
  }

  // Sort authors by name (names first, then pubkeys)
  authors.sort((a, b) => {
    if (a.name && b.name) return a.name.localeCompare(b.name);
    if (a.name) return -1;
    if (b.name) return 1;
    return a.pubkey.localeCompare(b.pubkey);
  });

  // Build set entries
  const authorSetEntries: AuthorSet[] = sets.map((s) => ({
    identifier: s.pointer.identifier,
    title: s.parsed.title,
    description: s.parsed.description,
    ownerPubkey: s.pointer.pubkey,
    authorCount: s.parsed.profiles.length,
  }));

  return { authors, sets: authorSetEntries };
}

// ============ Async Loader ============

const PROFILE_RELAYS = ['wss://purplepag.es'];
const FETCH_TIMEOUT = 15000;

/**
 * Load author sets from naddr strings.
 * Fetches kind 30000 events and kind 0 profiles, then builds the directory.
 */
export async function loadAuthorSets(
  naddrs: string[],
  defaultRelays: string[]
): Promise<AuthorDirectory> {
  const pointers = decodeAuthorSetNaddrs(naddrs);
  if (pointers.length === 0) {
    return { authors: [], sets: [] };
  }

  const pool = new SimplePool();

  try {
    // Collect all relay hints + default relays for fetching follow sets
    const setRelays = new Set(defaultRelays);
    for (const p of pointers) {
      if (p.relays) {
        for (const r of p.relays) setRelays.add(r);
      }
    }

    // Fetch kind 30000 events
    const setEvents = await Promise.race([
      pool.querySync([...setRelays], {
        kinds: [30000],
        authors: pointers.map((p) => p.pubkey),
        '#d': pointers.map((p) => p.identifier),
      }),
      new Promise<NostrEvent[]>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout fetching follow sets')), FETCH_TIMEOUT)
      ),
    ]);

    // Match events to pointers
    const parsedSets: ParsedSet[] = [];
    for (const pointer of pointers) {
      const event = setEvents.find(
        (e) =>
          e.pubkey === pointer.pubkey &&
          e.tags.some((t) => t[0] === 'd' && t[1] === pointer.identifier)
      );
      if (event) {
        parsedSets.push({
          pointer,
          event,
          parsed: parseFollowSetEvent(event),
        });
      }
    }

    // Collect unique pubkeys from all sets
    const allPubkeys = new Set<string>();
    for (const set of parsedSets) {
      for (const profile of set.parsed.profiles) {
        allPubkeys.add(profile.pubkey);
      }
    }

    if (allPubkeys.size === 0) {
      return buildAuthorDirectory(parsedSets, []);
    }

    // Batch-fetch kind 0 profiles
    const profileRelays = [...new Set([...PROFILE_RELAYS, ...defaultRelays])];
    const profileEvents = await Promise.race([
      pool.querySync(profileRelays, {
        kinds: [0],
        authors: [...allPubkeys],
      }),
      new Promise<NostrEvent[]>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout fetching profiles')), FETCH_TIMEOUT)
      ),
    ]);

    return buildAuthorDirectory(parsedSets, profileEvents);
  } finally {
    pool.close([...new Set([...defaultRelays, ...PROFILE_RELAYS])]);
  }
}

// ============ Module State ============

let authorDirectory: AuthorDirectory | null = null;

export function getAuthorDirectory(): AuthorDirectory | null {
  return authorDirectory;
}

export function setAuthorDirectory(dir: AuthorDirectory): void {
  authorDirectory = dir;
}

// Calendar author directory (separate from AMB authors)
let calendarAuthorDirectory: AuthorDirectory | null = null;

export function getCalendarAuthorDirectory(): AuthorDirectory | null {
  return calendarAuthorDirectory;
}

export function setCalendarAuthorDirectory(dir: AuthorDirectory): void {
  calendarAuthorDirectory = dir;
}
