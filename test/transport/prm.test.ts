import { describe, it, expect } from 'vitest';
import { buildProtectedResourceMetadata } from '../../src/transport/prm.js';

describe('buildProtectedResourceMetadata', () => {
  it('produces an RFC 9728 document', () => {
    const doc = buildProtectedResourceMetadata({
      resource: 'https://mcp.amb.edufeed.org/mcp',
      issuer: 'https://auth.edufeed.org/realms/edufeed',
      scopes: ['mcp:read', 'mcp:extract'],
    });
    expect(doc).toEqual({
      resource: 'https://mcp.amb.edufeed.org/mcp',
      authorization_servers: ['https://auth.edufeed.org/realms/edufeed'],
      scopes_supported: ['mcp:read', 'mcp:extract'],
      bearer_methods_supported: ['header'],
    });
  });
});
