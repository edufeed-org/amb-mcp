/**
 * SKOS Vocabulary Builder operations
 *
 * Core functions for building vocabularies: adding concepts,
 * setting relationships, managing mappings, and validation.
 */

import { vocabularyStore } from './state.js';
import type {
  VocabularyBuilderState,
  CreateVocabularyOptions,
  AddConceptOptions,
  SetRelationshipOptions,
  AddMappingOptions,
  UpdateConceptOptions,
  ValidationResult,
  ValidationError,
  ValidationWarning,
} from './types.js';
import type { SKOSConcept } from '../types.js';

/**
 * Create a new vocabulary
 */
export function createVocabulary(
  userPubkey: string,
  options: CreateVocabularyOptions
): VocabularyBuilderState {
  return vocabularyStore.create(userPubkey, options);
}

/**
 * Add a concept to a vocabulary
 */
export function addConcept(
  userPubkey: string,
  schemeUri: string,
  options: AddConceptOptions
): SKOSConcept {
  const state = vocabularyStore.get(userPubkey, schemeUri);
  if (!state) {
    throw new Error(`Vocabulary not found: ${schemeUri}`);
  }

  if (state.concepts.has(options.uri)) {
    throw new Error(`Concept already exists: ${options.uri}`);
  }

  const concept: SKOSConcept = {
    id: options.uri,
    type: 'Concept',
    inScheme: schemeUri,
    prefLabel: options.prefLabel,
    definition: options.definition,
    altLabel: options.altLabel,
    notation: options.notation,
    broader: undefined,
    narrower: undefined,
    related: undefined,
  };

  // Add to concepts map
  state.concepts.set(options.uri, concept);

  // Handle parent relationship
  if (options.broaderUri) {
    const parent = state.concepts.get(options.broaderUri);
    if (!parent) {
      throw new Error(`Parent concept not found: ${options.broaderUri}`);
    }

    // Set broader on child
    concept.broader = [{ id: parent.id, type: 'Concept', prefLabel: parent.prefLabel }];

    // Set narrower on parent
    if (!parent.narrower) {
      parent.narrower = [];
    }
    parent.narrower.push({ id: concept.id, type: 'Concept', prefLabel: concept.prefLabel });
  } else {
    // Top concept - add to scheme
    state.scheme.hasTopConcept.push(concept);
  }

  vocabularyStore.touch(userPubkey, schemeUri);
  return concept;
}

/**
 * Set a relationship between two concepts
 */
export function setConceptRelationship(
  userPubkey: string,
  schemeUri: string,
  options: SetRelationshipOptions
): void {
  const state = vocabularyStore.get(userPubkey, schemeUri);
  if (!state) {
    throw new Error(`Vocabulary not found: ${schemeUri}`);
  }

  const source = state.concepts.get(options.sourceUri);
  const target = state.concepts.get(options.targetUri);

  if (!source) {
    throw new Error(`Source concept not found: ${options.sourceUri}`);
  }
  if (!target) {
    throw new Error(`Target concept not found: ${options.targetUri}`);
  }

  if (options.sourceUri === options.targetUri) {
    throw new Error('Cannot create relationship to self');
  }

  const sourceRef = { id: source.id, type: 'Concept' as const, prefLabel: source.prefLabel };
  const targetRef = { id: target.id, type: 'Concept' as const, prefLabel: target.prefLabel };

  switch (options.relationship) {
    case 'broader':
      if (!source.broader) source.broader = [];
      if (!source.broader.some((b) => (typeof b === 'string' ? b : b.id) === target.id)) {
        source.broader.push(targetRef);
      }
      // Also add inverse narrower
      if (!target.narrower) target.narrower = [];
      if (!target.narrower.some((n) => (typeof n === 'string' ? n : n.id) === source.id)) {
        target.narrower.push(sourceRef);
      }
      // Remove from top concepts if it was there
      state.scheme.hasTopConcept = state.scheme.hasTopConcept.filter((c) => c.id !== source.id);
      break;

    case 'narrower':
      if (!source.narrower) source.narrower = [];
      if (!source.narrower.some((n) => (typeof n === 'string' ? n : n.id) === target.id)) {
        source.narrower.push(targetRef);
      }
      // Also add inverse broader
      if (!target.broader) target.broader = [];
      if (!target.broader.some((b) => (typeof b === 'string' ? b : b.id) === source.id)) {
        target.broader.push(sourceRef);
      }
      // Remove target from top concepts if it was there
      state.scheme.hasTopConcept = state.scheme.hasTopConcept.filter((c) => c.id !== target.id);
      break;

    case 'related':
      // Related is symmetric
      if (!source.related) source.related = [];
      if (!source.related.some((r) => (typeof r === 'string' ? r : r.id) === target.id)) {
        source.related.push(targetRef);
      }
      if (!target.related) target.related = [];
      if (!target.related.some((r) => (typeof r === 'string' ? r : r.id) === source.id)) {
        target.related.push(sourceRef);
      }
      break;
  }

  vocabularyStore.touch(userPubkey, schemeUri);
}

