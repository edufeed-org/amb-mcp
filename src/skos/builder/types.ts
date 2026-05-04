/**
 * SKOS Vocabulary Builder types
 */

import type { SKOSConceptScheme, SKOSConcept, LocalizedString } from '../types.js';

/**
 * State for a vocabulary being built
 */
export interface VocabularyBuilderState {
  /** The user who owns this vocabulary (pubkey or 'local') */
  owner: string;
  /** The concept scheme being built */
  scheme: SKOSConceptScheme;
  /** Flat lookup of all concepts by URI */
  concepts: Map<string, SKOSConcept>;
  /** When the vocabulary was created */
  createdAt: number;
  /** When the vocabulary was last modified */
  modifiedAt: number;
}

/**
 * Options for creating a new vocabulary
 */
export interface CreateVocabularyOptions {
  uri: string;
  title: LocalizedString;
  description?: LocalizedString;
  preferredNamespacePrefix?: string;
  license?: string;
}

/**
 * Options for adding a concept
 */
export interface AddConceptOptions {
  uri: string;
  prefLabel: LocalizedString;
  definition?: LocalizedString;
  altLabel?: LocalizedString[];
  notation?: string[];
  broaderUri?: string;
}

/**
 * Options for setting a relationship
 */
export interface SetRelationshipOptions {
  sourceUri: string;
  targetUri: string;
  relationship: 'broader' | 'narrower' | 'related';
}

/**
 * Options for adding a mapping
 */
export interface AddMappingOptions {
  conceptUri: string;
  targetUri: string;
  mappingType: 'exactMatch' | 'closeMatch' | 'broadMatch' | 'narrowMatch' | 'relatedMatch';
}

/**
 * Options for updating a concept
 */
export interface UpdateConceptOptions {
  prefLabel?: LocalizedString;
  definition?: LocalizedString;
  altLabel?: LocalizedString[];
  notation?: string[];
}

/**
 * Validation error types
 */
export type ValidationErrorType =
  | 'missing_preflabel'
  | 'unresolved_reference'
  | 'circular_hierarchy'
  | 'orphan_concept'
  | 'self_reference';

/**
 * Validation warning types
 */
export type ValidationWarningType =
  | 'invalid_mapping_uri'
  | 'missing_definition'
  | 'no_top_concepts';

/**
 * A validation error
 */
export interface ValidationError {
  type: ValidationErrorType;
  conceptUri?: string;
  message: string;
}

/**
 * A validation warning
 */
export interface ValidationWarning {
  type: ValidationWarningType;
  conceptUri?: string;
  message: string;
}

/**
 * Result of vocabulary validation
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  stats: {
    conceptCount: number;
    topConceptCount: number;
    maxDepth: number;
    mappingCount: number;
  };
}

/**
 * Summary of a vocabulary for listing
 */
export interface VocabularySummary {
  uri: string;
  title: LocalizedString;
  conceptCount: number;
  createdAt: number;
  modifiedAt: number;
}
