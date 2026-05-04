/**
 * Event Builders
 *
 * Helpers for constructing unsigned Nostr events.
 * These build event templates that can be signed by a signer.
 */

import type { UnsignedEvent } from './manager.js';

/**
 * Metadata for NIP-01 kind 0 profile events
 */
export interface ProfileMetadata {
  name?: string;
  about?: string;
  picture?: string;
  banner?: string;
  nip05?: string;
  lud16?: string;
  website?: string;
  [key: string]: string | undefined;
}

/**
 * Entity (creator or publisher) for AMB resources
 */
export interface AMBEntity {
  name: string;
  type?: string;  // Default: 'Person'
  id?: string;    // URL or identifier
}

/**
 * Concept reference (for subjects, resource types, educational levels)
 */
export interface AMBConcept {
  id: string;  // URI of the concept
  prefLabel?: Record<string, string>;  // Localized labels (lang -> label)
}

/**
 * Input for building AMB resource events (kind 30142)
 */
export interface AMBResourceInput {
  /** Unique identifier (d-tag) - required */
  identifier: string;

  /** Resource name/title - required */
  name: string;

  /** Resource description */
  description?: string;

  /** Resource URL */
  url?: string;

  /** Image/thumbnail URL */
  image?: string;

  /** Resource types (schema.org types like LearningResource, VideoObject, etc.) */
  type?: string[];

  /** Language codes (ISO 639-1) */
  inLanguage?: string[];

  /** Subject/topic concepts */
  about?: AMBConcept[];

  /** Learning resource type concepts (from HCRT vocabulary) */
  learningResourceType?: AMBConcept[];

  /** Educational level concepts */
  educationalLevel?: AMBConcept[];

  /** Target audience concepts */
  audience?: AMBConcept[];

  /** Content creators */
  creator?: AMBEntity[];

  /** Publishers */
  publisher?: AMBEntity[];

  /** License information */
  license?: {
    id: string;   // License URL
    name?: string; // License name
  };

  /** Is the resource free to access */
  isAccessibleForFree?: boolean;

  /** Publication date (ISO 8601) */
  datePublished?: string;

  /** Creation date (ISO 8601) */
  dateCreated?: string;

  /** Last modified date (ISO 8601) */
  dateModified?: string;
}

/**
 * Build a kind 0 (metadata/profile) event
 *
 * @param pubkey - Public key of the profile owner
 * @param metadata - Profile metadata fields
 */
export function buildMetadataEvent(
  pubkey: string,
  metadata: ProfileMetadata
): UnsignedEvent {
  // Filter out undefined values
  const cleanMetadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined) {
      cleanMetadata[key] = value;
    }
  }

  return {
    kind: 0,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify(cleanMetadata),
  };
}

/**
 * Build tags for concept references
 */
function buildConceptTags(prefix: string, concepts: AMBConcept[]): string[][] {
  const tags: string[][] = [];

  for (const concept of concepts) {
    // Add concept ID
    tags.push([`${prefix}:id`, concept.id]);

    // Add localized labels
    if (concept.prefLabel) {
      for (const [lang, label] of Object.entries(concept.prefLabel)) {
        tags.push([`${prefix}:prefLabel:${lang}`, label]);
      }
    }
  }

  return tags;
}

/**
 * Build tags for entity references (creator, publisher)
 */
function buildEntityTags(prefix: string, entities: AMBEntity[]): string[][] {
  const tags: string[][] = [];

  for (const entity of entities) {
    tags.push([`${prefix}:name`, entity.name]);

    if (entity.type) {
      tags.push([`${prefix}:type`, entity.type]);
    }

    if (entity.id) {
      tags.push([`${prefix}:id`, entity.id]);
    }
  }

  return tags;
}

/**
 * Build a kind 30142 (AMB educational resource) event
 *
 * @param pubkey - Public key of the publisher
 * @param resource - Resource data
 */
export function buildAMBResourceEvent(
  pubkey: string,
  resource: AMBResourceInput
): UnsignedEvent {
  const tags: string[][] = [];

  // Required: d-tag (identifier)
  tags.push(['d', resource.identifier]);

  // Required: name
  tags.push(['name', resource.name]);

  // Optional string fields
  if (resource.description) {
    tags.push(['description', resource.description]);
  }
  if (resource.url) {
    tags.push(['url', resource.url]);
  }
  if (resource.image) {
    tags.push(['image', resource.image]);
  }

  // Types
  if (resource.type && resource.type.length > 0) {
    for (const type of resource.type) {
      tags.push(['type', type]);
    }
  }

  // Languages
  if (resource.inLanguage && resource.inLanguage.length > 0) {
    for (const lang of resource.inLanguage) {
      tags.push(['inLanguage', lang]);
    }
  }

  // Concepts
  if (resource.about && resource.about.length > 0) {
    tags.push(...buildConceptTags('about', resource.about));
  }
  if (resource.learningResourceType && resource.learningResourceType.length > 0) {
    tags.push(...buildConceptTags('learningResourceType', resource.learningResourceType));
  }
  if (resource.educationalLevel && resource.educationalLevel.length > 0) {
    tags.push(...buildConceptTags('educationalLevel', resource.educationalLevel));
  }
  if (resource.audience && resource.audience.length > 0) {
    tags.push(...buildConceptTags('audience', resource.audience));
  }

  // Entities
  if (resource.creator && resource.creator.length > 0) {
    tags.push(...buildEntityTags('creator', resource.creator));
  }
  if (resource.publisher && resource.publisher.length > 0) {
    tags.push(...buildEntityTags('publisher', resource.publisher));
  }

  // License
  if (resource.license) {
    tags.push(['license:id', resource.license.id]);
    if (resource.license.name) {
      tags.push(['license:name', resource.license.name]);
    }
  }

  // Access
  if (resource.isAccessibleForFree !== undefined) {
    tags.push(['isAccessibleForFree', resource.isAccessibleForFree ? 'true' : 'false']);
  }

  // Dates
  if (resource.datePublished) {
    tags.push(['datePublished', resource.datePublished]);
  }
  if (resource.dateCreated) {
    tags.push(['dateCreated', resource.dateCreated]);
  }
  if (resource.dateModified) {
    tags.push(['dateModified', resource.dateModified]);
  }

  return {
    kind: 30142,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',  // AMB events use tags, not content
  };
}

/**
 * Build a generic event from a template
 *
 * @param pubkey - Public key of the event author
 * @param template - Event template
 */
export function buildEvent(
  pubkey: string,
  template: {
    kind: number;
    content: string;
    tags?: string[][];
  }
): UnsignedEvent {
  return {
    kind: template.kind,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: template.tags || [],
    content: template.content,
  };
}
