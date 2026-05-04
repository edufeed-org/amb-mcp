#!/usr/bin/env bun
/**
 * Quick test script for the AMB Relay Client
 */

import { AMBRelayClient } from './src/relay/client.js';
import { buildFilter } from './src/relay/filters.js';
import { eventsToAMBResources, toSimplifiedResource } from './src/utils/transform.js';

const RELAY_URL = process.env.AMB_RELAY_URL || 'ws://localhost:3334';

async function main() {
  console.log(`Testing AMB Relay Client against ${RELAY_URL}\n`);

  const client = new AMBRelayClient(RELAY_URL);

  // Test 1: Get relay info
  console.log('=== Test 1: Relay Info ===');
  try {
    const info = await client.getRelayInfo();
    console.log(`Name: ${info.name}`);
    console.log(`Description: ${info.description}`);
    console.log(`Supported NIPs: ${info.supported_nips?.join(', ')}`);
  } catch (e) {
    console.error('Failed:', e);
  }

  // Test 2: Simple query
  console.log('\n=== Test 2: Query (limit 3) ===');
  try {
    const events = await client.query({ limit: 3 });
    console.log(`Found ${events.length} events`);
    const resources = eventsToAMBResources(events);
    for (const r of resources) {
      console.log(`  - ${r.resource.name}`);
    }
  } catch (e) {
    console.error('Failed:', e);
  }

  // Test 3: Search
  console.log('\n=== Test 3: Search "Open Educational" ===');
  try {
    const events = await client.search('Open Educational', { limit: 5 });
    console.log(`Found ${events.length} events`);
    const resources = eventsToAMBResources(events);
    for (const r of resources) {
      const simplified = toSimplifiedResource(r);
      console.log(`  - ${simplified.name}`);
      console.log(`    Publisher: ${simplified.publisher?.[0]?.name || 'N/A'}`);
    }
  } catch (e) {
    console.error('Failed:', e);
  }

  // Test 4: Filter by resource type
  console.log('\n=== Test 4: Filter by resource type "Unterrichtsplanung" ===');
  try {
    const { filter, search } = buildFilter({ resourceTypeLabel: 'Unterrichtsplanung', limit: 3 });
    console.log(`Search string: "${search}"`);
    const events = await client.search(search, filter);
    console.log(`Found ${events.length} events`);
    const resources = eventsToAMBResources(events);
    for (const r of resources) {
      console.log(`  - ${r.resource.name}`);
    }
  } catch (e) {
    console.error('Failed:', e);
  }

  // Test 5: Get by d-tag
  console.log('\n=== Test 5: Get by d-tag ===');
  try {
    const dTag = 'https://lehreladen.rub.de/lehrformate-methoden/open-educational-resources/was-sind-open-educational-resources/';
    const event = await client.getByDTag(dTag);
    if (event) {
      const resource = eventsToAMBResources([event])[0];
      if (resource) {
        const simplified = toSimplifiedResource(resource);
        console.log(`Found: ${simplified.name}`);
        console.log(`  ID: ${simplified.id}`);
        console.log(`  Type: ${simplified.type?.join(', ')}`);
      }
    } else {
      console.log('Not found');
    }
  } catch (e) {
    console.error('Failed:', e);
  }

  client.close();
  console.log('\n✓ All tests completed');
}

main().catch(console.error);
