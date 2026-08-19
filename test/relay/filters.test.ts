import { describe, it, expect } from 'vitest';
import { buildFilter, buildGetFilter } from '../../src/relay/filters.js';

describe('buildFilter', () => {
  it('builds a basic filter with default limit', () => {
    const result = buildFilter({});
    expect(result.filter.kinds).toEqual([30142]);
    expect(result.filter.limit).toBe(20);
    expect(result.search).toBe('');
  });

  it('includes free-text query in search string', () => {
    const result = buildFilter({ query: 'mathematik' });
    expect(result.search).toBe('mathematik');
  });

  it('builds publisher name filter', () => {
    const result = buildFilter({ publisherName: 'e-teaching.org' });
    expect(result.search).toBe('publisher.name:e-teaching.org');
  });

  it('builds subject label filter with language', () => {
    const result = buildFilter({ subjectLabel: 'Mathematik', language: 'de' });
    expect(result.search).toBe('about.prefLabel.de:Mathematik');
  });

  it('builds subject label filter with default language', () => {
    const result = buildFilter({ subjectLabel: 'Mathematik' });
    expect(result.search).toBe('about.prefLabel.de:Mathematik');
  });

  it('builds resource type filter', () => {
    const result = buildFilter({ resourceTypeLabel: 'Video', language: 'de' });
    expect(result.search).toBe('learningResourceType.prefLabel.de:Video');
  });

  it('builds educational level filter', () => {
    const result = buildFilter({ educationalLevelLabel: 'Hochschule', language: 'de' });
    expect(result.search).toBe('educationalLevel.prefLabel.de:Hochschule');
  });

  it('builds creator name filter, quoting the spaced value', () => {
    const result = buildFilter({ creatorName: 'Dr. Example' });
    expect(result.search).toBe('creator.name:"Dr. Example"');
  });

  it('quotes publisher names containing spaces so the relay parses them as one filter value', () => {
    const result = buildFilter({ publisherName: 'LEHRE LADEN' });
    expect(result.search).toBe('publisher.name:"LEHRE LADEN"');
  });

  it('quotes multi-word label values', () => {
    const result = buildFilter({ educationalLevelLabel: 'Sekundarstufe I' });
    expect(result.search).toBe('educationalLevel.prefLabel.de:"Sekundarstufe I"');
  });

  it('leaves single-word values unquoted', () => {
    const result = buildFilter({ publisherName: 'e-teaching.org' });
    expect(result.search).toBe('publisher.name:e-teaching.org');
  });

  it('strips embedded double quotes that would break the relay tokenizer', () => {
    const result = buildFilter({ publisherName: 'LEHRE "LADEN"' });
    expect(result.search).toBe('publisher.name:"LEHRE LADEN"');
  });

  it('combines multiple filters in search string', () => {
    const result = buildFilter({
      query: 'forschung',
      publisherName: 'e-teaching.org',
      resourceTypeLabel: 'Video',
    });
    expect(result.search).toContain('forschung');
    expect(result.search).toContain('publisher.name:e-teaching.org');
    expect(result.search).toContain('learningResourceType.prefLabel.de:Video');
  });

  it('includes since/until in NIP-01 filter', () => {
    const result = buildFilter({ since: 1700000000, until: 1800000000 });
    expect(result.filter.since).toBe(1700000000);
    expect(result.filter.until).toBe(1800000000);
  });

  it('includes authors in NIP-01 filter', () => {
    const result = buildFilter({ authors: ['abc123', 'def456'] });
    expect(result.filter.authors).toEqual(['abc123', 'def456']);
  });

  it('respects limit bounds', () => {
    expect(buildFilter({ limit: 0 }).filter.limit).toBe(1);
    expect(buildFilter({ limit: 500 }).filter.limit).toBe(250);
    expect(buildFilter({ limit: 100 }).filter.limit).toBe(100);
  });
});

describe('buildGetFilter', () => {
  it('builds filter for d-tag lookup', () => {
    const filter = buildGetFilter('resource-123');
    expect(filter.kinds).toEqual([30142]);
    expect(filter['#d']).toEqual(['resource-123']);
    expect(filter.limit).toBe(1);
    expect(filter.authors).toBeUndefined();
  });

  it('includes author when provided', () => {
    const filter = buildGetFilter('resource-123', 'author-pubkey');
    expect(filter['#d']).toEqual(['resource-123']);
    expect(filter.authors).toEqual(['author-pubkey']);
  });
});
