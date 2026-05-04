import { describe, it, expect } from 'vitest';
import { nip19 } from 'nostr-tools';
import type { NostrEvent } from 'nostr-tools';
import {
  decodeAuthorSetNaddrs,
  parseFollowSetEvent,
  buildAuthorDirectory,
} from '../src/authors.js';

// ============ Fixtures ============

const PUBKEY_ALICE = 'a'.repeat(64);
const PUBKEY_BOB = 'b'.repeat(64);
const PUBKEY_CAROL = 'c'.repeat(64);
const PUBKEY_OWNER = 'd'.repeat(64);

const VALID_NADDR = nip19.naddrEncode({
  kind: 30000,
  pubkey: PUBKEY_OWNER,
  identifier: 'test-set',
  relays: ['wss://relay.example.com'],
});

const VALID_NADDR_2 = nip19.naddrEncode({
  kind: 30000,
  pubkey: PUBKEY_OWNER,
  identifier: 'second-set',
});

function createFollowSetEvent(
  pubkey: string,
  identifier: string,
  pTags: string[][],
  extra?: { title?: string; description?: string }
): NostrEvent {
  const tags: string[][] = [['d', identifier], ...pTags];
  if (extra?.title) tags.push(['title', extra.title]);
  if (extra?.description) tags.push(['description', extra.description]);
  return {
    id: 'event-' + identifier,
    pubkey,
    created_at: 1700000000,
    kind: 30000,
    tags,
    content: '',
    sig: 'sig-' + identifier,
  };
}

function createProfileEvent(pubkey: string, content: Record<string, string>): NostrEvent {
  return {
    id: 'profile-' + pubkey.slice(0, 8),
    pubkey,
    created_at: 1700000000,
    kind: 0,
    tags: [],
    content: JSON.stringify(content),
    sig: 'sig-profile-' + pubkey.slice(0, 8),
  };
}

// ============ Tests ============

describe('decodeAuthorSetNaddrs', () => {
  it('decodes valid naddr strings', () => {
    const result = decodeAuthorSetNaddrs([VALID_NADDR]);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe(30000);
    expect(result[0].pubkey).toBe(PUBKEY_OWNER);
    expect(result[0].identifier).toBe('test-set');
    expect(result[0].relays).toContain('wss://relay.example.com');
  });

  it('decodes multiple naddrs', () => {
    const result = decodeAuthorSetNaddrs([VALID_NADDR, VALID_NADDR_2]);
    expect(result).toHaveLength(2);
    expect(result[0].identifier).toBe('test-set');
    expect(result[1].identifier).toBe('second-set');
  });

  it('skips invalid naddr strings', () => {
    const result = decodeAuthorSetNaddrs(['invalid', 'naddr1badvalue', VALID_NADDR]);
    expect(result).toHaveLength(1);
    expect(result[0].identifier).toBe('test-set');
  });

  it('skips non-naddr nip19 values', () => {
    const npub = nip19.npubEncode(PUBKEY_ALICE);
    const result = decodeAuthorSetNaddrs([npub, VALID_NADDR]);
    expect(result).toHaveLength(1);
  });

  it('returns empty array for empty input', () => {
    expect(decodeAuthorSetNaddrs([])).toEqual([]);
  });

  it('trims whitespace from naddrs', () => {
    const result = decodeAuthorSetNaddrs([`  ${VALID_NADDR}  `]);
    expect(result).toHaveLength(1);
  });
});

describe('parseFollowSetEvent', () => {
  it('extracts p tags as ProfilePointers', () => {
    const event = createFollowSetEvent(PUBKEY_OWNER, 'test-set', [
      ['p', PUBKEY_ALICE],
      ['p', PUBKEY_BOB, 'wss://relay.example.com'],
    ]);

    const result = parseFollowSetEvent(event);
    expect(result.profiles).toHaveLength(2);
    expect(result.profiles[0].pubkey).toBe(PUBKEY_ALICE);
    expect(result.profiles[1].pubkey).toBe(PUBKEY_BOB);
  });

  it('extracts title and description', () => {
    const event = createFollowSetEvent(
      PUBKEY_OWNER,
      'test-set',
      [['p', PUBKEY_ALICE]],
      { title: 'My Author List', description: 'Curated education authors' }
    );

    const result = parseFollowSetEvent(event);
    expect(result.title).toBe('My Author List');
    expect(result.description).toBe('Curated education authors');
  });

  it('handles events without title/description', () => {
    const event = createFollowSetEvent(PUBKEY_OWNER, 'test-set', [
      ['p', PUBKEY_ALICE],
    ]);

    const result = parseFollowSetEvent(event);
    expect(result.title).toBeUndefined();
    expect(result.description).toBeUndefined();
  });

  it('handles events with no p tags', () => {
    const event = createFollowSetEvent(PUBKEY_OWNER, 'empty-set', []);
    const result = parseFollowSetEvent(event);
    expect(result.profiles).toHaveLength(0);
  });

  it('ignores non-p tags', () => {
    const event = createFollowSetEvent(PUBKEY_OWNER, 'test-set', [
      ['p', PUBKEY_ALICE],
      ['e', 'some-event-id'],
      ['t', 'education'],
    ]);

    const result = parseFollowSetEvent(event);
    expect(result.profiles).toHaveLength(1);
  });
});

