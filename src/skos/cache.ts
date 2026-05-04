/**
 * In-memory cache for SKOS vocabularies
 */

import type { ParsedVocabulary } from './types.js';

interface CacheEntry {
  vocabulary: ParsedVocabulary;
  fetchedAt: number;
}

const DEFAULT_TTL = 60 * 60 * 1000; // 1 hour in milliseconds

export class SKOSCache {
  private cache: Map<string, CacheEntry> = new Map();
  private ttl: number;

  constructor(ttl: number = DEFAULT_TTL) {
    this.ttl = ttl;
  }

  /**
   * Get a vocabulary from cache if valid
   */
  get(uri: string): ParsedVocabulary | undefined {
    const entry = this.cache.get(this.normalizeUri(uri));
    if (!entry) return undefined;

    // Check if expired
    if (Date.now() - entry.fetchedAt > this.ttl) {
      this.cache.delete(this.normalizeUri(uri));
      return undefined;
    }

    return entry.vocabulary;
  }

  /**
   * Store a vocabulary in cache
   */
  set(uri: string, vocabulary: ParsedVocabulary): void {
    this.cache.set(this.normalizeUri(uri), {
      vocabulary,
      fetchedAt: Date.now(),
    });
  }

  /**
   * Check if a vocabulary is cached (and not expired)
   */
  has(uri: string): boolean {
    return this.get(uri) !== undefined;
  }

  /**
   * Invalidate a specific vocabulary
   */
  invalidate(uri: string): void {
    this.cache.delete(this.normalizeUri(uri));
  }

  /**
   * Clear all cached vocabularies
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  stats(): { size: number; entries: Array<{ uri: string; age: number }> } {
    const now = Date.now();
    const entries: Array<{ uri: string; age: number }> = [];

    for (const [uri, entry] of this.cache) {
      entries.push({
        uri,
        age: Math.round((now - entry.fetchedAt) / 1000), // age in seconds
      });
    }

    return { size: this.cache.size, entries };
  }

  /**
   * Normalize URI for consistent cache keys
   */
  private normalizeUri(uri: string): string {
    // Remove trailing slashes and .json extension for consistency
    return uri.replace(/\/+$/, '').replace(/\.json$/, '');
  }
}

// Singleton cache instance
export const vocabularyCache = new SKOSCache();
