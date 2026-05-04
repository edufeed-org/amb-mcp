#!/usr/bin/env bun
/**
 * Unpublish MCP server by publishing empty replacement events.
 * This effectively removes the server from public discovery.
 */

import { finalizeEvent, getPublicKey, type NostrEvent } from 'nostr-tools';
import { SimplePool } from 'nostr-tools';

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

const SERVER_PRIVATE_KEY = process.env.SERVER_PRIVATE_KEY;
const RELAYS = process.env.RELAYS?.split(',') || [
  'wss://relay.contextvm.org',
  'wss://cvm.otherstuff.ai',
];

// ContextVM announcement kinds (replaceable)
// 11316 = server info, 11317 = tools, 11318 = resources, 11319 = prompts
const ANNOUNCEMENT_KINDS = [11316, 11317, 11318, 11319];

async function main() {
  if (!SERVER_PRIVATE_KEY) {
    console.error('ERROR: SERVER_PRIVATE_KEY environment variable is required');
    process.exit(1);
  }

  const privateKeyBytes = hexToBytes(SERVER_PRIVATE_KEY);
  const pubkey = getPublicKey(privateKeyBytes);
  const pool = new SimplePool();

  console.log('Unpublishing MCP server announcements...');
  console.log(`Pubkey: ${pubkey}`);
  console.log(`Relays: ${RELAYS.join(', ')}`);

  const now = Math.floor(Date.now() / 1000);

  for (const kind of ANNOUNCEMENT_KINDS) {
    // Publish empty replacement event
    const event = finalizeEvent({
      kind,
      created_at: now,
      tags: [],
      content: '',  // Empty content indicates server is not available
    }, privateKeyBytes);

    console.log(`Publishing empty kind ${kind}...`);

    try {
      await Promise.all(pool.publish(RELAYS, event as NostrEvent));
      console.log(`  ✓ Published: ${event.id.slice(0, 16)}...`);
    } catch (e) {
      console.log(`  ✗ Failed: ${e}`);
    }
  }

  pool.close(RELAYS);
  console.log('\n✓ Server unpublished from public discovery');
}

main().catch(console.error);
