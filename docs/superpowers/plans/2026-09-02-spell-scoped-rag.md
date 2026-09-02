# Spell-Scoped RAG Grounding (`search_passages`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `search_passages` grounding tool to amb-mcp that resolves a grimoire spell (kind 777) — referenced or built from inline params — into a scope, queries amb-indexer's `/search_chunks` with that scope, and returns ranked cited passages; plus a curated set of published edufeed spells.

**Architecture:** New `src/spells/` module (pure parse/resolve/scope core with injected IO), new `src/indexer/client.ts` HTTP client, one new tool file wired through `registerTools` and the three entrypoints. Spells are the single internal scope representation: inline params become an in-memory spell; one resolve→filter→scope→passages path. No auto-publishing; the canonical spell rides back in every response.

**Tech Stack:** TypeScript ESM, Node 20 (dev via Bun), zod, nostr-tools (`SimplePool`, `nip19`, `Filter`), vitest (`test/**/*.test.ts`), MCP SDK `server.registerTool`.

**Spec:** `docs/superpowers/specs/2026-09-02-spell-scoped-rag-design.md` (same repo — read it first; this plan implements it 1:1).

## Global Constraints

- Repo: `/home/laoc/coding/edufeed/amb-mcp` (work in an isolated worktree per superpowers:using-git-worktrees; `npm install` there once).
- Tool responses are `{ content: [{ type: 'text', text: JSON.stringify(payload) }] }` — same as every existing tool.
- Never widen scope silently: every failure is a structured error payload; no fallback to unscoped search.
- Scope caps: `SCOPE_CAP = 200` (coords AND pubkeys), `MATERIALIZE_REQ_LIMIT = 500`.
- New env vars (exact names): `INDEXER_ENDPOINTS`, `INDEXER_API_TOKEN`, `SPELL_RELAYS` (default `wss://relay.edufeed.org`).
- Tool name: `search_passages`. Spell kind: `777`.
- Run tests with `npx vitest run` (or `npm test`); build check with `npm run build`.
- Commit trailers: end every commit body with the session's `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` line.

---

### Task 1: Spell types + event parsing

**Files:**
- Create: `src/spells/types.ts`
- Create: `src/spells/parse.ts`
- Test: `test/spells/parse.test.ts`

**Interfaces:**
- Consumes: `nostr-tools` `Event` type.
- Produces: `SPELL_KIND`, `Spell`, `SpellTagFilter`, `SpellError` (types.ts); `parseSpellEvent(event: NostrEvent): Spell` (parse.ts). Later tasks import all of these.

- [ ] **Step 1: Write `src/spells/types.ts`** (types only, no test needed on its own)

```ts
import type { Event as NostrEvent } from 'nostr-tools';

export const SPELL_KIND = 777;

export interface SpellTagFilter {
  letter: string; // e.g. 't' — filter becomes {"#t": values}
  values: string[];
}

/**
 * Internal representation of a kind-777 spell (grimoire draft NIP).
 * since/until stay RAW strings here ('7d', 'now', '1700000000') —
 * resolution to absolute timestamps happens in resolve.ts.
 */
export interface Spell {
  cmd: 'REQ';
  name?: string;
  description?: string;
  kinds?: number[];
  authors?: string[]; // may contain '$me' / '$contacts' / npub / hex
  ids?: string[];
  tagFilters?: SpellTagFilter[];
  search?: string;
  since?: string;
  until?: string;
  limit?: number;
  relays?: string[];
}

export type SpellErrorCode =
  | 'not_a_spell'
  | 'count_not_groundable'
  | 'no_filter'
  | 'bad_time'
  | 'me_unresolvable'
  | 'contacts_empty'
  | 'spell_not_found'
  | 'empty_scope'
  | 'no_indexer'
  | 'indexer_error';

export class SpellError extends Error {
  constructor(
    public readonly code: SpellErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'SpellError';
  }
}

export type { NostrEvent };
```

- [ ] **Step 2: Write the failing tests for `parseSpellEvent`**

`test/spells/parse.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseSpellEvent } from '../../src/spells/parse.js';
import { SpellError, SPELL_KIND } from '../../src/spells/types.js';
import type { Event as NostrEvent } from 'nostr-tools';

function spellEvent(tags: string[][], content = 'A spell'): NostrEvent {
  return {
    id: 'a'.repeat(64),
    pubkey: 'b'.repeat(64),
    created_at: 1700000000,
    kind: SPELL_KIND,
    tags,
    content,
    sig: 'c'.repeat(128),
  };
}

describe('parseSpellEvent', () => {
  it('parses the canonical grimoire example', () => {
    const s = parseSpellEvent(
      spellEvent([
        ['cmd', 'REQ'],
        ['name', 'Bitcoin from contacts'],
        ['k', '1'],
        ['authors', '$contacts'],
        ['tag', 't', 'bitcoin'],
        ['since', '7d'],
        ['limit', '50'],
        ['t', 'bitcoin'], // topic tag on the spell itself — NOT a filter
      ])
    );
    expect(s.cmd).toBe('REQ');
    expect(s.name).toBe('Bitcoin from contacts');
    expect(s.kinds).toEqual([1]);
    expect(s.authors).toEqual(['$contacts']);
    expect(s.tagFilters).toEqual([{ letter: 't', values: ['bitcoin'] }]);
    expect(s.since).toBe('7d');
    expect(s.limit).toBe(50);
    expect(s.description).toBe('A spell');
  });

  it('merges multiple k tags and keeps authors multi-value', () => {
    const s = parseSpellEvent(
      spellEvent([
        ['cmd', 'REQ'],
        ['k', '30142'],
        ['k', '30023'],
        ['authors', 'a'.repeat(64), 'b'.repeat(64)],
      ])
    );
    expect(s.kinds).toEqual([30142, 30023]);
    expect(s.authors).toHaveLength(2);
  });

  it('rejects a non-777 event', () => {
    const ev = { ...spellEvent([['cmd', 'REQ'], ['k', '1']]), kind: 1 };
    expect(() => parseSpellEvent(ev)).toThrowError(
      expect.objectContaining({ code: 'not_a_spell' })
    );
  });

  it('rejects a missing cmd tag', () => {
    expect(() => parseSpellEvent(spellEvent([['k', '1']]))).toThrowError(
      expect.objectContaining({ code: 'not_a_spell' })
    );
  });

  it('rejects COUNT spells as not groundable', () => {
    expect(() =>
      parseSpellEvent(spellEvent([['cmd', 'COUNT'], ['k', '1']]))
    ).toThrowError(expect.objectContaining({ code: 'count_not_groundable' }));
  });

  it('rejects a spell with no filter tags', () => {
    expect(() =>
      parseSpellEvent(spellEvent([['cmd', 'REQ'], ['name', 'empty']]))
    ).toThrowError(expect.objectContaining({ code: 'no_filter' }));
  });

  it('parses search, until, ids and relays tags', () => {
    const s = parseSpellEvent(
      spellEvent([
        ['cmd', 'REQ'],
        ['search', 'mathematik'],
        ['until', 'now'],
        ['ids', 'f'.repeat(64)],
        ['relays', 'wss://relay.edufeed.org'],
      ])
    );
    expect(s.search).toBe('mathematik');
    expect(s.until).toBe('now');
    expect(s.ids).toEqual(['f'.repeat(64)]);
    expect(s.relays).toEqual(['wss://relay.edufeed.org']);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/spells/parse.test.ts`
Expected: FAIL — cannot resolve `../../src/spells/parse.js`.

- [ ] **Step 4: Implement `src/spells/parse.ts` (parseSpellEvent only)**

