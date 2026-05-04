/**
 * SKOS Turtle importer
 *
 * Parses Turtle format and converts to VocabularyBuilderState.
 */

import { Parser, type Quad } from 'n3';
import type { VocabularyBuilderState } from './types.js';
import type { SKOSConcept, SKOSConceptScheme, LocalizedString } from '../types.js';

// RDF namespace URIs
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const DCT = 'http://purl.org/dc/terms/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

// RDF predicates
const PREDICATES = {
  type: `${RDF}type`,
  // SKOS classes
  conceptScheme: `${SKOS}ConceptScheme`,
  concept: `${SKOS}Concept`,
  // SKOS scheme properties
  hasTopConcept: `${SKOS}hasTopConcept`,
  // SKOS concept properties
  inScheme: `${SKOS}inScheme`,
  prefLabel: `${SKOS}prefLabel`,
  altLabel: `${SKOS}altLabel`,
  hiddenLabel: `${SKOS}hiddenLabel`,
  notation: `${SKOS}notation`,
  definition: `${SKOS}definition`,
  example: `${SKOS}example`,
  note: `${SKOS}note`,
  scopeNote: `${SKOS}scopeNote`,
  historyNote: `${SKOS}historyNote`,
  editorialNote: `${SKOS}editorialNote`,
  changeNote: `${SKOS}changeNote`,
  // SKOS semantic relations
  broader: `${SKOS}broader`,
  narrower: `${SKOS}narrower`,
  related: `${SKOS}related`,
  // SKOS mapping relations
  exactMatch: `${SKOS}exactMatch`,
  closeMatch: `${SKOS}closeMatch`,
  broadMatch: `${SKOS}broadMatch`,
  narrowMatch: `${SKOS}narrowMatch`,
  relatedMatch: `${SKOS}relatedMatch`,
  // DCT properties
  title: `${DCT}title`,
  description: `${DCT}description`,
  license: `${DCT}license`,
  issued: `${DCT}issued`,
  modified: `${DCT}modified`,
  creator: `${DCT}creator`,
  publisher: `${DCT}publisher`,
  isReplacedBy: `${DCT}isReplacedBy`,
} as const;

/**
 * Result of importing a Turtle file
 */
export interface ImportResult {
  success: boolean;
  state?: VocabularyBuilderState;
  error?: string;
}

/**
 * Import a SKOS vocabulary from Turtle format
 */
export function importTurtle(
  turtleContent: string,
  userPubkey: string
): ImportResult {
  try {
    const parser = new Parser();
    const quads = parser.parse(turtleContent);

    // Group quads by subject
    const quadsBySubject = groupQuadsBySubject(quads);

    // Find the ConceptScheme
    const schemeUri = findConceptScheme(quadsBySubject);
    if (!schemeUri) {
      return { success: false, error: 'No skos:ConceptScheme found in Turtle' };
    }

    // Build the scheme
    const scheme = buildScheme(schemeUri, quadsBySubject);

    // Find all Concepts
    const conceptUris = findConcepts(quadsBySubject);

    // Build concepts map
    const concepts = new Map<string, SKOSConcept>();
    for (const uri of conceptUris) {
      const concept = buildConcept(uri, schemeUri, quadsBySubject);
      concepts.set(uri, concept);
    }

    // Link concepts to scheme's hasTopConcept
    const topConceptUris = getObjects(quadsBySubject, schemeUri, PREDICATES.hasTopConcept);
    scheme.hasTopConcept = topConceptUris
      .map((uri) => concepts.get(uri))
      .filter((c): c is SKOSConcept => c !== undefined);

    // Build state
    const now = Date.now();
    const state: VocabularyBuilderState = {
      owner: userPubkey,
      scheme,
      concepts,
      createdAt: now,
      modifiedAt: now,
    };

    return { success: true, state };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown parse error',
    };
  }
}

/**
 * Group quads by subject URI
 */
function groupQuadsBySubject(quads: Quad[]): Map<string, Quad[]> {
  const grouped = new Map<string, Quad[]>();
  for (const quad of quads) {
    const subject = quad.subject.value;
    const existing = grouped.get(subject) || [];
    existing.push(quad);
    grouped.set(subject, existing);
  }
  return grouped;
}

/**
 * Find the ConceptScheme URI
 */
function findConceptScheme(quadsBySubject: Map<string, Quad[]>): string | undefined {
  for (const [subject, quads] of quadsBySubject) {
    for (const quad of quads) {
      if (
        quad.predicate.value === PREDICATES.type &&
        quad.object.value === PREDICATES.conceptScheme
      ) {
        return subject;
      }
    }
  }
  return undefined;
}

