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
  fetchFn?: typeof fetch;
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
  skosSchemes: Record<string, string>
): Promise<Record<string, Set<string>>> {
  const out: Record<string, Set<string>> = {};
  await Promise.all(
    Object.entries(skosSchemes).map(async ([field, uri]) => {
      try {
        const vocab = await getVocabulary(uri);
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
  skosSchemes: Record<string, string>
): Promise<Record<string, VocabSnapshot>> {
  const snaps: Record<string, VocabSnapshot> = {};
  await Promise.all(
    Object.entries(skosSchemes).map(async ([field, uri]) => {
      try {
        snaps[field] = await vocabSnapshot(uri);
      } catch {
        // Skip — better to enrich without grounding than to fail entirely.
      }
    })
  );
  return snaps;
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
  const { url, variant, skosSchemes = {}, fetchFn, llmClient, llmModel } = input;

  const page = await fetchPage({ url, fetchFn });
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
    loadVocabSnapshots(skosSchemes),
    loadVocabIds(skosSchemes)
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

  const filtered = filterByVocab(llmRes.payload, vocabIds);
  const variantSafe = applyVariantSchema(filtered, variant);

  // Keep evidence only for fields that survived filtering.
  const evidence: Record<string, string> = {};
  for (const [k, quote] of Object.entries(llmRes.evidence)) {
    if (k in variantSafe && typeof quote === 'string') evidence[k] = quote;
  }

  return {
    source: 'llm-enriched',
    payload: variantSafe,
    evidence,
    baseline
  };
}
