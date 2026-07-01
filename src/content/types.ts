/** Discriminant for the unified content result. */
export type ContentType =
  | 'resource'
  | 'article'
  | 'wiki'
  | 'project'
  | 'measure'
  | 'publication';

interface ContentResultBase {
  type: ContentType;
  kind: number;
  title: string;
  /** Frontend URL — present only when EDUFEED_APP_BASE_URL is configured. */
  url?: string;
  /** NIP-19 addressable identifier. */
  naddr?: string;
  /** The Nostr event signer (uploader/aggregator) — NOT necessarily the resource's creator/publisher. */
  eventAuthor: { pubkey: string; npub?: string };
  createdAt: number;
  /** Canonical external source page (the resource's own URL, transferkiosk.net, etc.) — a direct link to the material, distinct from the edufeed viewer `url`. */
  sourcePage?: string;
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
  /** Resource creator(s) from AMB metadata — who made the resource. */
  creator?: Array<{ name: string; type: string }>;
  /** Resource publisher(s) from AMB metadata — who published it. Distinct from eventAuthor. */
  publisher?: Array<{ name: string; type: string }>;
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

/**
 * NIP-DIDACTIC transferkiosk content (kinds 30143 Projekt / 30144 Maßnahme /
 * 30145 Publikation). All three share the same projected shape; `partOf`
 * carries the parent project coord (`30143:<pub>:<d>`) for measures and
 * publications, and is absent on root projects.
 */
interface TransferkioskResultBase extends ContentResultBase {
  description?: string;
  summary?: string;
  excerpt?: string;
  /** Parent project coord `30143:<pub>:<d>` (measures/publications only). */
  partOf?: string;
}

export interface ProjectResult extends TransferkioskResultBase {
  type: 'project';
  kind: 30143;
}

export interface MeasureResult extends TransferkioskResultBase {
  type: 'measure';
  kind: 30144;
}

export interface PublicationResult extends TransferkioskResultBase {
  type: 'publication';
  kind: 30145;
  /** Canonical identifier (DOI or ISBN), from the `i` tag, when present. */
  identifier?: string;
}

export type SimplifiedContentResult =
  | ResourceResult
  | ArticleResult
  | WikiResult
  | ProjectResult
  | MeasureResult
  | PublicationResult;