/**
 * Find all Concept URIs
 */
function findConcepts(quadsBySubject: Map<string, Quad[]>): string[] {
  const concepts: string[] = [];
  for (const [subject, quads] of quadsBySubject) {
    for (const quad of quads) {
      if (
        quad.predicate.value === PREDICATES.type &&
        quad.object.value === PREDICATES.concept
      ) {
        concepts.push(subject);
        break;
      }
    }
  }
  return concepts;
}

/**
 * Get all objects for a given subject and predicate
 */
function getObjects(
  quadsBySubject: Map<string, Quad[]>,
  subject: string,
  predicate: string
): string[] {
  const quads = quadsBySubject.get(subject) || [];
  return quads
    .filter((q) => q.predicate.value === predicate)
    .map((q) => q.object.value);
}

/**
 * Get a single object for a given subject and predicate
 */
function getObject(
  quadsBySubject: Map<string, Quad[]>,
  subject: string,
  predicate: string
): string | undefined {
  const objects = getObjects(quadsBySubject, subject, predicate);
  return objects[0];
}

/**
 * Extract localized strings from quads (language-tagged literals)
 */
function getLocalizedStrings(
  quadsBySubject: Map<string, Quad[]>,
  subject: string,
  predicate: string
): LocalizedString {
  const quads = quadsBySubject.get(subject) || [];
  const result: LocalizedString = {};

  for (const quad of quads) {
    if (quad.predicate.value === predicate) {
      const obj = quad.object;
      if (obj.termType === 'Literal') {
        const lang = obj.language || 'und';
        result[lang] = obj.value;
      }
    }
  }

  return result;
}

/**
 * Extract all localized string arrays (for altLabel, hiddenLabel)
 */
function getLocalizedStringArray(
  quadsBySubject: Map<string, Quad[]>,
  subject: string,
  predicate: string
): LocalizedString[] {
  const quads = quadsBySubject.get(subject) || [];
  const result: LocalizedString[] = [];

  for (const quad of quads) {
    if (quad.predicate.value === predicate) {
      const obj = quad.object;
      if (obj.termType === 'Literal') {
        const lang = obj.language || 'und';
        result.push({ [lang]: obj.value });
      }
    }
  }

  return result;
}

/**
 * Extract plain string literals (for notation)
 */
function getStringLiterals(
  quadsBySubject: Map<string, Quad[]>,
  subject: string,
  predicate: string
): string[] {
  const quads = quadsBySubject.get(subject) || [];
  return quads
    .filter(
      (q) => q.predicate.value === predicate && q.object.termType === 'Literal'
    )
    .map((q) => q.object.value);
}

/**
 * Build a ConceptScheme from quads
 */
function buildScheme(
  schemeUri: string,
  quadsBySubject: Map<string, Quad[]>
): SKOSConceptScheme {
  const title = getLocalizedStrings(quadsBySubject, schemeUri, PREDICATES.title);
  const description = getLocalizedStrings(
    quadsBySubject,
    schemeUri,
    PREDICATES.description
  );

  const scheme: SKOSConceptScheme = {
    id: schemeUri,
    type: 'ConceptScheme',
    title: Object.keys(title).length > 0 ? title : { und: schemeUri },
    hasTopConcept: [], // Will be populated later
  };

  // Optional properties
  if (Object.keys(description).length > 0) {
    scheme.description = description;
  }

  const license = getObject(quadsBySubject, schemeUri, PREDICATES.license);
  if (license) scheme.license = license;

  const issued = getObject(quadsBySubject, schemeUri, PREDICATES.issued);
  if (issued) scheme.issued = issued;

  const modified = getObject(quadsBySubject, schemeUri, PREDICATES.modified);
  if (modified) scheme.modified = modified;

  const creator = getObject(quadsBySubject, schemeUri, PREDICATES.creator);
  if (creator) scheme.creator = creator;

  const publisher = getObject(quadsBySubject, schemeUri, PREDICATES.publisher);
  if (publisher) scheme.publisher = publisher;

  return scheme;
}

/**
 * Build a Concept from quads
 */
