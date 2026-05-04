/**
 * SKOS vocabulary client - fetches and caches vocabularies
 */

import type { ParsedVocabulary, RawSkohubVocabulary, SKOSConcept } from './types.js';
import { parseVocabulary, searchConcepts, getLabel, type SearchField, DEFAULT_SEARCH_FIELDS } from './parser.js';
import { vocabularyCache } from './cache.js';
import { loadVocabularyFromNaddr, type NostrVocabLoaderOptions } from './nostr-loader.js';

const FETCH_TIMEOUT = 10000; // 10 seconds

/**
 * Fetch and parse a SKOS vocabulary from its URI.
 *
 * Dispatches on URI shape:
 *  - `naddr1…` → load from Nostr via NIP-VOCAB v0.2 (kinds 39737 / 39738)
 *  - anything else → HTTP fetch (skohub-style JSON-LD)
 */
export async function getVocabulary(
  uri: string,
  opts: NostrVocabLoaderOptions = {}
): Promise<ParsedVocabulary> {
  // Check cache first
  const cached = vocabularyCache.get(uri);
  if (cached) {
    return cached;
  }

  const vocabulary = uri.startsWith('naddr1')
    ? await loadVocabularyFromNaddr(uri, opts)
    : await fetchVocabulary(uri);

  // Cache the result
  vocabularyCache.set(uri, vocabulary);

  return vocabulary;
}

/**
 * Get a single concept by its URI
 */
export async function getConcept(
  conceptUri: string
): Promise<SKOSConcept | undefined> {
  // Derive the scheme URI from the concept URI
  // Most SKOS URIs follow pattern: {schemeUri}/{conceptId}
  // We need to try fetching the scheme and finding the concept
  const schemeUri = deriveSchemeUri(conceptUri);

  if (!schemeUri) {
    return undefined;
  }

  const vocabulary = await getVocabulary(schemeUri);
  return vocabulary.concepts.get(conceptUri);
}

/**
 * Search for concepts in a vocabulary
 */
export async function searchVocabulary(
  vocabularyUri: string,
  query: string,
  options: { language?: string; limit?: number; fields?: SearchField[] } = {}
): Promise<SKOSConcept[]> {
  const vocabulary = await getVocabulary(vocabularyUri);
  let results = searchConcepts(vocabulary.concepts, query, {
    language: options.language,
    fields: options.fields,
  });

  // Apply limit
  if (options.limit && results.length > options.limit) {
    results = results.slice(0, options.limit);
  }

  return results;
}

/**
 * Fetch vocabulary from remote URL
 */
async function fetchVocabulary(uri: string): Promise<ParsedVocabulary> {
  // Append .json if not present (skohub convention)
  const jsonUri = uri.endsWith('.json') ? uri : `${uri}.json`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const response = await fetch(jsonUri, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json, application/ld+json',
      },
      redirect: 'follow', // Follow redirects (w3id.org -> skohub.io)
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch vocabulary: ${response.status} ${response.statusText}`);
    }

    const raw = (await response.json()) as RawSkohubVocabulary;
    return parseVocabulary(raw);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Try to derive the scheme URI from a concept URI
 */
function deriveSchemeUri(conceptUri: string): string | undefined {
  // Common patterns:
  // https://w3id.org/kim/hochschulfaechersystematik/n1 -> .../scheme
  // https://w3id.org/kim/hcrt/video -> .../scheme

  try {
    const url = new URL(conceptUri);
    const pathParts = url.pathname.split('/').filter(Boolean);

    // Remove the last segment (concept ID) and append 'scheme'
    if (pathParts.length > 0) {
      pathParts.pop();
      pathParts.push('scheme');
      url.pathname = '/' + pathParts.join('/');
      return url.toString();
    }
  } catch {
    // Invalid URL
  }

  return undefined;
}

/**
 * Get cache statistics
 */
export function getCacheStats() {
  return vocabularyCache.stats();
}

/**
 * Clear the vocabulary cache
 */
export function clearCache() {
  vocabularyCache.clear();
}

// Re-export useful functions and types
export { getLabel, DEFAULT_SEARCH_FIELDS } from './parser.js';
export type { SearchField } from './parser.js';
