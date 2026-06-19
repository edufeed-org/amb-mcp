import { describe, it, expect } from 'vitest';

import { buildSessionServer } from '../src/session.js';

const DEFAULTS = ['wss://relay.edufeed.org'];
const CAL_DEFAULTS = ['wss://dev.calendar-relay.edufeed.org'];

describe('buildSessionServer per-session relay isolation', () => {
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
