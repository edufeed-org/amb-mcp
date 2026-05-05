// Install Promise.try shim before unpdf evaluates — pdf.js calls it at
// module load time, and Node 20 (the deploy target) lacks it.
import './promiseTryShim.js';
import { extractText, getDocumentProxy } from 'unpdf';

/**
 * Plain-text PDF extractor for use as the `pdfExtract` callback in
 * `fetchPage`/`extractMetadata`. Returns the concatenated text content of
 * all pages, joined with double newlines.
 *
 * Errors surface to the caller; `fetchPage` already swallows them and
 * falls back to empty text, so a malformed PDF degrades to an
 * OG/baseline-only enrichment rather than failing the whole tool call.
 */
export async function extractPdfText(buffer: ArrayBuffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join('\n\n') : text;
}
