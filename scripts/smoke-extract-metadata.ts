/**
 * Local smoke test for extract_metadata against real URLs + real Anthropic.
 *
 * Exercises the retry-on-overload path (when Anthropic happens to return
 * 529) and prints the resulting payload + evidence + source.
 *
 * Run with:  ANTHROPIC_API_KEY=... bun run scripts/smoke-extract-metadata.ts
 */

import { extractMetadata, createAnthropicClient } from '../src/lib/index.js';
import { extractPdfText } from '../src/lib/pdfExtractor.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is required');
  process.exit(1);
}

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';

const CASES: Array<{ name: string; url: string; variant: 'amb' | 'ekw' | 'konfi'; skosSchemes: Record<string, string> }> = [
  {
    name: 'konfi PDF as variant=konfi (with konfi vocabs)',
    url: 'https://www.rpi-ekkw-ekhn.de/fileadmin/templates/rpi/normal/material/arbeitsbereiche/ab_konfirmandenarbeit/material/rpi_konfi/rpi-konfi_6-2020_Lay03.pdf',
    variant: 'konfi',
    skosSchemes: {
      learningResourceType: process.env.SCHEME_NADDR_EKW_LRT!,
      konfiZielgruppen: process.env.SCHEME_NADDR_KONFI_ZIELGRUPPEN!,
      konfiLernformat: process.env.SCHEME_NADDR_KONFI_LERNFORMAT!,
      konfiZeitstruktur: process.env.SCHEME_NADDR_KONFI_ZEITSTRUKTUR!,
      konfiBeteiligte: process.env.SCHEME_NADDR_KONFI_BETEILIGTE!,
      konfiThemen: process.env.SCHEME_NADDR_KONFI_THEMEN!,
      konfiDimensionen: process.env.SCHEME_NADDR_KONFI_DIMENSIONEN!,
      konfiMethode: process.env.SCHEME_NADDR_KONFI_METHODE!,
      konfiMaterialaufwand: process.env.SCHEME_NADDR_KONFI_MATERIALAUFWAND!,
      konfiTechnikbedarf: process.env.SCHEME_NADDR_KONFI_TECHNIKBEDARF!,
      konfiLernorte: process.env.SCHEME_NADDR_KONFI_LERNORTE!,
      landeskirchen: process.env.SCHEME_NADDR_LANDESKIRCHEN!
    }
  },
  {
    name: 'konfi PDF as variant=ekw (school-context — baseline before konfi support)',
    url: 'https://www.rpi-ekkw-ekhn.de/fileadmin/templates/rpi/normal/material/arbeitsbereiche/ab_konfirmandenarbeit/material/rpi_konfi/rpi-konfi_6-2020_Lay03.pdf',
    variant: 'ekw',
    skosSchemes: {
      learningResourceType: process.env.SCHEME_NADDR_EKW_LRT!,
      educationalLevels: process.env.SCHEME_NADDR_EDUCATIONAL_LEVEL!,
      gradeLevels: process.env.SCHEME_NADDR_KLASSENSTUFEN!,
      schoolTypes: process.env.SCHEME_NADDR_SCHULART!,
      ekwFachrichtung: process.env.SCHEME_NADDR_EKW_FACH!,
      didacticConcepts: process.env.SCHEME_NADDR_DIDAKTISCHES_KONZEPT!,
      methods: process.env.SCHEME_NADDR_METHODE!
    }
  },
  {
    name: 'school HTML (wikipedia — sanity baseline)',
    url: 'https://en.wikipedia.org/wiki/Pythagorean_theorem',
    variant: 'amb',
    skosSchemes: {
      learningResourceType: process.env.SCHEME_NADDR_HCRT!,
      about: process.env.SCHEME_NADDR_SCHULFAECHER!,
      educationalLevels: process.env.SCHEME_NADDR_EDUCATIONAL_LEVEL!,
      gradeLevels: process.env.SCHEME_NADDR_KLASSENSTUFEN!,
      schoolTypes: process.env.SCHEME_NADDR_SCHULART!
    }
  }
];

const llmClient = createAnthropicClient(ANTHROPIC_API_KEY);

for (const c of CASES) {
  console.log(`\n=== ${c.name} ===`);
  console.log(`URL:     ${c.url}`);
  console.log(`Variant: ${c.variant}`);
  const t0 = Date.now();
  try {
    const result = await extractMetadata({
      url: c.url,
      variant: c.variant,
      skosSchemes: Object.fromEntries(Object.entries(c.skosSchemes).filter(([, v]) => v)),
      vocabRelays: ['wss://relay.edufeed.org'],
      llmClient,
      llmModel: MODEL,
      pdfExtract: extractPdfText
    });
    const dt = Date.now() - t0;
    console.log(`source:  ${result.source}   (${dt} ms)`);
    console.log('payload:');
    console.dir(result.payload, { depth: 4 });
    console.log('evidence keys:', Object.keys(result.evidence));
  } catch (err: unknown) {
    const dt = Date.now() - t0;
    const e = err as { status?: number; message?: string; error?: { error?: { type?: string } } };
    console.log(`FAILED after ${dt} ms — status=${e?.status ?? '?'} type=${e?.error?.error?.type ?? '?'}`);
    console.log(`message: ${e?.message ?? String(err)}`);
  }
}
