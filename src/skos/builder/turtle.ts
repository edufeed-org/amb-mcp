/**
 * SKOS Turtle serializer
 *
 * Converts a VocabularyBuilderState to RDF Turtle format.
 */

import type { VocabularyBuilderState } from './types.js';
import type { SKOSConcept, LocalizedString, SKOSConceptRef } from '../types.js';

/**
 * Standard prefixes for SKOS vocabularies
 */
const PREFIXES = `@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
`;

/**
 * Escape special characters in Turtle strings
 */
function escapeTurtleString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Format a localized string as Turtle literals
 * Returns array of formatted literals like: "value"@lang
 */
function formatLocalizedStrings(labels: LocalizedString): string[] {
  return Object.entries(labels).map(
    ([lang, value]) => `"${escapeTurtleString(value)}"@${lang}`
  );
}

/**
 * Format a URI for Turtle output
 */
function formatUri(uri: string): string {
  return `<${uri}>`;
}

/**
 * Format an array of URIs as a comma-separated list
 */
function formatUriList(uris: string[]): string {
  return uris.map(formatUri).join(', ');
}

/**
 * Format concept references as URI list
 */
function formatConceptRefs(refs: SKOSConceptRef[]): string {
  return refs
    .map((ref) => formatUri(typeof ref === 'string' ? ref : ref.id))
    .join(', ');
}

/**
 * Serialize a concept scheme to Turtle
 */
function serializeScheme(state: VocabularyBuilderState): string {
  const lines: string[] = [];
  const scheme = state.scheme;

  lines.push(`${formatUri(scheme.id)} a skos:ConceptScheme`);

  // Title
  if (scheme.title && Object.keys(scheme.title).length > 0) {
    const titles = formatLocalizedStrings(scheme.title);
    lines.push(`    ; dct:title ${titles.join(', ')}`);
  }

  // Description
  if (scheme.description && Object.keys(scheme.description).length > 0) {
    const descriptions = formatLocalizedStrings(scheme.description);
    lines.push(`    ; dct:description ${descriptions.join(', ')}`);
  }

  // License
  if (scheme.license) {
    lines.push(`    ; dct:license ${formatUri(scheme.license)}`);
  }

  // Issued date
  if (scheme.issued) {
    lines.push(`    ; dct:issued "${scheme.issued}"^^xsd:dateTime`);
  }

  // Modified date
  if (scheme.modified) {
    lines.push(`    ; dct:modified "${scheme.modified}"^^xsd:dateTime`);
  }

  // Top concepts
  if (scheme.hasTopConcept.length > 0) {
    const topConceptUris = scheme.hasTopConcept.map((c) => formatUri(c.id)).join(', ');
    lines.push(`    ; skos:hasTopConcept ${topConceptUris}`);
  }

  lines.push('    .');

  return lines.join('\n');
}

/**
 * Serialize a single concept to Turtle
 */
