/**
 * SKOS (Simple Knowledge Organization System) type definitions
 * Based on W3C SKOS specification: https://www.w3.org/TR/skos-reference/
 */

/**
 * Localized string map (language code -> value)
 */
export type LocalizedString = Record<string, string>;

/**
 * SKOS Concept Scheme - a collection of concepts
 */
export interface SKOSConceptScheme {
  id: string;
  type: 'ConceptScheme';
  title: LocalizedString;
  description?: LocalizedString;
  hasTopConcept: SKOSConcept[];
  issued?: string;
  modified?: string;
  creator?: string;
  publisher?: string;
  license?: string;
  preferredNamespaceUri?: string;
  preferredNamespacePrefix?: string;
}

/**
 * SKOS Concept - a unit of thought
 */
export interface SKOSConcept {
  id: string;
  type: 'Concept';
  inScheme?: string;

  // Labels
  notation?: string[];
  prefLabel: LocalizedString;
  altLabel?: LocalizedString[];
  hiddenLabel?: LocalizedString[];

  // Documentation
  definition?: LocalizedString;
  example?: LocalizedString;
  note?: LocalizedString;
  scopeNote?: LocalizedString;
  historyNote?: LocalizedString;
  editorialNote?: LocalizedString;
  changeNote?: LocalizedString;

  // Semantic relations
  broader?: SKOSConceptRef[];
  narrower?: SKOSConceptRef[];
  related?: SKOSConceptRef[];

  // Mapping relations
  exactMatch?: string[];
  closeMatch?: string[];
  broadMatch?: string[];
  narrowMatch?: string[];
  relatedMatch?: string[];

  // Status
  deprecated?: boolean;
  isReplacedBy?: string;
}

/**
 * Reference to a concept (can be full concept or just ID)
 */
export type SKOSConceptRef = SKOSConcept | string;

/**
 * Parsed vocabulary with flattened concept lookup
 */
export interface ParsedVocabulary {
  scheme: SKOSConceptScheme;
  concepts: Map<string, SKOSConcept>;
}

/**
 * Raw JSON-LD structure from skohub (for parsing)
 */
export interface RawSkohubVocabulary {
  '@context': unknown;
  id: string;
  type: string;
  title?: LocalizedString;
  description?: LocalizedString;
  hasTopConcept?: RawSkohubConcept[];
  issued?: string;
  modified?: string;
  creator?: unknown;
  publisher?: unknown;
  license?: string;
  preferredNamespaceUri?: string;
  preferredNamespacePrefix?: string;
}

export interface RawSkohubConcept {
  id?: string;
  type?: string;
  notation?: string[];
  prefLabel?: LocalizedString;
  altLabel?: LocalizedString | LocalizedString[];
  definition?: LocalizedString;
  narrower?: RawSkohubConcept[];
  broader?: RawSkohubConcept[];
  related?: RawSkohubConcept[];
  deprecated?: boolean;
  isReplacedBy?: string;
  exactMatch?: string[];
  closeMatch?: string[];
  broadMatch?: string[];
  narrowMatch?: string[];
  relatedMatch?: string[];
}
