#!/usr/bin/env bun
/**
 * Live smoke test for the multi-content search work against the dev relay.
 *
 * Exercises:
 *   1. search_content orchestration (runContentSearch) over 30142/30023/30818
 *      with snippet (21142) attachment.
 *   2. type-restricted search (types: ['article'] etc).
 *   3. calendar query → search wiring (buildCalendarFilter).
 *
 * Usage:
 *   AMB_RELAY_URL=wss://dev.amb-relay.edufeed.org bun run scripts/smoke-search-content.ts "topic"
 */

import { AMBRelayClient } from '../src/relay/client.js';
import { runContentSearch } from '../src/tools/searchContent.js';
import { buildCalendarFilter } from '../src/calendar/filters.js';

const RELAY_URL = process.env.AMB_RELAY_URL || 'wss://dev.amb-relay.edufeed.org';
const QUERY = process.argv[2] || 'Unaufmerksamkeit im Seminar';

function short(s: string | undefined, n = 120): string {
  if (!s) return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

async function main() {
  console.log(`Relay: ${RELAY_URL}`);
  console.log(`Query: "${QUERY}"\n`);

  const client = new AMBRelayClient(RELAY_URL);

  console.log('=== Test 1: search_content (all types, snippets on) ===');
  const all = await runContentSearch(client, { query: QUERY, limit: 10 });
  console.log(`total=${all.total}`);
  for (const r of all.results) {
    const score = r.score !== undefined ? r.score.toFixed(4) : '   -  ';
    console.log(`  [${r.type.padEnd(8)} k${r.kind}] score=${score}  ${short((r as { title?: string }).title)}`);
    if (r.snippet) console.log(`      snippet: ${short(r.snippet, 140)}`);
  }

  const counts = all.results.reduce<Record<string, number>>((acc, r) => {
    acc[r.type] = (acc[r.type] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`  by type: ${JSON.stringify(counts)}`);
  const withSnip = all.results.filter((r) => r.snippet).length;
  console.log(`  results with snippet: ${withSnip}/${all.total}`);

  console.log('\n=== Test 2: search_content types=[article] ===');
  const articles = await runContentSearch(client, { query: QUERY, types: ['article'], limit: 5 });
  console.log(`total=${articles.total}`);
  for (const r of articles.results) {
    console.log(`  [${r.type} k${r.kind}] ${short((r as { title?: string }).title)}`);
  }
  const offType = articles.results.filter((r) => r.type !== 'article');
  console.log(offType.length === 0 ? '  OK: only articles' : `  WARN: off-type leak: ${offType.length}`);

  console.log('\n=== Test 3: search_content types=[wiki] ===');
  const wikis = await runContentSearch(client, { query: QUERY, types: ['wiki'], limit: 5 });
  console.log(`total=${wikis.total}`);
  for (const r of wikis.results) {
    console.log(`  [${r.type} k${r.kind}] ${short((r as { title?: string }).title)}`);
  }

  console.log('\n=== Test 4: calendar query→search filter shape ===');
  const cal = buildCalendarFilter({ query: QUERY, limit: 5 });
  console.log(`  filter: ${JSON.stringify(cal)}`);
  const calEvents = await client.queryEvents(cal as unknown as Parameters<typeof client.queryEvents>[0]);
  console.log(`  calendar events returned: ${calEvents.length}`);

  client.close();
  console.log('\n✓ smoke complete');
}

main().catch((e) => {
  console.error('SMOKE FAILED:', e);
  process.exit(1);
});
