/** Discriminant for the unified content result. */
export type ContentType = 'resource' | 'article' | 'wiki';

interface ContentResultBase {
  type: ContentType;
  kind: number;
  title: string;
  /** Frontend URL — present only when EDUFEED_APP_BASE_URL is configured. */
  url?: string;
  /** NIP-19 addressable identifier. */
  naddr?: string;
  author: { pubkey: string };
  createdAt: number;
  /** Best matching passage from a kind-21142 snippet, when available. */
  snippet?: string;
  /** Chunk score from the snippet, when available. */
  score?: number;
  /** Locators from the snippet, when known. */
  page?: number;
  heading?: string;
  sourceUrl?: string;
}

export interface ResourceResult extends ContentResultBase {
  type: 'resource';
  kind: 30142;
  description?: string;
  about?: string[];
  learningResourceType?: string[];
  educationalLevel?: string[];
}

export interface ArticleResult extends ContentResultBase {
  type: 'article';
  kind: 30023;
  summary?: string;
  excerpt?: string;
  topics?: string[];
  image?: string;
  publishedAt?: number;
}

export interface WikiResult extends ContentResultBase {
  type: 'wiki';
  kind: 30818;
  summary?: string;
  excerpt?: string;
  topics?: string[];
}

export type SimplifiedContentResult = ResourceResult | ArticleResult | WikiResult;