/**
 * Add a mapping from a concept to an external concept
 */
export function addConceptMapping(
  userPubkey: string,
  schemeUri: string,
  options: AddMappingOptions
): void {
  const state = vocabularyStore.get(userPubkey, schemeUri);
  if (!state) {
    throw new Error(`Vocabulary not found: ${schemeUri}`);
  }

  const concept = state.concepts.get(options.conceptUri);
  if (!concept) {
    throw new Error(`Concept not found: ${options.conceptUri}`);
  }

  switch (options.mappingType) {
    case 'exactMatch':
      if (!concept.exactMatch) concept.exactMatch = [];
      if (!concept.exactMatch.includes(options.targetUri)) {
        concept.exactMatch.push(options.targetUri);
      }
      break;
    case 'closeMatch':
      if (!concept.closeMatch) concept.closeMatch = [];
      if (!concept.closeMatch.includes(options.targetUri)) {
        concept.closeMatch.push(options.targetUri);
      }
      break;
    case 'broadMatch':
      if (!concept.broadMatch) concept.broadMatch = [];
      if (!concept.broadMatch.includes(options.targetUri)) {
        concept.broadMatch.push(options.targetUri);
      }
      break;
    case 'narrowMatch':
      if (!concept.narrowMatch) concept.narrowMatch = [];
      if (!concept.narrowMatch.includes(options.targetUri)) {
        concept.narrowMatch.push(options.targetUri);
      }
      break;
    case 'relatedMatch':
      if (!concept.relatedMatch) concept.relatedMatch = [];
      if (!concept.relatedMatch.includes(options.targetUri)) {
        concept.relatedMatch.push(options.targetUri);
      }
      break;
  }

  vocabularyStore.touch(userPubkey, schemeUri);
}

/**
 * Update an existing concept
 */
export function updateConcept(
  userPubkey: string,
  schemeUri: string,
  conceptUri: string,
  updates: UpdateConceptOptions
): SKOSConcept {
  const state = vocabularyStore.get(userPubkey, schemeUri);
  if (!state) {
    throw new Error(`Vocabulary not found: ${schemeUri}`);
  }

  const concept = state.concepts.get(conceptUri);
  if (!concept) {
    throw new Error(`Concept not found: ${conceptUri}`);
  }

  if (updates.prefLabel) {
    concept.prefLabel = updates.prefLabel;
  }
  if (updates.definition !== undefined) {
    concept.definition = updates.definition;
  }
  if (updates.altLabel !== undefined) {
    concept.altLabel = updates.altLabel;
  }
  if (updates.notation !== undefined) {
    concept.notation = updates.notation;
  }

  vocabularyStore.touch(userPubkey, schemeUri);
  return concept;
}

/**
 * Remove a concept from a vocabulary
 */
export function removeConcept(
  userPubkey: string,
  schemeUri: string,
  conceptUri: string
): boolean {
  const state = vocabularyStore.get(userPubkey, schemeUri);
  if (!state) {
    throw new Error(`Vocabulary not found: ${schemeUri}`);
  }

  const concept = state.concepts.get(conceptUri);
  if (!concept) {
    return false;
  }

  // Remove from other concepts' relationships
  for (const other of state.concepts.values()) {
    if (other.broader) {
      other.broader = other.broader.filter(
        (b) => (typeof b === 'string' ? b : b.id) !== conceptUri
      );
      if (other.broader.length === 0) other.broader = undefined;
    }
    if (other.narrower) {
      other.narrower = other.narrower.filter(
        (n) => (typeof n === 'string' ? n : n.id) !== conceptUri
      );
      if (other.narrower.length === 0) other.narrower = undefined;
    }
    if (other.related) {
      other.related = other.related.filter(
        (r) => (typeof r === 'string' ? r : r.id) !== conceptUri
      );
      if (other.related.length === 0) other.related = undefined;
    }
  }

  // Remove from top concepts
  state.scheme.hasTopConcept = state.scheme.hasTopConcept.filter((c) => c.id !== conceptUri);

  // Delete the concept
  state.concepts.delete(conceptUri);

  vocabularyStore.touch(userPubkey, schemeUri);
  return true;
}

/**
 * Validate a vocabulary
 */