```ts
import { SPELL_KIND, Spell, SpellError, SpellTagFilter } from './types.js';
import type { Event as NostrEvent } from 'nostr-tools';

const FILTER_KEYS = ['kinds', 'authors', 'ids', 'tagFilters', 'search', 'since', 'until'] as const;

/** Parse a kind-777 event into the internal Spell representation. */
export function parseSpellEvent(event: NostrEvent): Spell {
  if (event.kind !== SPELL_KIND) {
    throw new SpellError('not_a_spell', `event kind ${event.kind} is not a spell (777)`);
  }
  let cmd: string | undefined;
  const spell: Spell = { cmd: 'REQ' };
  const kinds: number[] = [];
  const tagFilters: SpellTagFilter[] = [];

  for (const tag of event.tags) {
    const [t, ...rest] = tag;
    switch (t) {
      case 'cmd':
        cmd = rest[0];
        break;
      case 'name':
        spell.name = rest[0];
        break;
      case 'k': {
        const k = Number.parseInt(rest[0], 10);
        if (Number.isFinite(k)) kinds.push(k);
        break;
      }
      case 'authors':
        spell.authors = [...(spell.authors ?? []), ...rest];
        break;
      case 'ids':
        spell.ids = [...(spell.ids ?? []), ...rest];
        break;
      case 'tag':
        if (rest.length >= 2) tagFilters.push({ letter: rest[0], values: rest.slice(1) });
        break;
      case 'search':
        spell.search = rest[0];
        break;
      case 'since':
        spell.since = rest[0];
        break;
      case 'until':
        spell.until = rest[0];
        break;
      case 'limit': {
        const n = Number.parseInt(rest[0], 10);
        if (Number.isFinite(n)) spell.limit = n;
        break;
      }
      case 'relays':
        spell.relays = rest;
        break;
      default:
        break; // 't' topic tags, 'alt', 'client', 'e' fork refs — metadata, not filters
    }
  }

  if (cmd === 'COUNT') {
    throw new SpellError('count_not_groundable', 'COUNT spells return a number — nothing to ground on');
  }
  if (cmd !== 'REQ') {
    throw new SpellError('not_a_spell', 'missing or unsupported cmd tag (expected REQ)');
  }
  if (kinds.length > 0) spell.kinds = kinds;
  if (tagFilters.length > 0) spell.tagFilters = tagFilters;
  if (event.content) spell.description = event.content;

  const hasFilter = FILTER_KEYS.some((k) => spell[k] !== undefined);
  if (!hasFilter) {
    throw new SpellError('no_filter', 'spell has no filter tags — nothing to select');
  }
  return spell;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/spells/parse.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add src/spells/types.ts src/spells/parse.ts test/spells/parse.test.ts
git commit -m "feat(spells): parse kind-777 spell events into an internal Spell"
```

---

### Task 2: Inline params → spell, and the canonical event template

**Files:**
- Modify: `src/spells/parse.ts` (append)
- Test: `test/spells/parse.test.ts` (append)

**Interfaces:**
- Consumes: `Spell`, `SpellError`, `SpellTagFilter` from Task 1.
- Produces: `spellFromParams(p: InlineScopeParams): Spell`, `spellToEventTemplate(s: Spell): { kind: 777; content: string; tags: string[][] }`, `export interface InlineScopeParams`.

- [ ] **Step 1: Append failing tests**

```ts
import { spellFromParams, spellToEventTemplate } from '../../src/spells/parse.js';

describe('spellFromParams', () => {
  it('builds a REQ spell from inline scope', () => {
    const s = spellFromParams({
      authors: ['$me'],
      kinds: [30142],
      tag: { letter: 'h', values: ['e'.repeat(64)] },
      search: 'klima',
      since: '30d',
    });
    expect(s.cmd).toBe('REQ');
    expect(s.kinds).toEqual([30142]);
    expect(s.tagFilters).toEqual([{ letter: 'h', values: ['e'.repeat(64)] }]);
    expect(s.since).toBe('30d');
  });

  it('rejects empty inline scope', () => {
    expect(() => spellFromParams({})).toThrowError(
      expect.objectContaining({ code: 'no_filter' })
    );
  });
});

describe('spellToEventTemplate', () => {
  it('round-trips through parseSpellEvent', () => {
    const original = spellFromParams({ kinds: [30142, 30040], authors: ['a'.repeat(64)], search: 'ki' });
    const tmpl = spellToEventTemplate(original);
    expect(tmpl.kind).toBe(777);
    const reparsed = parseSpellEvent({
      ...tmpl,
      id: '0'.repeat(64), pubkey: '0'.repeat(64), created_at: 1, sig: '0'.repeat(128),
    });
    expect(reparsed.kinds).toEqual([30142, 30040]);
    expect(reparsed.authors).toEqual(['a'.repeat(64)]);
    expect(reparsed.search).toBe('ki');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/spells/parse.test.ts` → FAIL (missing exports).

- [ ] **Step 3: Implement in `src/spells/parse.ts`**

```ts
export interface InlineScopeParams {
  authors?: string[];
  kinds?: number[];
  tag?: SpellTagFilter;
  search?: string;
  since?: string;
  until?: string;
}

/** Inline tool params become an in-memory spell — the one internal scope shape. */
export function spellFromParams(p: InlineScopeParams): Spell {
  const spell: Spell = { cmd: 'REQ' };
  if (p.kinds?.length) spell.kinds = p.kinds;
  if (p.authors?.length) spell.authors = p.authors;
  if (p.tag) spell.tagFilters = [p.tag];
  if (p.search) spell.search = p.search;
  if (p.since) spell.since = p.since;
  if (p.until) spell.until = p.until;
  const hasFilter = FILTER_KEYS.some((k) => spell[k] !== undefined);
  if (!hasFilter) {
    throw new SpellError('no_filter', 'provide a spell or at least one scope parameter');
  }
  return spell;
}

/** Canonical, ready-to-sign kind-777 template (returned in every response). */
export function spellToEventTemplate(s: Spell): { kind: 777; content: string; tags: string[][] } {
  const tags: string[][] = [['cmd', s.cmd]];
  if (s.name) tags.push(['name', s.name]);
  for (const k of s.kinds ?? []) tags.push(['k', String(k)]);
  if (s.authors?.length) tags.push(['authors', ...s.authors]);
  if (s.ids?.length) tags.push(['ids', ...s.ids]);
  for (const tf of s.tagFilters ?? []) tags.push(['tag', tf.letter, ...tf.values]);
  if (s.search) tags.push(['search', s.search]);
  if (s.since) tags.push(['since', s.since]);
  if (s.until) tags.push(['until', s.until]);
  if (s.limit !== undefined) tags.push(['limit', String(s.limit)]);
  if (s.relays?.length) tags.push(['relays', ...s.relays]);
  return { kind: 777, content: s.description ?? '', tags };
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run test/spells/parse.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/spells/parse.ts test/spells/parse.test.ts
git commit -m "feat(spells): inline scope params and canonical spell template"
```

---

### Task 3: Variable + relative-time resolution to a NIP-01 filter

**Files:**
- Create: `src/spells/resolve.ts`
- Test: `test/spells/resolve.test.ts`

**Interfaces:**
- Consumes: `Spell`, `SpellError` (Task 1).
- Produces: `parseTimeValue(v: string, nowSec: number): number`; `interface ResolveContext { me?: string; fetchContacts: (pubkeyHex: string) => Promise<string[]>; nowSec?: number }`; `resolveSpell(spell: Spell, ctx: ResolveContext): Promise<Filter>` (nostr-tools `Filter`).

