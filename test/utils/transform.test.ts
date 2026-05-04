import { describe, it, expect } from 'vitest';
import { eventToAMBResource, eventsToAMBResources, toSimplifiedResource } from '../../src/utils/transform.js';
import type { NostrEvent } from 'nostr-tools';

const createMockEvent = (tags: string[][], dTag: string): NostrEvent => ({
  id: 'event123',
  pubkey: 'pubkey123',
  created_at: 1700000000,
  kind: 30142,
  tags: [['d', dTag], ...tags],
  content: 'Some description text',
  sig: 'sig123',
});

describe('eventToAMBResource', () => {
  it('transforms a valid event to AMBResource', () => {
    const tags = [
      ['name', 'Introduction to Math'],
      ['description', 'A video about mathematics'],
      ['type', 'LearningResource'],
      ['type', 'VideoObject'],
      ['inLanguage', 'de'],
      ['creator:name', 'Dr. Example'],
      ['creator:type', 'Person'],
      ['publisher:name', 'Example University'],
      ['publisher:type', 'Organization'],
    ];

    const event = createMockEvent(tags, 'resource-1');
    const result = eventToAMBResource(event);

    expect(result).not.toBeNull();
    expect(result!.resource.name).toBe('Introduction to Math');
    expect(result!.resource.type).toEqual(['LearningResource', 'VideoObject']);
    expect(result!.resource.creator).toHaveLength(1);
    expect(result!.resource.creator![0].name).toBe('Dr. Example');
    expect(result!.resource.publisher).toHaveLength(1);
    expect(result!.resource.publisher![0].name).toBe('Example University');
    expect(result!.nostr.eventId).toBe('event123');
    expect(result!.nostr.pubkey).toBe('pubkey123');
    expect(result!.nostr.dTag).toBe('resource-1');
  });

  it('returns null for event without d-tag', () => {
    const event: NostrEvent = {
      id: 'event123',
      pubkey: 'pubkey123',
      created_at: 1700000000,
      kind: 30142,
      tags: [['name', 'Test']],
      content: 'content',
      sig: 'sig123',
    };

    const result = eventToAMBResource(event);
    expect(result).toBeNull();
  });

  it('returns null for event without name tag', () => {
    const event: NostrEvent = {
      id: 'event123',
      pubkey: 'pubkey123',
      created_at: 1700000000,
      kind: 30142,
      tags: [['d', 'resource-1']],
      content: 'content',
      sig: 'sig123',
    };

    const result = eventToAMBResource(event);
    expect(result).toBeNull();
  });

  it('extracts educational metadata from tags', () => {
    const tags = [
      ['name', 'Test Resource'],
      ['about:id', 'https://example.org/subject/math'],
      ['about:prefLabel:de', 'Mathematik'],
      ['learningResourceType:id', 'https://example.org/type/video'],
      ['learningResourceType:prefLabel:de', 'Video'],
      ['license:id', 'https://creativecommons.org/licenses/by/4.0/'],
      ['isAccessibleForFree', 'true'],
      ['datePublished', '2024-01-15'],
    ];

    const event = createMockEvent(tags, 'resource-1');
    const result = eventToAMBResource(event);

    expect(result).not.toBeNull();
    expect(result!.resource.about).toHaveLength(1);
    expect(result!.resource.about![0].id).toBe('https://example.org/subject/math');
    expect(result!.resource.learningResourceType).toHaveLength(1);
    expect(result!.resource.license?.id).toBe('https://creativecommons.org/licenses/by/4.0/');
    expect(result!.resource.isAccessibleForFree).toBe(true);
    expect(result!.resource.datePublished).toBe('2024-01-15');
  });
});

describe('eventsToAMBResources', () => {
  it('transforms multiple events and filters invalid ones', () => {
    const validEvent = createMockEvent(
      [['name', 'Resource 1']],
      'resource-1'
    );
    const invalidEvent: NostrEvent = {
      id: 'event2',
      pubkey: 'pubkey2',
      created_at: 1700000000,
      kind: 30142,
      tags: [], // Missing d-tag and name
      content: 'content',
      sig: 'sig2',
    };

    const results = eventsToAMBResources([validEvent, invalidEvent]);
    expect(results).toHaveLength(1);
    expect(results[0].resource.name).toBe('Resource 1');
  });
});

describe('toSimplifiedResource', () => {
  it('extracts key fields for MCP response', () => {
    const tags = [
      ['name', 'Introduction to Math'],
      ['description', 'A video about mathematics'],
      ['type', 'LearningResource'],
      ['type', 'VideoObject'],
      ['inLanguage', 'de'],
      ['inLanguage', 'en'],
      ['learningResourceType:id', 'https://w3id.org/kim/hcrt/video'],
      ['learningResourceType:prefLabel:de', 'Video'],
      ['about:id', 'https://w3id.org/kim/schulfaecher/s1017'],
      ['about:prefLabel:de', 'Mathematik'],
      ['creator:name', 'Dr. Example'],
      ['creator:type', 'Person'],
      ['publisher:name', 'Example University'],
      ['publisher:type', 'Organization'],
      ['license:id', 'https://creativecommons.org/licenses/by/4.0/'],
      ['isAccessibleForFree', 'true'],
      ['datePublished', '2024-01-15'],
    ];

    const event = createMockEvent(tags, 'resource-1');
    const ambResource = eventToAMBResource(event)!;
    const simplified = toSimplifiedResource(ambResource);

    expect(simplified.id).toBe('resource-1');
    expect(simplified.identifier).toBe('resource-1');
    expect(simplified.name).toBe('Introduction to Math');
    expect(simplified.type).toEqual(['LearningResource', 'VideoObject']);
    expect(simplified.inLanguage).toEqual(['de', 'en']);
    expect(simplified.learningResourceType).toHaveLength(1);
    expect(simplified.about).toHaveLength(1);
    expect(simplified.creator).toHaveLength(1);
    expect(simplified.creator![0].name).toBe('Dr. Example');
    expect(simplified.publisher).toHaveLength(1);
    expect(simplified.publisher![0].name).toBe('Example University');
    expect(simplified.license?.id).toBe('https://creativecommons.org/licenses/by/4.0/');
    expect(simplified.isAccessibleForFree).toBe(true);
    expect(simplified.datePublished).toBe('2024-01-15');
    expect(simplified.nostr.eventId).toBe('event123');
  });
});
