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
  let decoded: ReturnType<typeof nip19.decode>;
  try {
    decoded = nip19.decode(v);
  } catch {
    throw new SpellError('spell_not_found', `not a spell reference (expected nevent/note/hex id): ${v}`);
  }
  if (decoded.type === 'nevent') return { id: decoded.data.id, hints: decoded.data.relays ?? [] };
  if (decoded.type === 'note') return { id: decoded.data, hints: [] };
  throw new SpellError('spell_not_found', `not a spell reference (expected nevent/note/hex id): ${v}`);
}

function resolveMe(paramMe: string | undefined, extra: unknown): string | undefined {
  if (paramMe) {
    if (/^[0-9a-f]{64}$/.test(paramMe)) return paramMe;
    let decoded: ReturnType<typeof nip19.decode>;
    try {
      decoded = nip19.decode(paramMe);
    } catch {
      throw new SpellError('me_unresolvable', `me must be an npub or hex pubkey, got: ${paramMe}`);
    }
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
  // A tag filter with an empty `values` array is a vacuous filter — treat
  // it as absent rather than forwarding it into spellFromParams, where an
  // empty-values tag would otherwise slip through as a filter key.
  const tag = params.tag && params.tag.values.length > 0 ? params.tag : undefined;
  const inline: InlineScopeParams = {
    authors: params.authors, kinds: params.kinds, tag,
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
            try {
              const viaHints = await hintClient.queryEvents(filter);
              if (viaHints.length > 0) return viaHints[0];
            } finally {
              hintClient.close();
            }
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