describe('buildAuthorDirectory', () => {
  it('merges sets with profile data', () => {
    const pointer = { kind: 30000, pubkey: PUBKEY_OWNER, identifier: 'test-set' };
    const event = createFollowSetEvent(PUBKEY_OWNER, 'test-set', [
      ['p', PUBKEY_ALICE],
      ['p', PUBKEY_BOB],
    ], { title: 'Authors' });

    const profiles = [
      createProfileEvent(PUBKEY_ALICE, { name: 'Alice', nip05: 'alice@example.com' }),
      createProfileEvent(PUBKEY_BOB, { display_name: 'Bob Smith', about: 'Educator' }),
    ];

    const result = buildAuthorDirectory(
      [{ pointer, event, parsed: parseFollowSetEvent(event) }],
      profiles
    );

    expect(result.authors).toHaveLength(2);
    expect(result.sets).toHaveLength(1);
    expect(result.sets[0].title).toBe('Authors');
    expect(result.sets[0].authorCount).toBe(2);

    const alice = result.authors.find((a) => a.pubkey === PUBKEY_ALICE);
    expect(alice?.name).toBe('Alice');
    expect(alice?.nip05).toBe('alice@example.com');

    const bob = result.authors.find((a) => a.pubkey === PUBKEY_BOB);
    expect(bob?.name).toBe('Bob Smith');
    expect(bob?.about).toBe('Educator');
  });

  it('deduplicates authors across sets', () => {
    const pointer1 = { kind: 30000, pubkey: PUBKEY_OWNER, identifier: 'set-1' };
    const pointer2 = { kind: 30000, pubkey: PUBKEY_OWNER, identifier: 'set-2' };

    const event1 = createFollowSetEvent(PUBKEY_OWNER, 'set-1', [
      ['p', PUBKEY_ALICE],
      ['p', PUBKEY_BOB],
    ]);
    const event2 = createFollowSetEvent(PUBKEY_OWNER, 'set-2', [
      ['p', PUBKEY_BOB],
      ['p', PUBKEY_CAROL],
    ]);

    const profiles = [
      createProfileEvent(PUBKEY_ALICE, { name: 'Alice' }),
      createProfileEvent(PUBKEY_BOB, { name: 'Bob' }),
      createProfileEvent(PUBKEY_CAROL, { name: 'Carol' }),
    ];

    const result = buildAuthorDirectory(
      [
        { pointer: pointer1, event: event1, parsed: parseFollowSetEvent(event1) },
        { pointer: pointer2, event: event2, parsed: parseFollowSetEvent(event2) },
      ],
      profiles
    );

    // Bob appears in both sets but should only be listed once
    expect(result.authors).toHaveLength(3);
    const bob = result.authors.find((a) => a.pubkey === PUBKEY_BOB);
    expect(bob?.sets).toContain('set-1');
    expect(bob?.sets).toContain('set-2');
    expect(bob?.sets).toHaveLength(2);
  });

  it('handles authors without profile data', () => {
    const pointer = { kind: 30000, pubkey: PUBKEY_OWNER, identifier: 'test-set' };
    const event = createFollowSetEvent(PUBKEY_OWNER, 'test-set', [
      ['p', PUBKEY_ALICE],
    ]);

    const result = buildAuthorDirectory(
      [{ pointer, event, parsed: parseFollowSetEvent(event) }],
      [] // no profiles fetched
    );

    expect(result.authors).toHaveLength(1);
    expect(result.authors[0].pubkey).toBe(PUBKEY_ALICE);
    expect(result.authors[0].name).toBeUndefined();
  });

  it('picks the newest profile when duplicates exist', () => {
    const pointer = { kind: 30000, pubkey: PUBKEY_OWNER, identifier: 'test-set' };
    const event = createFollowSetEvent(PUBKEY_OWNER, 'test-set', [
      ['p', PUBKEY_ALICE],
    ]);

    const oldProfile: NostrEvent = {
      ...createProfileEvent(PUBKEY_ALICE, { name: 'Alice Old' }),
      created_at: 1600000000,
    };
    const newProfile: NostrEvent = {
      ...createProfileEvent(PUBKEY_ALICE, { name: 'Alice New' }),
      created_at: 1700000000,
    };

    const result = buildAuthorDirectory(
      [{ pointer, event, parsed: parseFollowSetEvent(event) }],
      [oldProfile, newProfile]
    );

    expect(result.authors[0].name).toBe('Alice New');
  });

  it('sorts authors with names before those without', () => {
    const pointer = { kind: 30000, pubkey: PUBKEY_OWNER, identifier: 'test-set' };
    const event = createFollowSetEvent(PUBKEY_OWNER, 'test-set', [
      ['p', PUBKEY_ALICE],
      ['p', PUBKEY_BOB],
      ['p', PUBKEY_CAROL],
    ]);

    const profiles = [
      createProfileEvent(PUBKEY_BOB, { name: 'Bob' }),
      // Alice has no profile, Carol has no profile
    ];

    const result = buildAuthorDirectory(
      [{ pointer, event, parsed: parseFollowSetEvent(event) }],
      profiles
    );

    // Bob (has name) should come before Alice and Carol (no names)
    expect(result.authors[0].name).toBe('Bob');
    expect(result.authors[0].pubkey).toBe(PUBKEY_BOB);
  });

  it('returns empty directory for empty input', () => {
    const result = buildAuthorDirectory([], []);
    expect(result.authors).toEqual([]);
    expect(result.sets).toEqual([]);
  });
});
