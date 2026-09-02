#!/usr/bin/env node
// Publish the curated spell templates (and the key's kind-0 profile) to the
// spell relays. Usage:
//   EDUFEED_SPELLS_NSEC=$(cat /path/to/key) node spells/publish.mjs [--dry-run]
// Spells are immutable (no d tag): re-running publishes NEW events. Only run
// after adding or deliberately revising templates; revisions should carry an
// ["e", <old-id>] fork tag added to the template first.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalizeEvent, nip19, SimplePool } from 'nostr-tools';
import { useWebSocketImplementation } from 'nostr-tools/pool';
import WebSocket from 'ws';

useWebSocketImplementation(WebSocket);

const RELAYS = (process.env.SPELL_RELAYS ?? 'wss://relay.edufeed.org').split(',').filter(Boolean);
const dryRun = process.argv.includes('--dry-run');

const nsec = process.env.EDUFEED_SPELLS_NSEC;
if (!nsec) {
  console.error('EDUFEED_SPELLS_NSEC is required (never echo it).');
  process.exit(1);
}
const { type, data: sk } = nip19.decode(nsec.trim());
if (type !== 'nsec') {
  console.error('EDUFEED_SPELLS_NSEC is not an nsec.');
  process.exit(1);
}

const dir = dirname(fileURLToPath(import.meta.url));
const pool = new SimplePool();
for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const tmpl = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const event = finalizeEvent({ ...tmpl, created_at: Math.floor(Date.now() / 1000) }, sk);
  if (dryRun) {
    console.log(`[dry-run] ${file} -> kind ${event.kind} id ${event.id}`);
    continue;
  }
  await Promise.allSettled(pool.publish(RELAYS, event));
  console.log(`published ${file}: kind ${event.kind} id ${event.id}`);
}
pool.close(RELAYS);