export function validateVocabulary(
  userPubkey: string,
  schemeUri: string
): ValidationResult {
  const state = vocabularyStore.get(userPubkey, schemeUri);
  if (!state) {
    throw new Error(`Vocabulary not found: ${schemeUri}`);
  }

  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // Check for top concepts
  if (state.scheme.hasTopConcept.length === 0) {
    warnings.push({
      type: 'no_top_concepts',
      message: 'Vocabulary has no top concepts',
    });
  }

  // Track max depth and mapping count
  let maxDepth = 0;
  let mappingCount = 0;

  // Validate each concept
  for (const concept of state.concepts.values()) {
    // Check for prefLabel
    if (!concept.prefLabel || Object.keys(concept.prefLabel).length === 0) {
      errors.push({
        type: 'missing_preflabel',
        conceptUri: concept.id,
        message: `Concept ${concept.id} has no prefLabel`,
      });
    }

    // Check for definition
    if (!concept.definition || Object.keys(concept.definition).length === 0) {
      warnings.push({
        type: 'missing_definition',
        conceptUri: concept.id,
        message: `Concept ${concept.id} has no definition`,
      });
    }

    // Validate references
    if (concept.broader) {
      for (const broader of concept.broader) {
        const id = typeof broader === 'string' ? broader : broader.id;
        if (!state.concepts.has(id)) {
          errors.push({
            type: 'unresolved_reference',
            conceptUri: concept.id,
            message: `Concept ${concept.id} references non-existent broader concept ${id}`,
          });
        }
        if (id === concept.id) {
          errors.push({
            type: 'self_reference',
            conceptUri: concept.id,
            message: `Concept ${concept.id} references itself as broader`,
          });
        }
      }
    }

    if (concept.narrower) {
      for (const narrower of concept.narrower) {
        const id = typeof narrower === 'string' ? narrower : narrower.id;
        if (!state.concepts.has(id)) {
          errors.push({
            type: 'unresolved_reference',
            conceptUri: concept.id,
            message: `Concept ${concept.id} references non-existent narrower concept ${id}`,
          });
        }
      }
    }

    if (concept.related) {
      for (const related of concept.related) {
        const id = typeof related === 'string' ? related : related.id;
        if (!state.concepts.has(id)) {
          errors.push({
            type: 'unresolved_reference',
            conceptUri: concept.id,
            message: `Concept ${concept.id} references non-existent related concept ${id}`,
          });
        }
      }
    }

    // Count mappings
    mappingCount +=
      (concept.exactMatch?.length || 0) +
      (concept.closeMatch?.length || 0) +
      (concept.broadMatch?.length || 0) +
      (concept.narrowMatch?.length || 0) +
      (concept.relatedMatch?.length || 0);
  }

  // Calculate max depth (simple BFS from top concepts)
  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = state.scheme.hasTopConcept.map((c) => ({
    id: c.id,
    depth: 0,
  }));

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);

    maxDepth = Math.max(maxDepth, depth);

    const concept = state.concepts.get(id);
    if (concept?.narrower) {
      for (const narrower of concept.narrower) {
        const narrowerId = typeof narrower === 'string' ? narrower : narrower.id;
        if (!visited.has(narrowerId)) {
          queue.push({ id: narrowerId, depth: depth + 1 });
        }
      }
    }
  }

  // Check for circular hierarchy
  const checkCircular = (conceptId: string, ancestors: Set<string>): boolean => {
    if (ancestors.has(conceptId)) return true;
    ancestors.add(conceptId);

    const concept = state.concepts.get(conceptId);
    if (concept?.narrower) {
      for (const narrower of concept.narrower) {
        const narrowerId = typeof narrower === 'string' ? narrower : narrower.id;
        if (checkCircular(narrowerId, new Set(ancestors))) {
          errors.push({
            type: 'circular_hierarchy',
            conceptUri: conceptId,
            message: `Circular hierarchy detected involving concept ${conceptId}`,
          });
          return true;
        }
      }
    }
    return false;
  };

  for (const topConcept of state.scheme.hasTopConcept) {
    checkCircular(topConcept.id, new Set());
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats: {
      conceptCount: state.concepts.size,
      topConceptCount: state.scheme.hasTopConcept.length,
      maxDepth,
      mappingCount,
    },
  };
}

/**
 * Get the current state of a vocabulary
 */
export function getVocabularyState(
  userPubkey: string,
  schemeUri: string
): VocabularyBuilderState | undefined {
  return vocabularyStore.get(userPubkey, schemeUri);
}

/**
 * Delete a vocabulary
 */
export function deleteVocabulary(userPubkey: string, schemeUri: string): boolean {
  return vocabularyStore.delete(userPubkey, schemeUri);
}

/**
 * List all vocabularies for a user
 */
export { vocabularyStore } from './state.js';
