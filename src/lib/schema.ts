import { z } from 'zod';

/**
 * Form-payload schema for the URL → form prefill feature.
 *
 * Two variants:
 *  - 'amb' — generic AMB educational resources
 *  - 'ekw' — adds EKKW-specific religious-education fields on top of AMB
 *
 * Variant-aware via .strict(): EKW-only fields are rejected under 'amb'.
 */

export type Variant = 'amb' | 'ekw';

const localizedConcept = z.object({
  id: z.string(),
  prefLabel: z.string().optional()
});

const personOrOrg = z.object({
  name: z.string(),
  type: z.enum(['Person', 'Organization']).optional(),
  id: z.string().optional()
});

const ambBase = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  inLanguage: z.string().optional(),
  image: z.string().url().optional(),
  keywords: z.array(z.string()).optional(),

  // SKOS concept-picker fields — concept IDs are required, prefLabels are hints
  learningResourceType: z.array(localizedConcept).optional(),
  educationalLevels: z.array(localizedConcept).optional(),
  about: z.array(localizedConcept).optional(),

  creators: z.array(personOrOrg).optional(),
  publisher: z.array(personOrOrg).optional(),

  license: z.string().url().optional(),
  isAccessibleForFree: z.boolean().optional(),
  datePublished: z.string().optional()
});

const ekwExtensions = z.object({
  ekwFachrichtung: z.array(localizedConcept).optional(),
  gradeLevels: z.array(localizedConcept).optional(),
  schoolTypes: z.array(localizedConcept).optional(),
  didacticConcepts: z.array(localizedConcept).optional(),
  methods: z.array(localizedConcept).optional(),
  methodOther: z.string().optional(),
  bibleReferences: z.array(z.string()).optional()
});

const ambSchema = ambBase.strict();
const ekwSchema = ambBase.merge(ekwExtensions).strict();

/**
 * Return the variant-appropriate form-payload zod schema.
 */
export function formPayload(variant: Variant) {
  return variant === 'ekw' ? ekwSchema : ambSchema;
}

export type FormPayloadAmb = z.infer<typeof ambSchema>;
export type FormPayloadEkw = z.infer<typeof ekwSchema>;
export type FormPayload = FormPayloadAmb | FormPayloadEkw;

/**
 * The full result returned by extractMetadata().
 *
 * `source` indicates how the payload was produced:
 *   - 'amb-jsonld'      — page contained AMB JSON-LD; LLM was not called
 *   - 'llm-enriched'    — Open Graph + Readability text fed to an LLM
 *   - 'opengraph-only'  — page had no AMB JSON-LD and the LLM step was skipped
 *
 * `evidence[fieldName]` is a quoted page phrase justifying the LLM's choice
 * for that field. Empty for amb-jsonld and opengraph-only sources.
 *
 * `baseline` carries the raw extracted shapes so the UI can show the user
 * what was on the page before the LLM made any inferences.
 */
export const extractMetadataResult = z.object({
  source: z.enum(['amb-jsonld', 'llm-enriched', 'opengraph-only']),
  // payload is intentionally loose at this level — variant-specific validation
  // happens via formPayload(variant). Keeping it permissive here lets a single
  // result type be returned for either variant without parameterizing the
  // outer schema.
  payload: z.record(z.string(), z.unknown()),
  evidence: z.record(z.string(), z.string()),
  baseline: z.object({
    og: z.record(z.string(), z.unknown()).optional(),
    amb: z.record(z.string(), z.unknown()).optional()
  })
});

export type ExtractMetadataResult = z.infer<typeof extractMetadataResult>;
