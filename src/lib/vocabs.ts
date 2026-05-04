import { getVocabulary, getLabel } from '../skos/index.js';

/**
 * LLM-ready snapshot of a SKOS vocabulary.
 *
 * Reduces a fully parsed vocab to just the fields an LLM needs to pick
 * concept IDs from a page: each concept's id, single-language prefLabel,
 * and any altLabels in that same language. JSON-serializable so the
 * Anthropic SDK prompt cache can key on it cheaply.
 *
 * Deprecated concepts are dropped. The default language is 'de' to match
 * the German-first nature of the project's vocabularies (KIM, EKKW).
 */
export interface VocabConcept {
  id: string;
  prefLabel: string;
  altLabels?: string[];
}

export interface VocabSnapshot {
  id: string;
  title?: string;
  concepts: VocabConcept[];
}

export interface VocabSnapshotOptions {
  language?: string;
}

export async function vocabSnapshot(
  uri: string,
  options: VocabSnapshotOptions = {}
): Promise<VocabSnapshot> {
  const { language = 'de' } = options;
  const vocab = await getVocabulary(uri);

  const concepts: VocabConcept[] = [];
  for (const concept of vocab.concepts.values()) {
    if (concept.deprecated) continue;
    const prefLabel = getLabel(concept.prefLabel, language);
    if (!prefLabel) continue;

    const altLabels: string[] = [];
    for (const alt of concept.altLabel ?? []) {
      const label = getLabel(alt, language);
      if (label) altLabels.push(label);
    }

    concepts.push({
      id: concept.id,
      prefLabel,
      ...(altLabels.length > 0 ? { altLabels } : {})
    });
  }

  return {
    id: vocab.scheme.id,
    ...(vocab.scheme.title ? { title: getLabel(vocab.scheme.title, language) } : {}),
    concepts
  };
}