function serializeConcept(concept: SKOSConcept, schemeUri: string): string {
  const lines: string[] = [];

  lines.push(`${formatUri(concept.id)} a skos:Concept`);
  lines.push(`    ; skos:inScheme ${formatUri(schemeUri)}`);

  // Preferred labels
  if (concept.prefLabel && Object.keys(concept.prefLabel).length > 0) {
    const labels = formatLocalizedStrings(concept.prefLabel);
    lines.push(`    ; skos:prefLabel ${labels.join(', ')}`);
  }

  // Alternative labels
  if (concept.altLabel && concept.altLabel.length > 0) {
    const altLabels = concept.altLabel.flatMap((alt) => formatLocalizedStrings(alt));
    if (altLabels.length > 0) {
      lines.push(`    ; skos:altLabel ${altLabels.join(', ')}`);
    }
  }

  // Hidden labels
  if (concept.hiddenLabel && concept.hiddenLabel.length > 0) {
    const hiddenLabels = concept.hiddenLabel.flatMap((hidden) =>
      formatLocalizedStrings(hidden)
    );
    if (hiddenLabels.length > 0) {
      lines.push(`    ; skos:hiddenLabel ${hiddenLabels.join(', ')}`);
    }
  }

  // Notation
  if (concept.notation && concept.notation.length > 0) {
    const notations = concept.notation.map((n) => `"${escapeTurtleString(n)}"`).join(', ');
    lines.push(`    ; skos:notation ${notations}`);
  }

  // Definition
  if (concept.definition && Object.keys(concept.definition).length > 0) {
    const definitions = formatLocalizedStrings(concept.definition);
    lines.push(`    ; skos:definition ${definitions.join(', ')}`);
  }

  // Scope note
  if (concept.scopeNote && Object.keys(concept.scopeNote).length > 0) {
    const notes = formatLocalizedStrings(concept.scopeNote);
    lines.push(`    ; skos:scopeNote ${notes.join(', ')}`);
  }

  // Example
  if (concept.example && Object.keys(concept.example).length > 0) {
    const examples = formatLocalizedStrings(concept.example);
    lines.push(`    ; skos:example ${examples.join(', ')}`);
  }

  // Note
  if (concept.note && Object.keys(concept.note).length > 0) {
    const notes = formatLocalizedStrings(concept.note);
    lines.push(`    ; skos:note ${notes.join(', ')}`);
  }

  // History note
  if (concept.historyNote && Object.keys(concept.historyNote).length > 0) {
    const notes = formatLocalizedStrings(concept.historyNote);
    lines.push(`    ; skos:historyNote ${notes.join(', ')}`);
  }

  // Editorial note
  if (concept.editorialNote && Object.keys(concept.editorialNote).length > 0) {
    const notes = formatLocalizedStrings(concept.editorialNote);
    lines.push(`    ; skos:editorialNote ${notes.join(', ')}`);
  }

  // Change note
  if (concept.changeNote && Object.keys(concept.changeNote).length > 0) {
    const notes = formatLocalizedStrings(concept.changeNote);
    lines.push(`    ; skos:changeNote ${notes.join(', ')}`);
  }

  // Broader
  if (concept.broader && concept.broader.length > 0) {
    lines.push(`    ; skos:broader ${formatConceptRefs(concept.broader)}`);
  }

  // Narrower
  if (concept.narrower && concept.narrower.length > 0) {
    lines.push(`    ; skos:narrower ${formatConceptRefs(concept.narrower)}`);
  }

  // Related
  if (concept.related && concept.related.length > 0) {
    lines.push(`    ; skos:related ${formatConceptRefs(concept.related)}`);
  }

  // Mapping relations
  if (concept.exactMatch && concept.exactMatch.length > 0) {
    lines.push(`    ; skos:exactMatch ${formatUriList(concept.exactMatch)}`);
  }

  if (concept.closeMatch && concept.closeMatch.length > 0) {
    lines.push(`    ; skos:closeMatch ${formatUriList(concept.closeMatch)}`);
  }

  if (concept.broadMatch && concept.broadMatch.length > 0) {
    lines.push(`    ; skos:broadMatch ${formatUriList(concept.broadMatch)}`);
  }

  if (concept.narrowMatch && concept.narrowMatch.length > 0) {
    lines.push(`    ; skos:narrowMatch ${formatUriList(concept.narrowMatch)}`);
  }

  if (concept.relatedMatch && concept.relatedMatch.length > 0) {
    lines.push(`    ; skos:relatedMatch ${formatUriList(concept.relatedMatch)}`);
  }

  // Deprecated
  if (concept.deprecated) {
    lines.push(`    ; owl:deprecated true`);
  }

  // Is replaced by
  if (concept.isReplacedBy) {
    lines.push(`    ; dct:isReplacedBy ${formatUri(concept.isReplacedBy)}`);
  }

  lines.push('    .');

  return lines.join('\n');
}

/**
 * Get concepts in depth-first order from top concepts
 */
function getConceptsInOrder(state: VocabularyBuilderState): SKOSConcept[] {
  const result: SKOSConcept[] = [];
  const visited = new Set<string>();

  function visit(concept: SKOSConcept) {
    if (visited.has(concept.id)) return;
    visited.add(concept.id);
    result.push(concept);

    if (concept.narrower) {
      for (const narrower of concept.narrower) {
        const narrowerId = typeof narrower === 'string' ? narrower : narrower.id;
        const narrowerConcept = state.concepts.get(narrowerId);
        if (narrowerConcept) {
          visit(narrowerConcept);
        }
      }
    }
  }

  // Start from top concepts
  for (const topConcept of state.scheme.hasTopConcept) {
    const concept = state.concepts.get(topConcept.id);
    if (concept) {
      visit(concept);
    }
  }

  // Add any orphaned concepts (not reachable from top concepts)
  for (const concept of state.concepts.values()) {
    if (!visited.has(concept.id)) {
      result.push(concept);
    }
  }

  return result;
}

/**
 * Serialize a vocabulary to Turtle format
 */
export function serializeToTurtle(state: VocabularyBuilderState): string {
  const sections: string[] = [];

  // Add prefixes
  sections.push(PREFIXES);

  // Add custom prefix if defined
  if (state.scheme.preferredNamespacePrefix && state.scheme.preferredNamespaceUri) {
    sections.push(
      `@prefix ${state.scheme.preferredNamespacePrefix}: <${state.scheme.preferredNamespaceUri}> .`
    );
    sections.push('');
  }

  // Add scheme
  sections.push(serializeScheme(state));
  sections.push('');

  // Add concepts in order
  const concepts = getConceptsInOrder(state);
  for (const concept of concepts) {
    sections.push(serializeConcept(concept, state.scheme.id));
    sections.push('');
  }

  return sections.join('\n').trim() + '\n';
}
