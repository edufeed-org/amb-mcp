import { describe, it, expect } from 'vitest';
import { extractPdfText } from '../../src/lib/pdfExtractor.js';

describe('extractPdfText', () => {
  it('rejects non-PDF buffers', async () => {
    const garbage = new TextEncoder().encode('not a pdf').buffer as ArrayBuffer;
    await expect(extractPdfText(garbage)).rejects.toThrow();
  });

  it('extracts text from a minimal valid PDF', async () => {
    // Minimal one-page PDF rendering "Hello PDF" — handcrafted with the
    // exact byte offsets in the xref table.
    const pdf = buildMinimalPdf('Hello PDF');
    const text = await extractPdfText(pdf);
    expect(text).toContain('Hello PDF');
  });
});

/**
 * Build a minimal valid PDF (1 page, Type1 Helvetica font) containing
 * the given text. Returns an ArrayBuffer.
 */
function buildMinimalPdf(text: string): ArrayBuffer {
  const objects: string[] = [];
  objects[1] = '<</Type/Catalog/Pages 2 0 R>>';
  objects[2] = '<</Type/Pages/Kids[3 0 R]/Count 1>>';
  objects[3] =
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>';
  const stream = `BT /F1 24 Tf 100 700 Td (${text}) Tj ET`;
  objects[4] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;
  objects[5] = '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>';

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = body.length;
    body += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = body.length;
  body += `xref\n0 6\n0000000000 65535 f \n`;
  for (let i = 1; i <= 5; i++) {
    body += `${offsets[i].toString().padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<</Size 6/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return new TextEncoder().encode(body).buffer as ArrayBuffer;
}
