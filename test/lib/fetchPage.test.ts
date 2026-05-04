import { describe, it, expect } from 'vitest';
import { fetchPage } from '../../src/lib/fetchPage.js';

/** Build a minimal fake fetch returning the given HTML body. */
const fakeHtml = (html: string, status = 200, contentType = 'text/html; charset=utf-8') =>
  async (_url: string | URL): Promise<Response> =>
    new Response(html, { status, headers: { 'content-type': contentType } });

describe('fetchPage SSRF guards', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(fetchPage({ url: 'ftp://example.com/' })).rejects.toThrow(/http/i);
  });

  it('rejects http://localhost', async () => {
    await expect(fetchPage({ url: 'http://localhost/' })).rejects.toThrow(/private|local/i);
  });

  it('rejects http://127.0.0.1', async () => {
    await expect(fetchPage({ url: 'http://127.0.0.1/foo' })).rejects.toThrow(/private|local/i);
  });

  it('rejects http://10.0.0.1', async () => {
    await expect(fetchPage({ url: 'http://10.0.0.1/' })).rejects.toThrow(/private|local/i);
  });

  it('rejects http://192.168.1.1', async () => {
    await expect(fetchPage({ url: 'http://192.168.1.1/' })).rejects.toThrow(/private|local/i);
  });

  it('rejects *.local hostnames', async () => {
    await expect(fetchPage({ url: 'http://my-box.local/' })).rejects.toThrow(/private|local/i);
  });

  it('throws "Invalid URL" for garbage input', async () => {
    await expect(fetchPage({ url: 'not a url' })).rejects.toThrow();
  });
});

describe('fetchPage HTML parsing', () => {
  it('extracts Open Graph tags', async () => {
    const html = `
      <html><head>
        <meta property="og:title" content="Hello World">
        <meta property="og:description" content="A page about hello">
        <meta property="og:image" content="https://example.com/img.png">
        <meta property="og:locale" content="de_DE">
      </head><body><p>Hello</p></body></html>
    `;
    const page = await fetchPage({
      url: 'https://example.com/hello',
      fetchFn: fakeHtml(html)
    });
    expect(page.contentType).toBe('html');
    expect(page.ogTags['og:title']).toBe('Hello World');
    expect(page.ogTags['og:description']).toBe('A page about hello');
    expect(page.ogTags['og:image']).toBe('https://example.com/img.png');
    expect(page.ogTags['og:locale']).toBe('de_DE');
  });

  it('extracts <title> when no og:title present', async () => {
    const html = `<html><head><title>Plain Title</title></head><body><p>x</p></body></html>`;
    const page = await fetchPage({
      url: 'https://example.com/',
      fetchFn: fakeHtml(html)
    });
    expect(page.title).toBe('Plain Title');
  });

  it('prefers og:title over <title>', async () => {
    const html = `
      <html><head>
        <title>Plain Title</title>
        <meta property="og:title" content="OG Title">
      </head><body><p>x</p></body></html>
    `;
    const page = await fetchPage({
      url: 'https://example.com/',
      fetchFn: fakeHtml(html)
    });
    expect(page.title).toBe('OG Title');
  });

  it('extracts JSON-LD blocks', async () => {
    const ld1 = JSON.stringify({ '@context': 'https://schema.org', '@type': 'Article', name: 'A' });
    const ld2 = JSON.stringify({ '@context': 'https://schema.org', '@type': 'Person', name: 'B' });
    const html = `
      <html><head>
        <script type="application/ld+json">${ld1}</script>
        <script type="application/ld+json">${ld2}</script>
      </head><body><p>x</p></body></html>
    `;
    const page = await fetchPage({
      url: 'https://example.com/',
      fetchFn: fakeHtml(html)
    });
    expect(page.jsonLd).toHaveLength(2);
    expect(page.jsonLd[0]).toMatchObject({ '@type': 'Article', name: 'A' });
    expect(page.jsonLd[1]).toMatchObject({ '@type': 'Person', name: 'B' });
  });

  it('detects AMB JSON-LD when present (LearningResource type)', async () => {
    const ld = JSON.stringify({
      '@context': ['https://schema.org/', 'https://w3id.org/kim/amb/context.jsonld'],
      '@type': ['LearningResource'],
      id: 'urn:uuid:abc',
      name: 'A lesson'
    });
    const html = `<html><head><script type="application/ld+json">${ld}</script></head><body><p>x</p></body></html>`;
    const page = await fetchPage({
      url: 'https://example.com/',
      fetchFn: fakeHtml(html)
    });
    expect(page.ambJsonLd).toBeDefined();
    expect((page.ambJsonLd as any).name).toBe('A lesson');
  });

  it('returns ambJsonLd: undefined when no AMB shape present', async () => {
    const ld = JSON.stringify({ '@context': 'https://schema.org', '@type': 'Article', name: 'A' });
    const html = `<html><head><script type="application/ld+json">${ld}</script></head><body><p>x</p></body></html>`;
    const page = await fetchPage({
      url: 'https://example.com/',
      fetchFn: fakeHtml(html)
    });
    expect(page.ambJsonLd).toBeUndefined();
  });

  it('extracts readable text via Readability', async () => {
    const html = `
      <html><head><title>Article</title></head>
      <body>
        <header>nav junk</header>
        <article>
          <h1>The Headline</h1>
          <p>This is the first paragraph of real article content that Readability should preserve.</p>
          <p>This is the second paragraph with more substantive content for the readability algorithm to score.</p>
        </article>
        <footer>footer junk</footer>
      </body></html>
    `;
    const page = await fetchPage({
      url: 'https://example.com/article',
      fetchFn: fakeHtml(html)
    });
    expect(page.readableText).toContain('first paragraph');
    expect(page.readableText).toContain('second paragraph');
  });

  it('reads og:locale into language', async () => {
    const html = `
      <html><head>
        <meta property="og:locale" content="de_DE">
      </head><body><p>x</p></body></html>
    `;
    const page = await fetchPage({
      url: 'https://example.com/',
      fetchFn: fakeHtml(html)
    });
    expect(page.language).toBe('de');
  });

  it('falls back to <html lang> when og:locale missing', async () => {
    const html = `<html lang="en"><head></head><body><p>x</p></body></html>`;
    const page = await fetchPage({
      url: 'https://example.com/',
      fetchFn: fakeHtml(html)
    });
    expect(page.language).toBe('en');
  });
});

