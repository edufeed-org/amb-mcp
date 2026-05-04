import type { NostrEvent } from 'nostr-tools';

export interface CalendarEventParticipant {
  pubkey: string;
  relay?: string;
  role?: string;
}

export interface CalendarEvent {
  kind: number;
  identifier: string;
  title: string;
  summary?: string;
  description?: string;
  image?: string;
  start: string;
  end?: string;
  startTzid?: string;
  endTzid?: string;
  locations?: string[];
  geohash?: string;
  hashtags?: string[];
  references?: string[];
  participants?: CalendarEventParticipant[];
  nostr: {
    eventId: string;
    pubkey: string;
    createdAt: number;
  };
}

/**
 * Extract the first value for a given tag name from a Nostr event.
 */
function getTagValue(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

/**
 * Extract all values for a given tag name from a Nostr event.
 */
function getTagValues(event: NostrEvent, name: string): string[] {
  return event.tags.filter((t) => t[0] === name).map((t) => t[1]);
}

/**
 * Transform a NIP-52 calendar event (kind 31922 or 31923) into a CalendarEvent.
 * Returns null if the event is missing required fields (d, title/name, start).
 */
export function eventToCalendarEvent(event: NostrEvent): CalendarEvent | null {
  const identifier = getTagValue(event, 'd');
  const title = getTagValue(event, 'title') ?? getTagValue(event, 'name');
  const start = getTagValue(event, 'start');

  if (!identifier || !title || !start) {
    return null;
  }

  const locations = getTagValues(event, 'location');
  const hashtags = getTagValues(event, 't');
  const references = getTagValues(event, 'r');

  // Parse participants from p tags: ["p", pubkey, relay?, role?]
  const participants: CalendarEventParticipant[] = event.tags
    .filter((t) => t[0] === 'p' && t[1])
    .map((t) => ({
      pubkey: t[1],
      ...(t[2] ? { relay: t[2] } : {}),
      ...(t[3] ? { role: t[3] } : {}),
    }));

  const result: CalendarEvent = {
    kind: event.kind,
    identifier,
    title,
    start,
    nostr: {
      eventId: event.id,
      pubkey: event.pubkey,
      createdAt: event.created_at,
    },
  };

  // Optional fields — only include if present
  const summary = getTagValue(event, 'summary');
  if (summary) result.summary = summary;

  if (event.content) result.description = event.content;

  const image = getTagValue(event, 'image');
  if (image) result.image = image;

  const end = getTagValue(event, 'end');
  if (end) result.end = end;

  const startTzid = getTagValue(event, 'start_tzid');
  if (startTzid) result.startTzid = startTzid;

  const endTzid = getTagValue(event, 'end_tzid');
  if (endTzid) result.endTzid = endTzid;

  if (locations.length > 0) result.locations = locations;

  const geohash = getTagValue(event, 'g');
  if (geohash) result.geohash = geohash;

  if (hashtags.length > 0) result.hashtags = hashtags;
  if (references.length > 0) result.references = references;
  if (participants.length > 0) result.participants = participants;

  return result;
}

/**
 * Transform multiple Nostr events into CalendarEvents, filtering invalid ones.
 */
export function eventsToCalendarEvents(events: NostrEvent[]): CalendarEvent[] {
  const results: CalendarEvent[] = [];
  for (const event of events) {
    const cal = eventToCalendarEvent(event);
    if (cal) results.push(cal);
  }
  return results;
}
