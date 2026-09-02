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