describe('fetchPage PDF handling', () => {
  /** Build a fake fetch returning a fixed Uint8Array body as application/pdf. */
  const fakePdf = (bytes: Uint8Array, status = 200) => async (_url: string | URL): Promise<Response> =>
    new Response(bytes, { status, headers: { 'content-type': 'application/pdf' } });

  it('routes PDFs through the injected pdfExtract and stuffs the text into readableText', async () => {
    const fakeBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
    let receivedBytes: Uint8Array | undefined;
    const pdfExtract = async (buf: ArrayBuffer) => {
      receivedBytes = new Uint8Array(buf);
      return 'Morgen bestimme ich. Ein Unterrichtsentwurf für die Klasse 5.';
    };
    const page = await fetchPage({
      url: 'https://example.org/lesson.pdf',
      fetchFn: fakePdf(fakeBytes),
      pdfExtract
    });
    expect(page.contentType).toBe('pdf');
    expect(page.readableText).toContain('Morgen bestimme ich');
    expect(receivedBytes && Array.from(receivedBytes)).toEqual([0x25, 0x50, 0x44, 0x46]);
  });

  it('returns empty text without throwing when pdfExtract is not provided', async () => {
    const page = await fetchPage({
      url: 'https://example.org/lesson.pdf',
      fetchFn: fakePdf(new Uint8Array([0x25, 0x50, 0x44, 0x46]))
    });
    expect(page.contentType).toBe('pdf');
    expect(page.readableText).toBe('');
  });

  it('returns empty text when pdfExtract throws (graceful degradation)', async () => {
    const pdfExtract = async () => {
      throw new Error('parse error');
    };
    const page = await fetchPage({
      url: 'https://example.org/lesson.pdf',
      fetchFn: fakePdf(new Uint8Array([0x25, 0x50, 0x44, 0x46])),
      pdfExtract
    });
    expect(page.contentType).toBe('pdf');
    expect(page.readableText).toBe('');
  });
});

describe('fetchPage non-200 responses', () => {
  it('throws on 4xx/5xx', async () => {
    const failing = async (_u: string | URL) =>
      new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
    await expect(
      fetchPage({ url: 'https://example.com/missing', fetchFn: failing })
    ).rejects.toThrow(/404|fetch/i);
  });
});
