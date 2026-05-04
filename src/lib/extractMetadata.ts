import { jsonrepair } from 'jsonrepair';
import { fetchPage, type FetchPageResult } from './fetchPage.js';
import { llmEnrich, type AnthropicLike } from './llm.js';
import { vocabSnapshot, type VocabSnapshot } from './vocabs.js';
import { formPayload, type Variant, type ExtractMetadataResult } from './schema.js';
import { getVocabulary } from '../skos/index.js';

/**
 * Orchestrate URL → form-prefill payload.
 *
 * Three branches:
 *
 *  1. AMB short-circuit — if the page exposes AMB JSON-LD, return it
 *     verbatim as payload. No LLM call.
 *  2. LLM-enriched — fetch vocab snapshots for the variant's admissible
 *     SKOS fields, hand them to the LLM via tool_use, validate concept IDs
 *     against the loaded vocabs, drop unknown ones.
 *  3. Open Graph fallback — if no LLM client is configured, surface OG
 *     fields as the payload so the form still gets four prefilled values.
 *
 * The third path doubles as the "graceful degradation" branch when the
 * deployment doesn't have an Anthropic key.
 *
 * `fetchFn` is injectable so the consumer can plug in a SSRF-aware fetch
 * or a test stub. `llmClient` is the same dependency-injected
 * `AnthropicLike` accepted by `llmEnrich`.
 */

export interface ExtractMetadataInput {
  url: string;
  variant: Variant;
  /**
   * Map of form-field name → SKOS scheme URI. Used to load vocab
   * snapshots and to validate that the LLM's chosen concept IDs are real.
   * Any field omitted here is sent to the LLM without grounding.
   */
  skosSchemes?: Record<string, string>;
  /**
   * Fallback Nostr relays for `naddr1…` SKOS schemes whose hint list is
   * missing or unreachable. Ignored for HTTP/skohub URIs.
   */
  vocabRelays?: string[];
  fetchFn?: typeof fetch;
  /**
   * PDF → plain-text extractor. Forwarded to fetchPage. When omitted,
   * PDF responses degrade to empty `readableText`.
   */
  pdfExtract?: (buffer: ArrayBuffer) => Promise<string>;
  llmClient?: AnthropicLike;
  llmModel?: string;
}

const OG_TO_FIELD: Array<[string, string]> = [
  ['og:title', 'name'],
  ['og:description', 'description'],
  ['og:image', 'image']
];

function ogPayload(page: FetchPageResult): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [og, field] of OG_TO_FIELD) {
    const v = page.ogTags[og];
    if (v) out[field] = v;
  }
  if (page.language) out.inLanguage = page.language;
  return out;
}

/**
 * Collect the set of valid concept IDs across all SKOS schemes the
 * caller has configured, keyed by form-field name.
 */
async function loadVocabIds(
  skosSchemes: Record<string, string>,
  vocabRelays: string[] | undefined
): Promise<Record<string, Set<string>>> {
  const out: Record<string, Set<string>> = {};
  await Promise.all(
    Object.entries(skosSchemes).map(async ([field, uri]) => {
      try {
        const vocab = await getVocabulary(uri, { fallbackRelays: vocabRelays });
        out[field] = new Set(vocab.concepts.keys());
      } catch {
        // Vocab unavailable → no validation for this field; LLM result
        // passes through unchecked.
        out[field] = new Set();
      }
    })
  );
  return out;
}

async function loadVocabSnapshots(
  skosSchemes: Record<string, string>,
  vocabRelays: string[] | undefined
): Promise<Record<string, VocabSnapshot>> {
  const snaps: Record<string, VocabSnapshot> = {};
  await Promise.all(
    Object.entries(skosSchemes).map(async ([field, uri]) => {
      try {
        snaps[field] = await vocabSnapshot(uri, {
          nostr: { fallbackRelays: vocabRelays }
        });
      } catch {
        // Skip — better to enrich without grounding than to fail entirely.
      }
    })
  );
  return snaps;
}

/**
 * Coerce bare-string concept IDs (which Anthropic models sometimes emit
 * when the tool input_schema doesn't pin down concept-array shape) into
 * the `{id, prefLabel?}` objects the rest of the pipeline expects.
 * Touches only fields that are SKOS-grounded (i.e. have a vocab snapshot).
 */
function normalizeConceptArrays(
  payload: Record<string, unknown>,
  vocabFields: Set<string>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload };
  for (const field of vocabFields) {
    const value = out[field];
    if (!Array.isArray(value)) continue;
    out[field] = value.map((entry) =>
      typeof entry === 'string' ? { id: entry } : entry
    );
  }
  return out;
}

/**
 * Try strict JSON.parse first; on failure run the input through `jsonrepair`,
 * which fixes the malformed-output shapes Anthropic models occasionally emit
 * — most commonly unescaped ASCII `"` inside German typographic-quote runs
 * (`„…"…"`), which prematurely terminate the JSON string. Returns undefined
 * if neither route yields a parseable object.
 */
function tryParseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to repair
  }
  try {
    const repaired = jsonrepair(text);
    const parsed = JSON.parse(repaired);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // give up
  }
  return undefined;
}

/**
 * Anthropic models sometimes serialize the `payload` tool argument as a
 * JSON-encoded string instead of a flat object. Without this, downstream
 * `Object.entries(payload)` iterates the chars of the string and
 * applyVariantSchema strips everything → empty payload. Accept both shapes,
 * and run a JSON-repair fallback when the encoded string is malformed.
 */
function normalizePayload(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    return tryParseObject(value) ?? {};
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * Anthropic models sometimes serialize the `evidence` tool argument as a
 * JSON-encoded string instead of a flat object. Accept both shapes (with the
 * same JSON-repair fallback) so the "Smart fill ✨" badges still get their
 * quotes downstream.
 */
function normalizeEvidence(value: unknown): Record<string, string> {
  if (typeof value === 'string') {
    return (tryParseObject(value) as Record<string, string> | undefined) ?? {};
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, string>;
  }
  return {};
}

/**
 * Drop concept IDs not present in the loaded vocab. Empty validation
 * sets (e.g. vocab fetch failed) are treated as "skip validation".
 */
function filterByVocab(
  payload: Record<string, unknown>,
  vocabIds: Record<string, Set<string>>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload };
  for (const [field, ids] of Object.entries(vocabIds)) {
    if (ids.size === 0) continue;
    const value = out[field];
    if (!Array.isArray(value)) continue;
    const filtered = value.filter(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        typeof (entry as { id?: unknown }).id === 'string' &&
        ids.has((entry as { id: string }).id)
    );
    if (filtered.length === 0) {
      delete out[field];
    } else {
      out[field] = filtered;
    }
  }
  return out;
}

/**
 * Enforce the variant-aware schema by stripping fields the schema
 * rejects. AMB variant drops EKW-only fields. Returns the partial
 * payload the schema accepted.
 */
function applyVariantSchema(
  payload: Record<string, unknown>,
  variant: Variant
): Record<string, unknown> {
  const schema = formPayload(variant);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    const trial = schema.safeParse({ [k]: v });
    if (trial.success) {
      out[k] = v;
    }
  }
  return out;
}

export async function extractMetadata(
  input: ExtractMetadataInput
): Promise<ExtractMetadataResult> {
  const { url, variant, skosSchemes = {}, vocabRelays, fetchFn, pdfExtract, llmClient, llmModel } = input;

  const page = await fetchPage({ url, fetchFn, pdfExtract });
  const baseline = {
    og: Object.keys(page.ogTags).length > 0 ? page.ogTags : undefined,
    amb: page.ambJsonLd as Record<string, unknown> | undefined
  };

  // 1. AMB short-circuit
  if (page.ambJsonLd && typeof page.ambJsonLd === 'object') {
    return {
      source: 'amb-jsonld',
      payload: page.ambJsonLd as Record<string, unknown>,
      evidence: {},
      baseline
    };
  }

  // 3. OpenGraph fallback (no LLM client configured)
  if (!llmClient) {
    return {
      source: 'opengraph-only',
      payload: ogPayload(page),
      evidence: {},
      baseline
    };
  }

  // 2. LLM-enriched path
  const [snapshots, vocabIds] = await Promise.all([
    loadVocabSnapshots(skosSchemes, vocabRelays),
    loadVocabIds(skosSchemes, vocabRelays)
  ]);

  const llmRes = await llmEnrich({
    client: llmClient,
    variant,
    page: {
      title: page.title,
      description: page.description,
      ogTags: page.ogTags,
      jsonLdPartial: page.jsonLd,
      readableText: page.readableText
    },
    vocabs: snapshots,
    ...(llmModel ? { model: llmModel } : {})
  });

  const vocabFields = new Set(Object.keys(vocabIds));
  const payloadObject = normalizePayload(llmRes.payload);
  const normalizedPayload = normalizeConceptArrays(payloadObject, vocabFields);
  const normalizedEvidence = normalizeEvidence(llmRes.evidence);

  const filtered = filterByVocab(normalizedPayload, vocabIds);
  // Layer OG fallbacks beneath the LLM output so the four cheap-to-derive
  // fields (name/description/image/inLanguage) still prefill when the
  // LLM is conservative. LLM output wins on conflict.
  const merged = { ...ogPayload(page), ...filtered };
  const variantSafe = applyVariantSchema(merged, variant);

  // Keep evidence only for fields that survived filtering.
  const evidence: Record<string, string> = {};
  for (const [k, quote] of Object.entries(normalizedEvidence)) {
    if (k in variantSafe && typeof quote === 'string') evidence[k] = quote;
  }

  return {
    source: 'llm-enriched',
    payload: variantSafe,
    evidence,
    baseline
  };
}
