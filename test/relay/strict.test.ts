import { describe, it, expect } from 'vitest';
import { AMBRelayClient, RelayUnreachableError } from '../../src/relay/client.js';

// 127.0.0.1:1 refuses connections immediately — a real, fast outage.
const DEAD_RELAY = 'ws://127.0.0.1:1';

describe('queryEvents strict mode', () => {
  it('strict: throws RelayUnreachableError when no relay accepts a connection', async () => {
    const c = new AMBRelayClient([DEAD_RELAY]);
    try {
      await expect(c.queryEvents({ kinds: [30142], limit: 1 }, [DEAD_RELAY], { strict: true }))
        .rejects.toBeInstanceOf(RelayUnreachableError);
    } finally {
      c.close();
    }
  });

  it('default (lenient): the same outage resolves to an empty array', async () => {
    const c = new AMBRelayClient([DEAD_RELAY]);
    try {
      await expect(c.queryEvents({ kinds: [30142], limit: 1 }, [DEAD_RELAY])).resolves.toEqual([]);
    } finally {
      c.close();
    }
  });

  it('strict: an empty relay selection also throws', async () => {
    const c = new AMBRelayClient([]);
    try {
      await expect(c.queryEvents({ kinds: [30142], limit: 1 }, undefined, { strict: true }))
        .rejects.toBeInstanceOf(RelayUnreachableError);
    } finally {
      c.close();
    }
  });
});