function buildConcept(
  conceptUri: string,
  schemeUri: string,
  quadsBySubject: Map<string, Quad[]>
): SKOSConcept {
  const prefLabel = getLocalizedStrings(
    quadsBySubject,
    conceptUri,
    PREDICATES.prefLabel
  );

  const concept: SKOSConcept = {
    id: conceptUri,
    type: 'Concept',
    inScheme: schemeUri,
    prefLabel: Object.keys(prefLabel).length > 0 ? prefLabel : { und: conceptUri },
  };

  // Labels
  const altLabel = getLocalizedStringArray(
    quadsBySubject,
    conceptUri,
    PREDICATES.altLabel
  );
  if (altLabel.length > 0) concept.altLabel = altLabel;

  const hiddenLabel = getLocalizedStringArray(
    quadsBySubject,
    conceptUri,
    PREDICATES.hiddenLabel
  );
  if (hiddenLabel.length > 0) concept.hiddenLabel = hiddenLabel;

  const notation = getStringLiterals(
    quadsBySubject,
    conceptUri,
    PREDICATES.notation
  );
  if (notation.length > 0) concept.notation = notation;

  // Documentation
  const definition = getLocalizedStrings(
    quadsBySubject,
    conceptUri,
    PREDICATES.definition
  );
  if (Object.keys(definition).length > 0) concept.definition = definition;

  const example = getLocalizedStrings(
    quadsBySubject,
    conceptUri,
    PREDICATES.example
  );
  if (Object.keys(example).length > 0) concept.example = example;

  const note = getLocalizedStrings(quadsBySubject, conceptUri, PREDICATES.note);
  if (Object.keys(note).length > 0) concept.note = note;

  const scopeNote = getLocalizedStrings(
    quadsBySubject,
    conceptUri,
    PREDICATES.scopeNote
  );
  if (Object.keys(scopeNote).length > 0) concept.scopeNote = scopeNote;

  const historyNote = getLocalizedStrings(
    quadsBySubject,
    conceptUri,
    PREDICATES.historyNote
  );
  if (Object.keys(historyNote).length > 0) concept.historyNote = historyNote;

  const editorialNote = getLocalizedStrings(
    quadsBySubject,
    conceptUri,
    PREDICATES.editorialNote
  );
  if (Object.keys(editorialNote).length > 0) concept.editorialNote = editorialNote;

  const changeNote = getLocalizedStrings(
    quadsBySubject,
    conceptUri,
    PREDICATES.changeNote
  );
  if (Object.keys(changeNote).length > 0) concept.changeNote = changeNote;

  // Semantic relations (store as references with prefLabel for display)
  const broaderUris = getObjects(quadsBySubject, conceptUri, PREDICATES.broader);
  if (broaderUris.length > 0) {
    concept.broader = broaderUris.map((uri) => ({
      id: uri,
      type: 'Concept' as const,
      prefLabel: getLocalizedStrings(quadsBySubject, uri, PREDICATES.prefLabel),
    }));
  }

  const narrowerUris = getObjects(quadsBySubject, conceptUri, PREDICATES.narrower);
  if (narrowerUris.length > 0) {
    concept.narrower = narrowerUris.map((uri) => ({
      id: uri,
      type: 'Concept' as const,
      prefLabel: getLocalizedStrings(quadsBySubject, uri, PREDICATES.prefLabel),
    }));
  }

  const relatedUris = getObjects(quadsBySubject, conceptUri, PREDICATES.related);
  if (relatedUris.length > 0) {
    concept.related = relatedUris.map((uri) => ({
      id: uri,
      type: 'Concept' as const,
      prefLabel: getLocalizedStrings(quadsBySubject, uri, PREDICATES.prefLabel),
    }));
  }

  // Mapping relations
  const exactMatch = getObjects(quadsBySubject, conceptUri, PREDICATES.exactMatch);
  if (exactMatch.length > 0) concept.exactMatch = exactMatch;

  const closeMatch = getObjects(quadsBySubject, conceptUri, PREDICATES.closeMatch);
  if (closeMatch.length > 0) concept.closeMatch = closeMatch;

  const broadMatch = getObjects(quadsBySubject, conceptUri, PREDICATES.broadMatch);
  if (broadMatch.length > 0) concept.broadMatch = broadMatch;

  const narrowMatch = getObjects(
    quadsBySubject,
    conceptUri,
    PREDICATES.narrowMatch
  );
  if (narrowMatch.length > 0) concept.narrowMatch = narrowMatch;

  const relatedMatch = getObjects(
    quadsBySubject,
    conceptUri,
    PREDICATES.relatedMatch
  );
  if (relatedMatch.length > 0) concept.relatedMatch = relatedMatch;

  // Status
  const isReplacedBy = getObject(
    quadsBySubject,
    conceptUri,
    PREDICATES.isReplacedBy
  );
  if (isReplacedBy) {
    concept.deprecated = true;
    concept.isReplacedBy = isReplacedBy;
  }

  return concept;
}
