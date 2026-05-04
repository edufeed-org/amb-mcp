/**
 * SKOS module - Simple Knowledge Organization System support
 */

// Types
export type {
  LocalizedString,
  SKOSConceptScheme,
  SKOSConcept,
  SKOSConceptRef,
  ParsedVocabulary,
} from './types.js';

// Client functions
export {
  getVocabulary,
  getConcept,
  searchVocabulary,
  getCacheStats,
  clearCache,
  getLabel,
  DEFAULT_SEARCH_FIELDS,
} from './client.js';

export type { SearchField } from './client.js';

// Parser utilities
export {
  parseVocabulary,
  searchConcepts,
  flattenConcepts,
} from './parser.js';

// Cache
export { vocabularyCache, SKOSCache } from './cache.js';

// Builder
export * from './builder/index.js';