- [ ] **Step 1: Write failing tests** — `test/spells/resolve.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { parseTimeValue, resolveSpell } from '../../src/spells/resolve.js';
import { spellFromParams } from '../../src/spells/parse.js';
import { nip19 } from 'nostr-tools';

const NOW = 1_760_000_000;
const ME = 'a'.repeat(64);
const noContacts = async () => [];

describe('parseTimeValue', () => {
  it('resolves now, relative units, and absolutes', () => {
    expect(parseTimeValue('now', NOW)).toBe(NOW);
    expect(parseTimeValue('7d', NOW)).toBe(NOW - 7 * 86400);
    expect(parseTimeValue('1mo', NOW)).toBe(NOW - 30 * 86400);
    expect(parseTimeValue('2h', NOW)).toBe(NOW - 7200);
    expect(parseTimeValue('1700000000', NOW)).toBe(1700000000);
  });
  it('rejects garbage', () => {
    expect(() => parseTimeValue('$now-7d', NOW)).toThrowError(
      expect.objectContaining({ code: 'bad_time' })
    );
  });
});

describe('resolveSpell', () => {
  it('maps spell fields onto a NIP-01 filter', async () => {
    const spell = spellFromParams({
      kinds: [30142], search: 'klima', since: '7d',
      tag: { letter: 'h', values: ['e'.repeat(64)] },
    });
    const f = await resolveSpell(spell, { fetchContacts: noContacts, nowSec: NOW });
    expect(f).toEqual({
      kinds: [30142], search: 'klima', since: NOW - 7 * 86400,
      '#h': ['e'.repeat(64)],
    });
  });

  it('resolves $me and npub authors to hex', async () => {
    const npub = nip19.npubEncode('b'.repeat(64));
    const spell = spellFromParams({ authors: ['$me', npub] });
    const f = await resolveSpell(spell, { me: ME, fetchContacts: noContacts, nowSec: NOW });
    expect(f.authors).toEqual([ME, 'b'.repeat(64)]);
  });

  it('errors when $me is unresolvable', async () => {
    const spell = spellFromParams({ authors: ['$me'] });
    await expect(resolveSpell(spell, { fetchContacts: noContacts, nowSec: NOW }))
      .rejects.toMatchObject({ code: 'me_unresolvable' });
  });

  it('expands $contacts via the fetcher', async () => {
    const contacts = ['c'.repeat(64), 'd'.repeat(64)];
    const fetchContacts = vi.fn(async () => contacts);
    const spell = spellFromParams({ authors: ['$contacts'] });
    const f = await resolveSpell(spell, { me: ME, fetchContacts, nowSec: NOW });
    expect(fetchContacts).toHaveBeenCalledWith(ME);
    expect(f.authors).toEqual(contacts);
  });

  it('errors on empty $contacts (spec: MUST NOT send)', async () => {
    const spell = spellFromParams({ authors: ['$contacts'] });
    await expect(resolveSpell(spell, { me: ME, fetchContacts: noContacts, nowSec: NOW }))
      .rejects.toMatchObject({ code: 'contacts_empty' });
  });

  it('carries the spell limit into the filter', async () => {
    const spell = { ...spellFromParams({ kinds: [30142] }), limit: 50 };
    const f = await resolveSpell(spell, { fetchContacts: noContacts, nowSec: NOW });
    expect(f.limit).toBe(50);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/spells/resolve.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/spells/resolve.ts`**

```ts
import type { Filter } from 'nostr-tools';
import { nip19 } from 'nostr-tools';
import { Spell, SpellError } from './types.js';

const UNITS: Record<string, number> = {
  s: 1, m: 60, h: 3600, d: 86400, w: 604800, mo: 2592000, y: 31536000,
};

/** 'now' | '<n><unit>' (s m h d w mo y) | absolute seconds. */
export function parseTimeValue(v: string, nowSec: number): number {
  if (v === 'now') return nowSec;
  if (/^\d+$/.test(v)) return Number.parseInt(v, 10);
  const m = /^(\d+)(mo|[smhdwy])$/.exec(v);
  if (!m) throw new SpellError('bad_time', `invalid since/until value: ${v}`);
  return nowSec - Number.parseInt(m[1], 10) * UNITS[m[2]];
}

export interface ResolveContext {
  /** Executing user's hex pubkey, when known. */
  me?: string;
  /** kind-3 p-tag expansion for $contacts. */
  fetchContacts: (pubkeyHex: string) => Promise<string[]>;
  /** Injected clock (seconds) for tests; defaults to wall time. */
  nowSec?: number;
}

function toHexPubkey(v: string): string {
  if (/^[0-9a-f]{64}$/.test(v)) return v;
  const decoded = nip19.decode(v);
  if (decoded.type === 'npub') return decoded.data;
  throw new SpellError('not_a_spell', `not a pubkey: ${v}`);
}

/** Resolve variables + relative times into a concrete NIP-01 filter. */
export async function resolveSpell(spell: Spell, ctx: ResolveContext): Promise<Filter> {
  const nowSec = ctx.nowSec ?? Math.floor(Date.now() / 1000);
  const filter: Filter = {};

  if (spell.kinds?.length) filter.kinds = spell.kinds;
  if (spell.ids?.length) filter.ids = spell.ids;
  if (spell.search) filter.search = spell.search;
  if (spell.since) filter.since = parseTimeValue(spell.since, nowSec);
  if (spell.until) filter.until = parseTimeValue(spell.until, nowSec);
  if (spell.limit !== undefined) filter.limit = spell.limit;
  for (const tf of spell.tagFilters ?? []) {
    (filter as Record<string, unknown>)[`#${tf.letter}`] = tf.values;
  }

  if (spell.authors?.length) {
    const authors: string[] = [];
    for (const a of spell.authors) {
      if (a === '$me') {
        if (!ctx.me) {
          throw new SpellError(
            'me_unresolvable',
            'spell uses $me but the caller is unknown — pass the `me` parameter (npub or hex)'
          );
        }
        authors.push(ctx.me);
      } else if (a === '$contacts') {
        if (!ctx.me) {
          throw new SpellError(
            'me_unresolvable',
            'spell uses $contacts but the caller is unknown — pass the `me` parameter (npub or hex)'
          );
        }
        const contacts = await ctx.fetchContacts(ctx.me);
        if (contacts.length === 0) {
          throw new SpellError('contacts_empty', 'no kind-3 contact list found for the caller');
        }
        authors.push(...contacts);
      } else {
        authors.push(toHexPubkey(a));
      }
    }
    filter.authors = authors;
  }
  return filter;
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run test/spells/resolve.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/spells/resolve.ts test/spells/resolve.test.ts
git commit -m "feat(spells): resolve \$me/\$contacts and relative times to a NIP-01 filter"
```

---

### Task 4: Scope building (passthrough vs materialize, caps)

**Files:**
- Create: `src/spells/scope.ts`
- Test: `test/spells/scope.test.ts`

**Interfaces:**
- Consumes: `SpellError` (Task 1); nostr-tools `Filter`, `Event`.
- Produces: `SCOPE_CAP = 200`, `MATERIALIZE_REQ_LIMIT = 500`, `interface ScopeResult { mode: 'passthrough' | 'materialized'; chunkFilter: Record<string, unknown>; eventsInScope?: number; truncated: boolean }`, `buildScope(filter: Filter, queryEvents: (f: Filter) => Promise<NostrEvent[]>): Promise<ScopeResult>`.

- [ ] **Step 1: Write failing tests** — `test/spells/scope.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { buildScope, SCOPE_CAP, MATERIALIZE_REQ_LIMIT } from '../../src/spells/scope.js';
import type { Event as NostrEvent } from 'nostr-tools';

function ev(kind: number, pubkey: string, d: string, created_at = 1): NostrEvent {
  return { id: 'e'.repeat(64), pubkey, created_at, kind, tags: [['d', d]], content: '', sig: 's' };
}
const neverQuery = vi.fn(async () => { throw new Error('must not REQ'); });

