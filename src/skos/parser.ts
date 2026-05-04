/**
 * SKOS JSON-LD parser for skohub vocabularies
 */

import type {
  SKOSConceptScheme,
  SKOSConcept,
  ParsedVocabulary,
  RawSkohubVocabulary,
  RawSkohubConcept,
  LocalizedString,
} from './types.js';

/**
 * Parse a skohub JSON-LD vocabulary into our internal model
 */
export function parseVocabulary(raw: RawSkohubVocabulary): ParsedVocabulary {
  const concepts = new Map<string, SKOSConcept>();

  // Parse top concepts recursively
  const topConcepts = (raw.hasTopConcept || []).map((rawConcept) =>
    parseConcept(rawConcept, concepts, raw.id)
  );

  // Build broader references (reverse of narrower)
  buildBroaderReferences(concepts);

  const scheme: SKOSConceptScheme = {
    id: raw.id,
    type: 'ConceptScheme',
    title: raw.title || {},
    description: raw.description,
    hasTopConcept: topConcepts,
    issued: raw.issued,
    modified: raw.modified,
    license: raw.license,
    preferredNamespaceUri: raw.preferredNamespaceUri,
    preferredNamespacePrefix: raw.preferredNamespacePrefix,
  };

  return { scheme, concepts };
}

/**
 * Parse a single concept and its narrower concepts recursively
 */
function parseConcept(
  raw: RawSkohubConcept,
  concepts: Map<string, SKOSConcept>,
  schemeId: string
): SKOSConcept {
  const id = raw.id || '';

  // Parse narrower concepts first (recursively)
  const narrower = (raw.narrower || []).map((n) =>
    parseConcept(n, concepts, schemeId)
  );

  // Normalize altLabel to array format
  const altLabel = normalizeAltLabel(raw.altLabel);

  const concept: SKOSConcept = {
    id,
    type: 'Concept',
    inScheme: schemeId,
    notation: raw.notation,
    prefLabel: raw.prefLabel || {},
    altLabel: altLabel.length > 0 ? altLabel : undefined,
    definition: raw.definition,
    narrower: narrower.length > 0 ? narrower : undefined,
    broader: undefined, // Will be filled in by buildBroaderReferences
    related: parseConceptRefs(raw.related),
    deprecated: raw.deprecated,
    isReplacedBy: raw.isReplacedBy,
    exactMatch: raw.exactMatch,
    closeMatch: raw.closeMatch,
    broadMatch: raw.broadMatch,
    narrowMatch: raw.narrowMatch,
    relatedMatch: raw.relatedMatch,
  };

  // Add to flat lookup map
  if (id) {
    concepts.set(id, concept);
  }

  return concept;
}

/**
 * Normalize altLabel which can be a single object or array
 */
function normalizeAltLabel(
  altLabel: LocalizedString | LocalizedString[] | undefined
): LocalizedString[] {
  if (!altLabel) return [];
  if (Array.isArray(altLabel)) return altLabel;
  return [altLabel];
}

/**
 * Parse concept references (can be full concepts or just IDs)
 */
function parseConceptRefs(
  refs: RawSkohubConcept[] | undefined
): SKOSConcept[] | undefined {
  if (!refs || refs.length === 0) return undefined;
  // For related/broader, skohub usually just includes { id: "..." }
  // We'll store references as partial concepts
  return refs.map((ref) => ({
    id: ref.id || '',
    type: 'Concept' as const,
    prefLabel: ref.prefLabel || {},
  }));
}

/**
 * Build broader references by walking the narrower tree
 */
function buildBroaderReferences(concepts: Map<string, SKOSConcept>): void {
  for (const concept of concepts.values()) {
    if (concept.narrower) {
      for (const narrowerConcept of concept.narrower) {
        if (typeof narrowerConcept !== 'string') {
          const child = concepts.get(narrowerConcept.id);
          if (child) {
            if (!child.broader) {
              child.broader = [];
            }
            // Add reference to parent
            child.broader.push({
              id: concept.id,
              type: 'Concept',
              prefLabel: concept.prefLabel,
            });
          }
        }
      }
    }
  }
}

