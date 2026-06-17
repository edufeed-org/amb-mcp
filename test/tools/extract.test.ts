import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { registerExtractTool } from '../../src/tools/extract.js';

/**
 * Regression test for the tool-boundary enum. The lib-level schema is
 * variant-aware (`'amb' | 'ekw' | 'konfi'`), but the MCP tool input schema
 * has its own enum that must stay in sync — otherwise the SDK rejects
 * `variant=konfi` before the handler runs, which is what shipped to prod
 * after the feat/konfi-variant merge (the lib schema accepted konfi, but
 * src/tools/extract.ts was still on the old two-variant enum).
 */
describe('extract_metadata tool input schema', () => {
  // McpServer.registerTool only needs `registerTool` for our purposes; we
  // capture the schema passed to it instead of booting a real server.
  function captureInputSchema(): Record<string, z.ZodTypeAny> {
    let captured: Record<string, z.ZodTypeAny> | undefined;
    const fakeServer = {
      registerTool: (_name: string, def: { inputSchema: Record<string, z.ZodTypeAny> }) => {
        captured = def.inputSchema;
      }
    };
    registerExtractTool(fakeServer as any);
    if (!captured) throw new Error('registerTool was not called');
    return captured;
  }

  it('accepts variant=amb', () => {
    const schema = captureInputSchema();
    expect(schema.variant.safeParse('amb').success).toBe(true);
  });

  it('accepts variant=ekw', () => {
    const schema = captureInputSchema();
    expect(schema.variant.safeParse('ekw').success).toBe(true);
  });

  it('accepts variant=konfi', () => {
    const schema = captureInputSchema();
    expect(schema.variant.safeParse('konfi').success).toBe(true);
  });

  it('rejects an unknown variant', () => {
    const schema = captureInputSchema();
    expect(schema.variant.safeParse('xyz').success).toBe(false);
  });

  it('accepts a urls array of http(s) URLs', () => {
    const schema = captureInputSchema();
    expect(
      schema.urls.safeParse(['https://a.example/x.pdf', 'https://b.example/y.pdf']).success
    ).toBe(true);
  });

  it('rejects a urls array containing a non-URL', () => {
    const schema = captureInputSchema();
    expect(schema.urls.safeParse(['not a url']).success).toBe(false);
  });

  it('rejects an empty urls array', () => {
    const schema = captureInputSchema();
    expect(schema.urls.safeParse([]).success).toBe(false);
  });

  it('makes the single url optional (urls[] may be used instead)', () => {
    const schema = captureInputSchema();
    expect(schema.url.safeParse(undefined).success).toBe(true);
  });
});