describe('buildScope — passthrough', () => {
  it('maps authors+kinds directly, no REQ', async () => {
    const scope = await buildScope({ kinds: [30142], authors: ['a'.repeat(64)] }, neverQuery);
    expect(scope.mode).toBe('passthrough');
    expect(scope.chunkFilter).toEqual({ kinds: [30142], pubkey: ['a'.repeat(64)] });
    expect(scope.truncated).toBe(false);
    expect(neverQuery).not.toHaveBeenCalled();
  });

  it('kinds-only is passthrough', async () => {
    const scope = await buildScope({ kinds: [30040] }, neverQuery);
    expect(scope.chunkFilter).toEqual({ kinds: [30040] });
  });

  it('caps a long author list and flags truncation', async () => {
    const authors = Array.from({ length: 300 }, (_, i) => i.toString(16).padStart(64, '0'));
    const scope = await buildScope({ authors }, neverQuery);
    expect((scope.chunkFilter.pubkey as string[]).length).toBe(SCOPE_CAP);
    expect(scope.truncated).toBe(true);
  });

  it('ignores the spell limit in passthrough mode', async () => {
    const scope = await buildScope({ kinds: [30142], limit: 5 }, neverQuery);
    expect(scope.mode).toBe('passthrough');
  });
});

describe('buildScope — materialized', () => {
  it('REQs, derives coords from addressable events, dedupes', async () => {
    const q = vi.fn(async () => [
      ev(30142, 'a'.repeat(64), 'x'), ev(30142, 'a'.repeat(64), 'x'), ev(30023, 'b'.repeat(64), 'y'),
    ]);
    const scope = await buildScope({ kinds: [30142], search: 'klima' }, q);
    expect(scope.mode).toBe('materialized');
    expect(q).toHaveBeenCalledWith({ kinds: [30142], search: 'klima', limit: MATERIALIZE_REQ_LIMIT });
    expect(scope.chunkFilter).toEqual({
      event_coord: [`30142:${'a'.repeat(64)}:x`, `30023:${'b'.repeat(64)}:y`],
    });
    expect(scope.eventsInScope).toBe(2);
  });

  it('honors a smaller spell limit for the REQ', async () => {
    const q = vi.fn(async () => [ev(30142, 'a'.repeat(64), 'x')]);
    await buildScope({ search: 'x', limit: 50 }, q);
    expect(q).toHaveBeenCalledWith({ search: 'x', limit: 50 });
  });

  it('caps coords at SCOPE_CAP newest and flags truncation', async () => {
    const events = Array.from({ length: 250 }, (_, i) =>
      ev(30142, 'a'.repeat(64), `d${i}`, i)
    );
    const scope = await buildScope({ search: 'x' }, async () => events);
    const coords = scope.chunkFilter.event_coord as string[];
    expect(coords.length).toBe(SCOPE_CAP);
    expect(coords[0]).toBe(`30142:${'a'.repeat(64)}:d249`); // newest first
    expect(scope.truncated).toBe(true);
  });

  it('throws empty_scope on zero matches', async () => {
    await expect(buildScope({ search: 'nichts' }, async () => []))
      .rejects.toMatchObject({ code: 'empty_scope' });
  });

  it('skips non-addressable events when deriving coords', async () => {
    const regular = { ...ev(1, 'a'.repeat(64), ''), tags: [] };
    const scope = await buildScope({ search: 'x' }, async () => [regular, ev(30142, 'b'.repeat(64), 'z')]);
    expect(scope.chunkFilter.event_coord).toEqual([`30142:${'b'.repeat(64)}:z`]);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/spells/scope.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/spells/scope.ts`**

```ts
import type { Event as NostrEvent, Filter } from 'nostr-tools';
import { SpellError } from './types.js';

export const SCOPE_CAP = 200;
export const MATERIALIZE_REQ_LIMIT = 500;

export interface ScopeResult {
  mode: 'passthrough' | 'materialized';
  /** Body for /search_chunks `filter` — pubkey/kinds or event_coord. */
  chunkFilter: Record<string, unknown>;
  eventsInScope?: number;
  truncated: boolean;
}

function isPassthrough(filter: Filter): boolean {
  return Object.entries(filter).every(
    ([k, v]) => v === undefined || k === 'kinds' || k === 'authors' || k === 'limit'
  );
}

function coordOf(e: NostrEvent): string | null {
  if (e.kind < 30000 || e.kind >= 40000) return null;
  const d = e.tags.find((t) => t[0] === 'd')?.[1];
  if (d === undefined) return null;
  return `${e.kind}:${e.pubkey}:${d}`;
}

/**
 * Turn a resolved NIP-01 filter into a /search_chunks scope. Authors/kinds-only
 * filters pass through; anything else materializes via one relay REQ.
 */
export async function buildScope(
  filter: Filter,
  queryEvents: (f: Filter) => Promise<NostrEvent[]>
): Promise<ScopeResult> {
  if (isPassthrough(filter)) {
    const chunkFilter: Record<string, unknown> = {};
    let truncated = false;
    if (filter.kinds?.length) chunkFilter.kinds = filter.kinds;
    if (filter.authors?.length) {
      truncated = filter.authors.length > SCOPE_CAP;
      chunkFilter.pubkey = filter.authors.slice(0, SCOPE_CAP);
    }
    return { mode: 'passthrough', chunkFilter, truncated };
  }

  const limit = Math.min(filter.limit ?? MATERIALIZE_REQ_LIMIT, MATERIALIZE_REQ_LIMIT);
  const events = await queryEvents({ ...filter, limit });

  const seen = new Set<string>();
  const withCoord: { coord: string; created_at: number }[] = [];
  for (const e of events) {
    const coord = coordOf(e);
    if (!coord || seen.has(coord)) continue;
    seen.add(coord);
    withCoord.push({ coord, created_at: e.created_at });
  }
  if (withCoord.length === 0) {
    throw new SpellError('empty_scope', 'spell matched no events on the relay — nothing to ground on');
  }
  withCoord.sort((a, b) => b.created_at - a.created_at);
  const truncated = withCoord.length > SCOPE_CAP;
  return {
    mode: 'materialized',
    chunkFilter: { event_coord: withCoord.slice(0, SCOPE_CAP).map((c) => c.coord) },
    eventsInScope: withCoord.length,
    truncated,
  };
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run test/spells/scope.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/spells/scope.ts test/spells/scope.test.ts
git commit -m "feat(spells): build chunk-search scope with passthrough/materialize and caps"
```

---

### Task 5: Indexer HTTP client

**Files:**
- Create: `src/indexer/client.ts`
- Test: `test/indexer/client.test.ts`

**Interfaces:**
- Consumes: `SpellError` (Task 1); `normalizeURL` from `nostr-tools/utils`.
- Produces: `interface PassageHit` (mirrors amb-indexer `SearchHit`: `chunk_id, event_id, event_coord, chunk_idx, text?, snippet, heading?, section_path?, page?, source_url?, score, amb?`); `class IndexerClient { static fromEnv(spec?: string, token?: string): IndexerClient | null; forRelay(relayUrl: string): string | null; searchChunks(relayUrl: string, body: { q: string; k: number; filter: Record<string, unknown> }): Promise<{ hits: PassageHit[]; total: number }> }`.

- [ ] **Step 1: Write failing tests** — `test/indexer/client.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { IndexerClient } from '../../src/indexer/client.js';

const SPEC = 'wss://relay.edufeed.org=https://indexer.edufeed.org, wss://oersi.edufeed.org=https://indexer.oersi.edufeed.org/';

describe('IndexerClient.fromEnv', () => {
  it('parses relay=endpoint pairs, trimming and stripping trailing slash', () => {
    const c = IndexerClient.fromEnv(SPEC, 'tok');
    expect(c?.forRelay('wss://relay.edufeed.org')).toBe('https://indexer.edufeed.org');
    expect(c?.forRelay('wss://oersi.edufeed.org/')).toBe('https://indexer.oersi.edufeed.org');
    expect(c?.forRelay('wss://unknown.example')).toBeNull();
  });
  it('returns null without spec or token', () => {
    expect(IndexerClient.fromEnv(undefined, 'tok')).toBeNull();
    expect(IndexerClient.fromEnv(SPEC, undefined)).toBeNull();
  });
});

describe('searchChunks', () => {
  it('POSTs with bearer auth and returns hits', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ hits: [{ chunk_id: 'c', event_id: 'e', event_coord: '30142:p:d', chunk_idx: 0, snippet: 's', score: 0.9 }], total: 1 }),
      { status: 200 }
    ));
    const c = new IndexerClient(new Map([['wss://relay.edufeed.org', 'https://ix']]), 'tok', fetchImpl as unknown as typeof fetch);
    const res = await c.searchChunks('wss://relay.edufeed.org', { q: 'klima', k: 10, filter: { kinds: [30142] } });
    expect(res.total).toBe(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://ix/search_chunks');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ q: 'klima', k: 10, filter: { kinds: [30142] } });
  });

  it('throws no_indexer for an unmapped relay', async () => {
    const c = new IndexerClient(new Map(), 'tok');
    await expect(c.searchChunks('wss://x', { q: 'q', k: 1, filter: {} }))
      .rejects.toMatchObject({ code: 'no_indexer' });
  });

  it('throws indexer_error on non-2xx', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }));
    const c = new IndexerClient(new Map([['wss://r', 'https://ix']]), 'tok', fetchImpl as unknown as typeof fetch);
    await expect(c.searchChunks('wss://r', { q: 'q', k: 1, filter: {} }))
      .rejects.toMatchObject({ code: 'indexer_error' });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/indexer/client.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/indexer/client.ts`**

```ts
import { normalizeURL } from 'nostr-tools/utils';
import { SpellError } from '../spells/types.js';

export interface PassageHit {
  chunk_id: string;
  event_id: string;
  event_coord: string;
  chunk_idx: number;
  text?: string;
  snippet: string;
  heading?: string;
  section_path?: string;
  page?: number;
  source_url?: string;
  score: number;
  amb?: Record<string, unknown>;
}

function normKey(url: string): string {
  try {
    return normalizeURL(url);
  } catch {
    return url;
  }
}

/** Maps AMB relays to their amb-indexer /search_chunks endpoints. */
export class IndexerClient {
  constructor(
    private readonly endpoints: Map<string, string>,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  /** INDEXER_ENDPOINTS="wss://relay=https://indexer,..." + INDEXER_API_TOKEN. */
  static fromEnv(spec?: string, token?: string): IndexerClient | null {
    if (!spec || !token) return null;
    const map = new Map<string, string>();
    for (const pair of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
      const i = pair.indexOf('=');
      if (i <= 0) {
        throw new Error(`INDEXER_ENDPOINTS entry is not relay=endpoint: ${pair}`);
      }
      map.set(normKey(pair.slice(0, i)), pair.slice(i + 1).replace(/\/+$/, ''));
    }
    return new IndexerClient(map, token);
  }

  forRelay(relayUrl: string): string | null {
    return this.endpoints.get(normKey(relayUrl)) ?? null;
  }

  async searchChunks(
    relayUrl: string,
    body: { q: string; k: number; filter: Record<string, unknown> }
  ): Promise<{ hits: PassageHit[]; total: number }> {
    const base = this.forRelay(relayUrl);
    if (!base) {
      throw new SpellError('no_indexer', `no passage index configured for relay ${relayUrl}`);
    }
    const res = await this.fetchImpl(`${base}/search_chunks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new SpellError('indexer_error', `indexer at ${base} answered ${res.status}`);
    }
    return (await res.json()) as { hits: PassageHit[]; total: number };
  }
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run test/indexer/client.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/indexer/client.ts test/indexer/client.test.ts
git commit -m "feat(indexer): HTTP client for scoped /search_chunks"
```

---

### Task 6: `$me` caller helper on signer.ts

**Files:**
- Modify: `src/tools/signer.ts` (add one export near `getUserId`, ~line 31)
- Test: `test/spells/callerPubkey.test.ts`

**Interfaces:**
- Consumes: existing private `getUserId(extra)` and `getSignerManager()` in `src/tools/signer.ts`; `ConnectionStatus.userPubkey` (`src/signer/manager.ts:64`).
- Produces: `export function getSessionPubkey(extra: unknown): string | null` — the connected NIP-46 signer session's user pubkey for this caller, else null.

- [ ] **Step 1: Add the export to `src/tools/signer.ts`** (verify `getStatus` never throws for unknown users — `src/signer/manager.ts:475` returns `{connected:false}`):

```ts
/**
 * The caller's connected NIP-46 signer pubkey, if any — used by
 * search_passages to resolve $me when the transport itself is anonymous.
 */
export function getSessionPubkey(extra: unknown): string | null {
  const status = getSignerManager().getStatus(getUserId(extra));
  return status.connected && status.userPubkey ? status.userPubkey : null;
}
```

- [ ] **Step 2: Write the test** — `test/spells/callerPubkey.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { getSessionPubkey } from '../../src/tools/signer.js';

describe('getSessionPubkey', () => {
  it('returns null when no signer session exists for the caller', () => {
    expect(getSessionPubkey({ authInfo: { clientPubkey: 'f'.repeat(64) } })).toBeNull();
    expect(getSessionPubkey(undefined)).toBeNull();
  });
});
```

(Positive case needs a live NIP-46 session — covered by manual verification, not unit tests.)

- [ ] **Step 3: Run** — `npx vitest run test/spells/callerPubkey.test.ts` → PASS. Also `npm run build` → clean.

- [ ] **Step 4: Commit**

```bash
git add src/tools/signer.ts test/spells/callerPubkey.test.ts
git commit -m "feat(signer): expose the caller's connected session pubkey"
```

---

### Task 7: The `search_passages` tool + wiring + docs

**Files:**
- Create: `src/tools/searchPassages.ts`
- Modify: `src/tools/index.ts` (import + options + registration in the `profile.read` block)
- Modify: `src/index.ts`, `src/stdio.ts`, `src/http.ts` (env + spellClient/indexer construction, pass into `registerTools`)
- Modify: `README.md` (env table rows for `INDEXER_ENDPOINTS`, `INDEXER_API_TOKEN`, `SPELL_RELAYS`)
- Test: `test/tools/searchPassages.test.ts`

**Interfaces:**
- Consumes: everything produced by Tasks 1–6; `resolveRelaysOrError`/`relaysNotSearched` (`src/tools/relaySelection.ts`); `AMBRelayClient` (`queryEvents(filter, relaySelection?)`); `nip19` from nostr-tools.
- Produces: `registerSearchPassagesTool(server: McpServer, client: AMBRelayClient, spellClient: AMBRelayClient, indexer: IndexerClient): void`; exported for tests: `runSearchPassages(deps, params, extra)`.

- [ ] **Step 1: Write failing tests** — `test/tools/searchPassages.test.ts`. Test the exported `runSearchPassages(deps, params, extra)` core (the thin `registerTool` wrapper is exercised by manual verification):

```ts
import { describe, it, expect, vi } from 'vitest';
import { runSearchPassages } from '../../src/tools/searchPassages.js';
import type { Event as NostrEvent } from 'nostr-tools';

const RELAY = 'wss://relay.edufeed.org';
const HIT = { chunk_id: 'c1', event_id: 'e1', event_coord: `30142:${'a'.repeat(64)}:d1`, chunk_idx: 0, snippet: 'Klimawandel …', score: 0.91 };

function deps(overrides: Partial<Parameters<typeof runSearchPassages>[0]> = {}) {
  return {
    queryContentEvents: vi.fn(async () => [] as NostrEvent[]),
    fetchSpellEvent: vi.fn(async () => null as NostrEvent | null),
    fetchContacts: vi.fn(async () => [] as string[]),
    searchChunks: vi.fn(async () => ({ hits: [HIT], total: 1 })),
    relay: RELAY,
    ...overrides,
  };
}

describe('runSearchPassages', () => {
  it('inline kinds scope → passthrough → passages + canonical spell', async () => {
    const d = deps();
    const out = await runSearchPassages(d, { question: 'klimawandel', kinds: [30142] }, undefined);
    expect(d.searchChunks).toHaveBeenCalledWith(RELAY, {
      q: 'klimawandel', k: 10, filter: { kinds: [30142] },
    });
    expect(out.passages).toHaveLength(1);
    expect(out.scope.mode).toBe('passthrough');
    expect(out.scope.spell.tags).toContainEqual(['cmd', 'REQ']);
    expect(out.scope.spell.tags).toContainEqual(['k', '30142']);
  });

  it('published spell → fetch, parse, materialize, ground', async () => {
    const spellEvent: NostrEvent = {
      id: '1'.repeat(64), pubkey: '2'.repeat(64), created_at: 1, kind: 777, sig: 's',
      content: 'Klima im Unterricht',
      tags: [['cmd', 'REQ'], ['k', '30142'], ['search', 'klima']],
    };
    const content: NostrEvent = {
      id: '3'.repeat(64), pubkey: 'a'.repeat(64), created_at: 5, kind: 30142, sig: 's',
      content: '', tags: [['d', 'd1']],
    };
    const d = deps({
      fetchSpellEvent: vi.fn(async () => spellEvent),
      queryContentEvents: vi.fn(async () => [content]),
    });
    const out = await runSearchPassages(d, { question: 'ursachen', spell: '1'.repeat(64) }, undefined);
    expect(d.queryContentEvents).toHaveBeenCalledWith(
      expect.objectContaining({ kinds: [30142], search: 'klima', limit: 500 })
    );
    expect(d.searchChunks).toHaveBeenCalledWith(RELAY, expect.objectContaining({
      filter: { event_coord: [`30142:${'a'.repeat(64)}:d1`] },
    }));
    expect(out.scope.spell_event_id).toBe('1'.repeat(64));
    expect(out.scope.events_in_scope).toBe(1);
  });

  it('rejects spell + inline scope together', async () => {
    const out = runSearchPassages(deps(), { question: 'q', spell: '1'.repeat(64), kinds: [1] }, undefined);
    await expect(out).rejects.toMatchObject({ code: 'no_filter' });
  });

  it('spell not found → spell_not_found naming the relays', async () => {
    const out = runSearchPassages(deps(), { question: 'q', spell: '1'.repeat(64) }, undefined);
    await expect(out).rejects.toMatchObject({ code: 'spell_not_found' });
  });

  it('$me comes from ContextVM clientPubkey when no me param', async () => {
    const d = deps();
    await runSearchPassages(
      d,
      { question: 'q', authors: ['$me'] },
      { authInfo: { clientPubkey: 'a'.repeat(64) } }
    );
    expect(d.searchChunks).toHaveBeenCalledWith(RELAY, expect.objectContaining({
      filter: { pubkey: ['a'.repeat(64)] },
    }));
  });

  it('empty scope propagates as a structured error, never unscoped search', async () => {
    const d = deps({ queryContentEvents: vi.fn(async () => []) });
    const out = runSearchPassages(d, { question: 'q', search: 'nichts' }, undefined);
    await expect(out).rejects.toMatchObject({ code: 'empty_scope' });
    expect(d.searchChunks).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/tools/searchPassages.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/tools/searchPassages.ts`**

```ts
import { z } from 'zod';
import { nip19 } from 'nostr-tools';
import type { Event as NostrEvent, Filter } from 'nostr-tools';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AMBRelayClient } from '../relay/client.js';
import { IndexerClient, type PassageHit } from '../indexer/client.js';
import { SPELL_KIND, SpellError, type Spell } from '../spells/types.js';
import {
  parseSpellEvent, spellFromParams, spellToEventTemplate, type InlineScopeParams,
} from '../spells/parse.js';
import { resolveSpell } from '../spells/resolve.js';
import { buildScope } from '../spells/scope.js';
import { resolveRelaysOrError, relaysNotSearched } from './relaySelection.js';
import { getSessionPubkey } from './signer.js';

export interface SearchPassagesDeps {
  /** REQ against the effective AMB relay (materialize path). */
  queryContentEvents: (f: Filter) => Promise<NostrEvent[]>;
  /** Fetch a kind-777 event by hex id (spell relays + hints). Null when absent. */
  fetchSpellEvent: (idHex: string, hintRelays: string[]) => Promise<NostrEvent | null>;
  /** Latest kind-3 p-tags for a pubkey ($contacts). */
  fetchContacts: (pubkeyHex: string) => Promise<string[]>;
  /** Scoped chunk search on the effective relay's indexer. */
  searchChunks: (relay: string, body: { q: string; k: number; filter: Record<string, unknown> }) => Promise<{ hits: PassageHit[]; total: number }>;
  /** The effective relay URL for this call. */
  relay: string;
}

export interface SearchPassagesParams extends InlineScopeParams {
  question: string;
  spell?: string;
  me?: string;
  limit?: number;
}

function decodeSpellRef(v: string): { id: string; hints: string[] } {
  if (/^[0-9a-f]{64}$/.test(v)) return { id: v, hints: [] };
  const decoded = nip19.decode(v);
  if (decoded.type === 'nevent') return { id: decoded.data.id, hints: decoded.data.relays ?? [] };
  if (decoded.type === 'note') return { id: decoded.data, hints: [] };
  throw new SpellError('spell_not_found', `not a spell reference (expected nevent/note/hex id): ${v}`);
}

function resolveMe(paramMe: string | undefined, extra: unknown): string | undefined {
  if (paramMe) {
    if (/^[0-9a-f]{64}$/.test(paramMe)) return paramMe;
    const decoded = nip19.decode(paramMe);
    if (decoded.type === 'npub') return decoded.data;
    throw new SpellError('me_unresolvable', `me must be an npub or hex pubkey, got: ${paramMe}`);
  }
  const clientPubkey = (extra as { authInfo?: { clientPubkey?: string } } | undefined)?.authInfo?.clientPubkey;
  return clientPubkey ?? getSessionPubkey(extra) ?? undefined;
}

/** Core flow, transport-free — tested directly; the MCP wrapper below is thin. */
export async function runSearchPassages(
  deps: SearchPassagesDeps,
  params: SearchPassagesParams,
  extra: unknown
) {
  const inline: InlineScopeParams = {
    authors: params.authors, kinds: params.kinds, tag: params.tag,
    search: params.search, since: params.since, until: params.until,
  };
  const hasInline = Object.values(inline).some((v) => v !== undefined);
  if (params.spell && hasInline) {
    throw new SpellError('no_filter', 'pass either spell or inline scope parameters, not both');
  }

  let spell: Spell;
  let spellEventId: string | undefined;
  if (params.spell) {
    const ref = decodeSpellRef(params.spell);
    const event = await deps.fetchSpellEvent(ref.id, ref.hints);
    if (!event) {
      throw new SpellError('spell_not_found', `spell ${ref.id} not found on the configured spell relays`);
    }
    spell = parseSpellEvent(event);
    spellEventId = event.id;
  } else {
    spell = spellFromParams(inline);
  }

  const filter = await resolveSpell(spell, {
    me: resolveMe(params.me, extra),
    fetchContacts: deps.fetchContacts,
  });
  const scope = await buildScope(filter, deps.queryContentEvents);
  const k = Math.min(params.limit ?? 10, 25);
  const res = await deps.searchChunks(deps.relay, { q: params.question, k, filter: scope.chunkFilter });

  return {
    passages: res.hits,
    scope: {
      spell: spellToEventTemplate(spell),
      ...(spellEventId ? { spell_event_id: spellEventId } : {}),
      resolved_filter: filter,
      mode: scope.mode,
      ...(scope.eventsInScope !== undefined ? { events_in_scope: scope.eventsInScope } : {}),
      truncated: scope.truncated,
    },
  };
}

export function registerSearchPassagesTool(
  server: McpServer,
  client: AMBRelayClient,
  spellClient: AMBRelayClient,
  indexer: IndexerClient
): void {
  server.registerTool(
    'search_passages',
    {
      title: 'Grounded passage search (RAG) scoped by a spell',
      description:
        'Retrieve the best-matching fulltext passages for a question, restricted to a ' +
        'scope defined by a grimoire spell (kind 777) — pass a published spell (nevent or ' +
        'event id) OR inline scope (authors/kinds/tag/search/since/until); one is required, not both. ' +
        'Returns ranked passages with citations (source resource, page, heading, source URL) — ' +
        'use them to answer the user and cite the sources. The response also carries the ' +
        'canonical spell for the scope; publish it (e.g. via grimoire) to make the scope reusable. ' +
        'Spells may use $me/$contacts; they resolve to the calling user (pass `me` if the ' +
        'transport is anonymous). Fails rather than widening scope: an empty scope or ' +
        'unreachable index is an error, never an unscoped search.',
      inputSchema: {
        question: z.string().describe('The question or topic to find grounding passages for.'),
        spell: z.string().optional().describe('Published spell: nevent, note id, or 64-hex event id.'),
        authors: z.array(z.string()).optional().describe('Inline scope: author pubkeys (hex/npub/$me/$contacts).'),
        kinds: z.array(z.number()).optional().describe('Inline scope: content kinds (e.g. 30142).'),
        tag: z.object({ letter: z.string(), values: z.array(z.string()) }).optional()
          .describe('Inline scope: one tag filter, e.g. {letter:"h", values:["<community-pk>"]}.'),
        search: z.string().optional().describe('Inline scope: NIP-50 term selecting the EVENTS in scope (distinct from question).'),
        since: z.string().optional().describe('Inline scope: absolute Unix seconds or relative (7d, 1mo, now).'),
        until: z.string().optional().describe('Inline scope: absolute Unix seconds or relative.'),
        me: z.string().optional().describe('Who $me refers to (npub or hex). Defaults to the calling identity.'),
        relays: z.array(z.string()).optional().describe('Relay selection (list_relays set). First mapped relay is used.'),
        limit: z.number().min(1).max(25).optional().default(10).describe('Passages to return (1-25, default 10).'),
      },
    },
    async (params, extra) => {
      const selection = resolveRelaysOrError(client, params.relays);
      if ('errorPayload' in selection) {
        return { content: [{ type: 'text', text: JSON.stringify(selection.errorPayload) }] };
      }
      const relay = selection.relays.find((r) => indexer.forRelay(r)) ?? selection.relays[0];
      const deps: SearchPassagesDeps = {
        relay,
        queryContentEvents: (f) => client.queryEvents(f, [relay]),
        fetchSpellEvent: async (idHex, hints) => {
          const filter = { ids: [idHex], kinds: [SPELL_KIND], limit: 1 };
          const found = await spellClient.queryEvents(filter);
          if (found.length > 0) return found[0];
          if (hints.length > 0) {
            const hintClient = new AMBRelayClient(hints);
            const viaHints = await hintClient.queryEvents(filter);
            if (viaHints.length > 0) return viaHints[0];
          }
          return null;
        },
        fetchContacts: async (pk) => {
          const evs = await spellClient.queryEvents({ kinds: [3], authors: [pk], limit: 1 });
          const latest = evs.sort((a, b) => b.created_at - a.created_at)[0];
          return latest ? latest.tags.filter((t) => t[0] === 'p' && t[1]).map((t) => t[1]) : [];
        },
        searchChunks: (r, body) => indexer.searchChunks(r, body),
      };
      try {
        const out = await runSearchPassages(deps, params as SearchPassagesParams, extra);
        const notSearched = relaysNotSearched(client, [relay]);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              relaySearched: relay,
              ...(notSearched.length > 0 ? { relaysNotSearched: notSearched } : {}),
              ...out,
            }),
          }],
        };
      } catch (err) {
        if (err instanceof SpellError) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: err.code, message: err.message }) }] };
        }
        throw err;
      }
    }
  );
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run test/tools/searchPassages.test.ts` → PASS.

- [ ] **Step 5: Wire registration.** In `src/tools/index.ts`: add `import { registerSearchPassagesTool } from './searchPassages.js';`, `import type { IndexerClient } from '../indexer/client.js';`, extend the options parameter to `options?: { defaultsFromConnectorUrl?: boolean; spellClient?: AMBRelayClient; indexer?: IndexerClient }`, and inside the `if (profile.read)` block append:

```ts
if (options?.indexer && options?.spellClient) {
  registerSearchPassagesTool(server, client, options.spellClient, options.indexer);
}
```

- [ ] **Step 6: Wire all three entrypoints.** In each of `src/index.ts`, `src/stdio.ts`, `src/http.ts`, next to the existing env constants:

```ts
import { IndexerClient } from './indexer/client.js';
const SPELL_RELAYS = process.env.SPELL_RELAYS?.split(',').filter(Boolean) || ['wss://relay.edufeed.org'];
const indexer = IndexerClient.fromEnv(process.env.INDEXER_ENDPOINTS, process.env.INDEXER_API_TOKEN);
```

and where `registerTools` is called, construct `const spellClient = new AMBRelayClient(SPELL_RELAYS);` and pass `{ ...existingOptions, spellClient, indexer: indexer ?? undefined }` as the options argument (keep each entrypoint's existing profile/options intact — in `http.ts` the options object already exists; extend it).

- [ ] **Step 7: README.** Add to the environment table (`README.md`, rows alongside `AMB_RELAYS`):

```markdown
| `INDEXER_ENDPOINTS` | Comma-separated `wss://relay=https://indexer` pairs mapping each AMB relay to its amb-indexer base URL. Enables `search_passages`. | – (tool disabled) |
| `INDEXER_API_TOKEN` | Bearer token for the indexer's `/search_chunks`. | – |
| `SPELL_RELAYS` | Relays to fetch kind-777 spells (and kind-3 contact lists) from. | `wss://relay.edufeed.org` |
```

- [ ] **Step 8: Full check** — `npx vitest run && npm run build` → all green, clean compile.

- [ ] **Step 9: Commit**

```bash
git add src/tools/searchPassages.ts src/tools/index.ts src/index.ts src/stdio.ts src/http.ts README.md test/tools/searchPassages.test.ts
git commit -m "feat(tools): search_passages — spell-scoped RAG grounding"
```

---

### Task 8: Curated edufeed spells + publish script

**Files:**
- Create: `spells/edufeed-amb.json`, `spells/publications.json`, `spells/upcoming-events.json`, `spells/profile.json`
- Create: `spells/publish.mjs`
- Create: `spells/README.md`
- Test: `test/spells/curated.test.ts`

**Interfaces:**
- Consumes: `parseSpellEvent` (Task 1) for validation; `nostr-tools` `finalizeEvent`, `SimplePool`, `nip19`.
- Produces: published kind-777 events under the `edufeed-spells` key (at publish time, not in CI).

- [ ] **Step 1: Write the spell templates.** Each JSON is a full unsigned template. `spells/edufeed-amb.json`:

```json
{
  "kind": 777,
  "content": "Alle Bildungsressourcen (AMB, kind 30142) des edufeed-Netzwerks — der Standard-Scope für RAG-Antworten über offene Bildungsmaterialien.",
  "tags": [
    ["cmd", "REQ"],
    ["name", "Edufeed Bildungsressourcen"],
    ["k", "30142"],
    ["t", "edufeed"],
    ["t", "oer"],
    ["alt", "Spell: REQ für alle kind-30142 Bildungsressourcen"]
  ]
}
```

`spells/publications.json`:

```json
{
  "kind": 777,
  "content": "Wissenschaftliche Publikationen (NKBIP-01, kind 30040) — Scope für Antworten, die sich auf Publikations-Volltexte stützen sollen.",
  "tags": [
    ["cmd", "REQ"],
    ["name", "Edufeed Publikationen"],
    ["k", "30040"],
    ["t", "edufeed"],
    ["t", "publikationen"],
    ["alt", "Spell: REQ für alle kind-30040 Publikationen"]
  ]
}
```

`spells/upcoming-events.json`:

```json
{
  "kind": 777,
  "content": "Kommende Bildungsveranstaltungen (NIP-52 Zeit-Events, kind 31923) der nächsten 90 Tage.",
  "tags": [
    ["cmd", "REQ"],
    ["name", "Kommende Veranstaltungen"],
    ["k", "31923"],
    ["since", "now"],
    ["limit", "200"],
    ["t", "edufeed"],
    ["t", "veranstaltungen"],
    ["alt", "Spell: REQ für kommende kind-31923 Veranstaltungen"]
  ]
}
```

`spells/profile.json` (kind-0 for the key, published by the same script):

```json
{
  "kind": 0,
  "content": "{\"name\":\"edufeed spells\",\"about\":\"Kuratierte Grimoire-Spells (kind 777) für das edufeed-Netzwerk. Quelle: https://git.edufeed.org/edufeed/amb-mcp/src/branch/main/spells\",\"bot\":true}",
  "tags": []
}
```

- [ ] **Step 2: Write the validation test** — `test/spells/curated.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSpellEvent } from '../../src/spells/parse.js';

const dir = join(import.meta.dirname, '../../spells');

describe('curated spells', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'profile.json');
  it('has spell templates', () => expect(files.length).toBeGreaterThan(0));

  for (const f of files) {
    it(`${f} parses as a valid groundable spell`, () => {
      const tmpl = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      const spell = parseSpellEvent({
        ...tmpl,
        id: '0'.repeat(64), pubkey: '0'.repeat(64), created_at: 1, sig: '0'.repeat(128),
      });
      expect(spell.cmd).toBe('REQ');
      expect(spell.name).toBeTruthy();
    });
  }
});
```

- [ ] **Step 3: Run** — `npx vitest run test/spells/curated.test.ts` → PASS (fails first if templates are malformed — fix until green).

- [ ] **Step 4: Write `spells/publish.mjs`** (run manually, never in CI; key via env, never printed):

```js
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
```

- [ ] **Step 5: Dry-run check** — `EDUFEED_SPELLS_NSEC=$(node -e "const{generateSecretKey}=require('nostr-tools');const{nsecEncode}=require('nostr-tools/nip19');process.stdout.write(nsecEncode(generateSecretKey()))") node spells/publish.mjs --dry-run` → lists all four templates, publishes nothing.

- [ ] **Step 6: Write `spells/README.md`** — three short sections: what these are (curated kind-777 scopes for `search_passages` and grimoire), how to publish (the env-var invocation above, real key lives in the homelab vault as `vault_edufeed_spells_nsec`), and the immutability/fork rule (revise = new event + `e` tag to the old one).

- [ ] **Step 7: Full suite + commit**

```bash
npx vitest run && npm run build
git add spells/ test/spells/curated.test.ts
git commit -m "feat(spells): curated edufeed spell templates and publish script"
```

---

### Task 9: amb-indexer — land the scope filters on main

**Files (repo `/home/laoc/coding/edufeed/amb-indexer`):**
- Modify: `cmd/mcp/tool.go` (comment at lines 16-18)
- Branch: merge `feat/scoped-chunk-search` (single commit `9f47f5a`) into `main`

**Interfaces:**
- Produces: `/search_chunks` accepting `filter.pubkey` and `filter.event_coord` on main — deployed indexers gain the scope dimensions amb-mcp's `search_passages` requires.

- [ ] **Step 1: Fix the stale comment** on `feat/scoped-chunk-search`. `cmd/mcp/tool.go:16-18` claims the MCP tool mirrors "the four-field allowlist"; the HTTP API now has six. Replace the comment with:

```go
// SearchToolFilter mirrors the subset of the HTTP API's filter allowlist
// exposed over MCP. The HTTP layer additionally accepts pubkey and
// event_coord scope filters (search.go buildFilterBy), which are not
// surfaced here — scoped grounding goes through amb-mcp's search_passages.
```

- [ ] **Step 2: Test + commit**

```bash
cd /home/laoc/coding/edufeed/amb-indexer
go test ./...            # expected: all packages PASS
git add cmd/mcp/tool.go
git commit -m "docs(mcp): correct the filter-allowlist comment after scope filters"
```

- [ ] **Step 3: Merge to main and push** (git-over-nostr remotes need the sandbox disabled; verify the remote first with `git remote -v`):

```bash
git checkout main
git merge --ff-only feat/scoped-chunk-search   # fails if not a fast-forward — investigate, don't force
go test ./...
git push origin main
git checkout feat/scoped-chunk-search          # leave the worktree back on the branch
```

Expected: `main` gains exactly 2 commits (`9f47f5a` + the comment fix); CI builds the image.

---

### Task 10: Deployment prep (homelab) — GATED, coordinate with user

**Files (repo `/home/laoc/coding/homelab`):** amb-mcp's deployment env (locate the deployed amb-mcp service definition first — as of the spec date amb-mcp had no ansible-edufeed entry; find where `mcp.amb.edufeed.org` is deployed before editing) and `inventory/group_vars/all/vault.yml`.

**Do not execute this task without an explicit go-ahead in the session — it touches production config and the vault.**

- [ ] **Step 1: Generate the `edufeed-spells` key** locally: `nak key generate` → keep the nsec only in the vault (never print/commit it); record the npub in `spells/README.md`.
- [ ] **Step 2: Add `vault_edufeed_spells_nsec` via `ansible-vault edit inventory/group_vars/all/vault.yml`** (interactive — hand to the user with the `!` prefix if the permission system balks).
- [ ] **Step 3: Add to the amb-mcp deployment env**: `INDEXER_ENDPOINTS` (each prod relay → its indexer's internal URL — confirm reachable from the amb-mcp container: the indexers listen on `:8080` inside their stacks; cross-stack access needs either the shared `proxy` network aliases or public HTTPS routes), `INDEXER_API_TOKEN` (the existing per-instance indexer token), `SPELL_RELAYS=wss://relay.edufeed.org`.
- [ ] **Step 4: Publish the curated spells**: `EDUFEED_SPELLS_NSEC=<from vault> node spells/publish.mjs` (user runs it, or vault-sourced without echoing).
- [ ] **Step 5: Verify end-to-end**: from a stdio session with dev env (`INDEXER_ENDPOINTS` → dev indexer, `SPELL_RELAYS` → relay.edufeed.org), call `search_passages` with one published spell id and confirm passages return with citations and `scope.spell_event_id` set.

---

## Self-review notes

- Spec coverage: tool interface (T7), spell-as-only-representation (T2+T7), full variable/time resolution (T3), passthrough/materialize + caps (T4), indexer wiring (T5+T7+T10), curated spells + dedicated key (T8+T10), amb-indexer merge + comment fix (T9), errors (SpellError throughout, structured payloads in T7), unit tests per module, e2e verification (T10 step 5). Integration test against the dev compose stack (spec §7) is folded into T10 step 5 as manual verification — the compose stack lacks an indexer service, so a fully automated integration test would need new infra; deliberately out of scope.
- The `me_unresolvable` message in T3 names the fix (`me` param) per spec §6.
- Type consistency: `Spell`/`SpellError`/`ScopeResult`/`PassageHit`/`SearchPassagesDeps` names match across tasks; `chunkFilter` (internal) vs `filter` (HTTP body key) is intentional and localized in T7's `searchChunks` call.