/**
 * Get a label in the preferred language, with fallbacks
 */
export function getLabel(
  labels: LocalizedString | undefined,
  language: string = 'de'
): string | undefined {
  if (!labels) return undefined;

  // Try exact match
  if (labels[language]) return labels[language];

  // Try language without region (e.g., 'de' for 'de-DE')
  const baseLang = language.split('-')[0];
  if (labels[baseLang]) return labels[baseLang];

  // Fallback to first available
  const keys = Object.keys(labels);
  if (keys.length > 0) return labels[keys[0]];

  return undefined;
}

/**
 * Search field options
 */
export type SearchField =
  | 'prefLabel'
  | 'altLabel'
  | 'hiddenLabel'
  | 'definition'
  | 'notation';

export const DEFAULT_SEARCH_FIELDS: SearchField[] = [
  'prefLabel',
  'altLabel',
  'hiddenLabel',
  'definition',
];

export interface SearchOptions {
  language?: string;
  fields?: SearchField[];
}

/**
 * Search concepts by configured fields
 */
export function searchConcepts(
  concepts: Map<string, SKOSConcept>,
  query: string,
  options: SearchOptions = {}
): SKOSConcept[] {
  const { language, fields = DEFAULT_SEARCH_FIELDS } = options;
  const queryLower = query.toLowerCase();
  const results: SKOSConcept[] = [];

  for (const concept of concepts.values()) {
    // Skip deprecated concepts in search
    if (concept.deprecated) continue;

    let matched = false;

    // Search in prefLabel
    if (fields.includes('prefLabel')) {
      if (matchInLocalizedString(concept.prefLabel, queryLower, language)) {
        matched = true;
      }
    }

    // Search in altLabels
    if (!matched && fields.includes('altLabel')) {
      if (
        concept.altLabel?.some((alt) =>
          matchInLocalizedString(alt, queryLower, language)
        )
      ) {
        matched = true;
      }
    }

    // Search in hiddenLabels
    if (!matched && fields.includes('hiddenLabel')) {
      if (
        concept.hiddenLabel?.some((hidden) =>
          matchInLocalizedString(hidden, queryLower, language)
        )
      ) {
        matched = true;
      }
    }

    // Search in definition
    if (!matched && fields.includes('definition')) {
      if (matchInLocalizedString(concept.definition, queryLower, language)) {
        matched = true;
      }
    }

    // Search in notation (exact prefix match, case-insensitive)
    if (!matched && fields.includes('notation')) {
      if (
        concept.notation?.some((n) =>
          n.toLowerCase().startsWith(queryLower)
        )
      ) {
        matched = true;
      }
    }

    if (matched) {
      results.push(concept);
    }
  }

  return results;
}

/**
 * Check if a localized string contains the query
 */
function matchInLocalizedString(
  labels: LocalizedString | undefined,
  queryLower: string,
  language?: string
): boolean {
  if (!labels) return false;

  if (language) {
    // Search only in specified language
    const label = labels[language] || labels[language.split('-')[0]];
    return label?.toLowerCase().includes(queryLower) || false;
  }

  // Search in all languages
  return Object.values(labels).some((label) =>
    label.toLowerCase().includes(queryLower)
  );
}

/**
 * Flatten a vocabulary to a simple list of concepts (for tree display)
 */
export function flattenConcepts(
  concepts: SKOSConcept[],
  depth: number = 0
): Array<{ concept: SKOSConcept; depth: number }> {
  const result: Array<{ concept: SKOSConcept; depth: number }> = [];

  for (const concept of concepts) {
    result.push({ concept, depth });

    if (concept.narrower) {
      const children = concept.narrower.filter(
        (n): n is SKOSConcept => typeof n !== 'string'
      );
      result.push(...flattenConcepts(children, depth + 1));
    }
  }

  return result;
}
