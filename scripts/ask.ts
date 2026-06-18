#!/usr/bin/env bun
/**
 * Interactive-style runner: pose a natural-language question to the MCP's
 * search_content (and an optional calendar follow-up), printing the full
 * structured result an LLM client would receive.
 *
 * Usage:
 *   bun run scripts/ask.ts "Meine Studierenden sind im Seminar unaufmerksam, was tun?"
 *   CAL=1 bun run scripts/ask.ts "..."        # also run the calendar hop
 *   TYPES=article,wiki bun run scripts/ask.ts "..."
 */

import { AMBRelayClient } from '../src/relay/client.js';
import { runContentSearch } from '../src/tools/searchContent.js';
import { buildCalendarFilter } from '../src/calendar/filters.js';
import type { ContentType } from '../src/content/types.js';

const RELAY_URL = process.env.AMB_RELAY_URL || 'wss://dev.amb-relay.edufeed.org';
const QUERY = process.argv[2] || '';
const LIMIT = Number(process.env.LIMIT || 8);
const TYPES = (process.env.TYPES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean) as ContentType[];

if (!QUERY) {
  console.error('Pass a question: bun run scripts/ask.ts "your question"');
  process.exit(1);
}

function clip(s: string | undefined, n = 200): string {
  if (!s) return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

async function main() {
  const client = new AMBRelayClient(RELAY_URL);

  console.log(`❓ ${QUERY}`);
  console.log(`   relay=${RELAY_URL} limit=${LIMIT}${TYPES.length ? ` types=${TYPES.join(',')}` : ''}\n`);

  const out = await runContentSearch(client, {
    query: QUERY,
    limit: LIMIT,
    ...(TYPES.length ? { types: TYPES } : {}),
  });

  console.log(`search_content → ${out.total} result(s)\n`);
  out.results.forEach((r, i) => {
    const score = r.score !== undefined ? ` score=${r.score.toFixed(4)}` : '';
    console.log(`${i + 1}. [${r.type} k${r.kind}]${score}  ${r.title}`);
    const desc =
      r.type === 'resource'
        ? r.description
        : 'summary' in r
          ? r.summary || r.excerpt
          : undefined;
    if (desc) console.log(`   ${clip(desc)}`);
    if (r.snippet) console.log(`   ↳ passage: ${clip(r.snippet, 240)}`);
    if (r.naddr) console.log(`   naddr: ${r.naddr}`);
    if (r.url) console.log(`   url:   ${r.url}`);
    console.log();
  });

  if (process.env.CAL) {
    const now = Math.floor(Date.now() / 1000);
    const week = now + 7 * 24 * 3600;
    const calFilter = buildCalendarFilter({ query: QUERY, startAfter: now, startBefore: week, limit: 10 });
    console.log(`search_calendar_events (next 7 days) filter: ${JSON.stringify(calFilter)}`);
    const calEvents = await client.queryEvents(calFilter as unknown as Parameters<typeof client.queryEvents>[0]);
    console.log(`  → ${calEvents.length} calendar event(s)`);
    for (const e of calEvents) {
      const title = e.tags.find((t) => t[0] === 'title')?.[1] || '(untitled)';
      const start = e.tags.find((t) => t[0] === 'start')?.[1] || '?';
      console.log(`    - ${title}  (start=${start})`);
    }
  }

  client.close();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
