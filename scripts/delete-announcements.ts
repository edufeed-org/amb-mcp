#!/usr/bin/env bun
/**
 * Delete MCP server announcement events from relays.
 * Run this to remove public announcements when you want to keep the server private.
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

// ContextVM announcement kinds
const ANNOUNCEMENT_KINDS = [11316, 11317, 11318, 11319];

async function main() {
  if (!SERVER_PRIVATE_KEY) {
    console.error('ERROR: SERVER_PRIVATE_KEY environment variable is required');
    process.exit(1);
  }

  const privateKeyBytes = hexToBytes(SERVER_PRIVATE_KEY);
  const pool = new SimplePool();

  console.log('Connecting to relays:', RELAYS.join(', '));

  // First, fetch existing announcements to get their IDs
  const filter = {
    kinds: ANNOUNCEMENT_KINDS,
    authors: [getPublicKey(privateKeyBytes)],
  };

  console.log('Fetching existing announcements...');
  const events = await pool.querySync(RELAYS, filter);

  if (events.length === 0) {
    console.log('No announcements found to delete.');
    pool.close(RELAYS);
    return;
  }

  console.log(`Found ${events.length} announcement(s) to delete:`);
  for (const event of events) {
    console.log(`  - kind ${event.kind}: ${event.id.slice(0, 16)}...`);
  }

  // Create deletion event (NIP-09)
  const deletionEvent = finalizeEvent({
    kind: 5,
    created_at: Math.floor(Date.now() / 1000),
    tags: events.map(e => ['e', e.id]),
    content: 'Removing MCP server announcements',
  }, privateKeyBytes);

  console.log('\nPublishing deletion event...');

  await Promise.all(
    pool.publish(RELAYS, deletionEvent as NostrEvent)
  );

  console.log('✓ Deletion event published');
  console.log(`  Event ID: ${deletionEvent.id}`);

  pool.close(RELAYS);
}

main().catch(console.error);
