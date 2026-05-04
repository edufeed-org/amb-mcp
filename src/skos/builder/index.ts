/**
 * SKOS Vocabulary Builder
 *
 * Tools for creating SKOS vocabularies conversationally.
 */

// Types
export type {
  VocabularyBuilderState,
  CreateVocabularyOptions,
  AddConceptOptions,
  SetRelationshipOptions,
  AddMappingOptions,
  UpdateConceptOptions,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  ValidationErrorType,
  ValidationWarningType,
  VocabularySummary,
} from './types.js';

// State management
export { vocabularyStore } from './state.js';

// Builder operations
export {
  createVocabulary,
  addConcept,
  setConceptRelationship,
  addConceptMapping,
  updateConcept,
  removeConcept,
  validateVocabulary,
  getVocabularyState,
  deleteVocabulary,
} from './builder.js';

// Turtle serialization
export { serializeToTurtle } from './turtle.js';

// Turtle import
export { importTurtle } from './turtle-import.js';
export type { ImportResult } from './turtle-import.js';
