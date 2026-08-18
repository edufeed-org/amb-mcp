import { describe, it, expect } from 'vitest';

import { buildSessionServer } from '../src/session.js';

const DEFAULTS = ['wss://relay.edufeed.org'];
const CAL_DEFAULTS = ['wss://relay.edufeed.org'];

async function listToolNames(profile?: { read?: boolean; extract?: boolean; write?: boolean }) {
  const s = buildSessionServer(DEFAULTS, CAL_DEFAULTS, profile);
  // McpServer exposes registered tools via its internal registry.
  const names = Object.keys((s.server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
  s.dispose();
  return names;
}

describe('buildSessionServer per-session relay isolation', () => {
  it('seeds the AMB client with selectable extra relays', () => {
    const s = buildSessionServer(DEFAULTS, CAL_DEFAULTS, undefined, {
      ambExtraRelays: ['wss://oersi.example'],
    });
    expect(s.ambClient.getRelays()).toEqual(DEFAULTS);
    expect(s.ambClient.getExtraRelays()).toEqual(['wss://oersi.example']);
    s.dispose();
  });

  it('gives each session independent relay clients', () => {
    const a = buildSessionServer(DEFAULTS, CAL_DEFAULTS);
    const b = buildSessionServer(DEFAULTS, CAL_DEFAULTS);

    expect(a.ambClient).not.toBe(b.ambClient);
    expect(a.calendarClient).not.toBe(b.calendarClient);

    a.dispose();
    b.dispose();
  });

  it('does not leak a relay added in one session into another', () => {
    const a = buildSessionServer(DEFAULTS, CAL_DEFAULTS);
    const b = buildSessionServer(DEFAULTS, CAL_DEFAULTS);

    const extra = 'wss://extra.example.com';
    a.ambClient.addRelay(extra);

    expect(a.ambClient.getRelays()).toContain(extra);
    expect(b.ambClient.getRelays()).not.toContain(extra);
    expect(b.ambClient.getRelays()).toEqual(DEFAULTS);

    a.dispose();
    b.dispose();
  });

  it('does not leak a relay removed in one session into another', () => {
    const a = buildSessionServer(DEFAULTS, CAL_DEFAULTS);
    const b = buildSessionServer(DEFAULTS, CAL_DEFAULTS);

    a.ambClient.removeRelay(DEFAULTS[0]);

    expect(a.ambClient.getRelays()).not.toContain(DEFAULTS[0]);
    expect(b.ambClient.getRelays()).toEqual(DEFAULTS);

    a.dispose();
    b.dispose();
  });

  it('dispose is idempotent and does not throw', () => {
    const a = buildSessionServer(DEFAULTS, CAL_DEFAULTS);
    expect(() => {
      a.dispose();
      a.dispose();
    }).not.toThrow();
  });
});

describe('buildSessionServer tool profile', () => {
  it('read-only profile excludes write and extract tools', async () => {
    const names = await listToolNames({ read: true, extract: false, write: false });
    expect(names).toContain('search_content');
    expect(names).toContain('get_resource');
    expect(names).not.toContain('extract_metadata');
    expect(names).not.toContain('publish_event');
    expect(names).not.toContain('sign_event');
    expect(names).not.toContain('add_relay');
  });

  it('extract profile adds extract_metadata but still no write tools', async () => {
    const names = await listToolNames({ read: true, extract: true, write: false });
    expect(names).toContain('extract_metadata');
    expect(names).not.toContain('publish_event');
    expect(names).not.toContain('sign_event');
    expect(names).not.toContain('add_relay');
    expect(names).not.toContain('skos_create_vocabulary');
  });

  it('default profile keeps the full toolset (write tools present)', async () => {
    const names = await listToolNames();
    expect(names).toContain('publish_event');
    expect(names).toContain('sign_event');
    expect(names).toContain('add_relay');
  });
});
