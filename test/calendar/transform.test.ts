import { describe, it, expect } from 'vitest';
import { eventToCalendarEvent, eventsToCalendarEvents } from '../../src/calendar/transform.js';
import { nip19, type NostrEvent } from 'nostr-tools';

// Valid 32-byte hex pubkey so naddr encoding succeeds.
const HEX_PUBKEY = 'a'.repeat(64);

function createDateEvent(tags: string[][], content = ''): NostrEvent {
  return {
    id: 'event-date-1',
    pubkey: HEX_PUBKEY,
    created_at: 1700000000,
    kind: 31922,
    tags,
    content,
    sig: 'sig123',
  };
}

function createTimeEvent(tags: string[][], content = ''): NostrEvent {
  return {
    id: 'event-time-1',
    pubkey: HEX_PUBKEY,
    created_at: 1700000000,
    kind: 31923,
    tags,
    content,
    sig: 'sig456',
  };
}

describe('eventToCalendarEvent', () => {
  it('transforms a date-based calendar event (kind 31922)', () => {
    const event = createDateEvent([
      ['d', 'holiday-2024'],
      ['title', 'Summer Holiday'],
      ['start', '2024-07-01'],
      ['end', '2024-07-15'],
      ['location', 'Beach Resort'],
    ], 'A relaxing summer holiday');

    const result = eventToCalendarEvent(event);

    expect(result).not.toBeNull();
    expect(result!.kind).toBe(31922);
    expect(result!.identifier).toBe('holiday-2024');
    expect(result!.title).toBe('Summer Holiday');
    expect(result!.start).toBe('2024-07-01');
    expect(result!.end).toBe('2024-07-15');
    expect(result!.description).toBe('A relaxing summer holiday');
    expect(result!.locations).toEqual(['Beach Resort']);
    expect(result!.nostr.eventId).toBe('event-date-1');
    expect(result!.nostr.pubkey).toBe(HEX_PUBKEY);
    expect(result!.nostr.createdAt).toBe(1700000000);
  });

  it('transforms a time-based calendar event (kind 31923) with timezone', () => {
    const event = createTimeEvent([
      ['d', 'meetup-2024-03'],
      ['title', 'Nostr Berlin Meetup'],
      ['summary', 'Monthly Nostr meetup in Berlin'],
      ['image', 'https://example.com/meetup.jpg'],
      ['start', '1709319600'],
      ['end', '1709330400'],
      ['start_tzid', 'Europe/Berlin'],
      ['end_tzid', 'Europe/Berlin'],
      ['location', 'c-base, Rungestraße 20, Berlin'],
      ['g', 'u33dc'],
      ['t', 'nostr'],
      ['t', 'meetup'],
      ['r', 'https://meetup.example.com/nostr-berlin'],
    ], 'Join us for the monthly Nostr meetup!');

    const result = eventToCalendarEvent(event);

    expect(result).not.toBeNull();
    expect(result!.kind).toBe(31923);
    expect(result!.identifier).toBe('meetup-2024-03');
    expect(result!.title).toBe('Nostr Berlin Meetup');
    expect(result!.summary).toBe('Monthly Nostr meetup in Berlin');
    expect(result!.image).toBe('https://example.com/meetup.jpg');
    expect(result!.start).toBe('1709319600');
    expect(result!.end).toBe('1709330400');
    expect(result!.startTzid).toBe('Europe/Berlin');
    expect(result!.endTzid).toBe('Europe/Berlin');
    expect(result!.locations).toEqual(['c-base, Rungestraße 20, Berlin']);
    expect(result!.geohash).toBe('u33dc');
    expect(result!.hashtags).toEqual(['nostr', 'meetup']);
    expect(result!.references).toEqual(['https://meetup.example.com/nostr-berlin']);
    expect(result!.sourcePage).toBe('https://meetup.example.com/nostr-berlin');
    expect(result!.description).toBe('Join us for the monthly Nostr meetup!');
  });

  it('extracts participants with roles', () => {
    const event = createTimeEvent([
      ['d', 'conf-talk-1'],
      ['title', 'Keynote: Future of Nostr'],
      ['start', '1709319600'],
      ['p', 'speaker-pubkey', 'wss://relay.example.com', 'speaker'],
      ['p', 'organizer-pubkey', '', 'organizer'],
      ['p', 'attendee-pubkey'],
    ]);

    const result = eventToCalendarEvent(event);

    expect(result!.participants).toHaveLength(3);
    expect(result!.participants![0]).toEqual({
      pubkey: 'speaker-pubkey',
      relay: 'wss://relay.example.com',
      role: 'speaker',
    });
    expect(result!.participants![1]).toEqual({
      pubkey: 'organizer-pubkey',
      role: 'organizer',
    });
    expect(result!.participants![2]).toEqual({
      pubkey: 'attendee-pubkey',
    });
  });

  it('handles multiple locations', () => {
    const event = createTimeEvent([
      ['d', 'hybrid-event'],
      ['title', 'Hybrid Conference'],
      ['start', '1709319600'],
      ['location', 'Convention Center, Room A'],
      ['location', 'https://meet.example.com/conf'],
    ]);

    const result = eventToCalendarEvent(event);
    expect(result!.locations).toEqual([
      'Convention Center, Room A',
      'https://meet.example.com/conf',
    ]);
  });

  it('falls back to name tag when title is missing', () => {
    const event = createDateEvent([
      ['d', 'legacy-event'],
      ['name', 'Legacy Event Title'],
      ['start', '2024-01-01'],
    ]);

    const result = eventToCalendarEvent(event);
    expect(result!.title).toBe('Legacy Event Title');
  });

  it('encodes an naddr from the event kind, pubkey and identifier', () => {
    const event = createDateEvent([
      ['d', 'holiday-2024'],
      ['title', 'Summer Holiday'],
      ['start', '2024-07-01'],
    ]);

    const result = eventToCalendarEvent(event);

    expect(result!.naddr).toBeDefined();
    expect(result!.naddr).toMatch(/^naddr1/);
    const decoded = nip19.decode(result!.naddr!);
    expect(decoded.type).toBe('naddr');
    expect(decoded.data).toMatchObject({
      kind: 31922,
      pubkey: HEX_PUBKEY,
      identifier: 'holiday-2024',
    });
  });

  it('omits url when EDUFEED_APP_BASE_URL is unset', () => {
    // The transform module reads the env var at import time and vitest runs
    // without it, so this asserts the default unset behavior: naddr is still
    // emitted, but the viewer url is not.
    const event = createDateEvent([
      ['d', 'holiday-2024'],
      ['title', 'Summer Holiday'],
      ['start', '2024-07-01'],
    ]);

    const result = eventToCalendarEvent(event);

    expect(result!.url).toBeUndefined();
    expect(result!.naddr).toBeDefined();
  });

  it('returns null when d tag is missing', () => {
    const event = createDateEvent([
      ['title', 'No Identifier'],
      ['start', '2024-01-01'],
    ]);

    expect(eventToCalendarEvent(event)).toBeNull();
  });

  it('returns null when title and name are missing', () => {
    const event = createDateEvent([
      ['d', 'no-title'],
      ['start', '2024-01-01'],
    ]);

    expect(eventToCalendarEvent(event)).toBeNull();
  });

  it('returns null when start is missing', () => {
    const event = createDateEvent([
      ['d', 'no-start'],
      ['title', 'Event Without Start'],
    ]);

    expect(eventToCalendarEvent(event)).toBeNull();
  });

  it('omits optional fields when not present', () => {
    const event = createDateEvent([
      ['d', 'minimal'],
      ['title', 'Minimal Event'],
      ['start', '2024-06-15'],
    ]);

    const result = eventToCalendarEvent(event);

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Minimal Event');
    expect(result!.summary).toBeUndefined();
    expect(result!.description).toBeUndefined();
    expect(result!.image).toBeUndefined();
    expect(result!.end).toBeUndefined();
    expect(result!.startTzid).toBeUndefined();
    expect(result!.endTzid).toBeUndefined();
    expect(result!.locations).toBeUndefined();
    expect(result!.geohash).toBeUndefined();
    expect(result!.hashtags).toBeUndefined();
    expect(result!.references).toBeUndefined();
    expect(result!.sourcePage).toBeUndefined();
    expect(result!.participants).toBeUndefined();
  });
});

describe('eventsToCalendarEvents', () => {
  it('transforms multiple events and filters invalid ones', () => {
    const valid = createDateEvent([
      ['d', 'event-1'],
      ['title', 'Valid Event'],
      ['start', '2024-01-01'],
    ]);
    const invalid: NostrEvent = {
      id: 'invalid-1',
      pubkey: 'pubkey',
      created_at: 1700000000,
      kind: 31922,
      tags: [], // missing required tags
      content: '',
      sig: 'sig',
    };

    const results = eventsToCalendarEvents([valid, invalid]);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Valid Event');
  });

  it('returns empty array for empty input', () => {
    expect(eventsToCalendarEvents([])).toEqual([]);
  });
});
