/**
 * SKOS Vocabulary Builder state management
 *
 * Provides in-memory storage for vocabularies being built.
 * Uses user pubkey for isolation in multi-user environments.
 */

import type {
  VocabularyBuilderState,
  CreateVocabularyOptions,
  VocabularySummary,
} from './types.js';
import type { LocalizedString } from '../types.js';

/**
 * Creates a storage key from user pubkey and scheme URI
 */
function makeKey(userPubkey: string, schemeUri: string): string {
  return `${userPubkey}:${schemeUri}`;
}

/**
 * Singleton store for vocabularies being built.
 * Scoped by user pubkey for isolation.
 */
class VocabularyBuilderStore {
  private vocabularies: Map<string, VocabularyBuilderState> = new Map();

  /**
   * Create a new vocabulary for a user
   */
  create(
    userPubkey: string,
    options: CreateVocabularyOptions
  ): VocabularyBuilderState {
    const key = makeKey(userPubkey, options.uri);

    if (this.vocabularies.has(key)) {
      throw new Error(`Vocabulary already exists: ${options.uri}`);
    }

    const now = Date.now();
    const state: VocabularyBuilderState = {
      owner: userPubkey,
      scheme: {
        id: options.uri,
        type: 'ConceptScheme',
        title: options.title,
        description: options.description,
        hasTopConcept: [],
        license: options.license,
        preferredNamespaceUri: options.uri,
        preferredNamespacePrefix: options.preferredNamespacePrefix,
        issued: new Date().toISOString(),
      },
      concepts: new Map(),
      createdAt: now,
      modifiedAt: now,
    };

    this.vocabularies.set(key, state);
    return state;
  }

  /**
   * Get a vocabulary by user and URI
   */
  get(userPubkey: string, schemeUri: string): VocabularyBuilderState | undefined {
    const key = makeKey(userPubkey, schemeUri);
    return this.vocabularies.get(key);
  }

  /**
   * Check if a vocabulary exists
   */
  has(userPubkey: string, schemeUri: string): boolean {
    const key = makeKey(userPubkey, schemeUri);
    return this.vocabularies.has(key);
  }

  /**
   * Delete a vocabulary
   */
  delete(userPubkey: string, schemeUri: string): boolean {
    const key = makeKey(userPubkey, schemeUri);
    return this.vocabularies.delete(key);
  }

  /**
   * Set a vocabulary (for imports)
   * Overwrites if already exists
   */
  set(userPubkey: string, schemeUri: string, state: VocabularyBuilderState): void {
    const key = makeKey(userPubkey, schemeUri);
    this.vocabularies.set(key, state);
  }

  /**
   * List all vocabularies for a user
   */
  list(userPubkey: string): VocabularySummary[] {
    const summaries: VocabularySummary[] = [];

    for (const [key, state] of this.vocabularies.entries()) {
      if (state.owner === userPubkey) {
        summaries.push({
          uri: state.scheme.id,
          title: state.scheme.title,
          conceptCount: state.concepts.size,
          createdAt: state.createdAt,
          modifiedAt: state.modifiedAt,
        });
      }
    }

    return summaries;
  }

  /**
   * Clear vocabularies for a user, or all if no user specified
   */
  clear(userPubkey?: string): void {
    if (userPubkey) {
      for (const [key, state] of this.vocabularies.entries()) {
        if (state.owner === userPubkey) {
          this.vocabularies.delete(key);
        }
      }
    } else {
      this.vocabularies.clear();
    }
  }

  /**
   * Update the modified timestamp for a vocabulary
   */
  touch(userPubkey: string, schemeUri: string): void {
    const state = this.get(userPubkey, schemeUri);
    if (state) {
      state.modifiedAt = Date.now();
    }
  }

  /**
   * Get total count of all vocabularies (for debugging)
   */
  get size(): number {
    return this.vocabularies.size;
  }
}

/**
 * Singleton instance
 */
export const vocabularyStore = new VocabularyBuilderStore();
