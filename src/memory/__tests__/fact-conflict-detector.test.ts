import { describe, it, expect } from 'vitest';
import { detectConflicts, FactConflict } from '../fact-conflict-detector.js';

describe('Fact Conflict Detector', () => {
  it('detects numeric conflict', async () => {
    const existing = { budget: '100', city: 'Beijing' };
    const incoming = { budget: '200', city: 'Shanghai' };
    const result = await detectConflicts(existing, incoming);
    expect(result.hasConflict).toBe(true);
    const budgetConflict = result.conflicts.find(c => c.oldFact.includes('budget'));
    expect(budgetConflict).toBeDefined();
    expect(budgetConflict?.type).toBe('numeric');
    expect(budgetConflict?.resolution).toBe('replace');
  });

  it('detects entity replacement conflict', async () => {
    const existing = { city: 'Beijing', language: 'Chinese' };
    const incoming = { city: 'Shanghai', language: 'English' };
    const result = await detectConflicts(existing, incoming);
    expect(result.hasConflict).toBe(true);
    const cityConflict = result.conflicts.find(c => c.oldFact.includes('city'));
    expect(cityConflict?.type).toBe('entity');
  });

  it('detects boolean flip conflict', async () => {
    const existing = { like_market: '是', enabled: 'true' };
    const incoming = { like_market: '否', enabled: 'false' };
    const result = await detectConflicts(existing, incoming);
    expect(result.hasConflict).toBe(true);
    const likeConflict = result.conflicts.find(c => c.oldFact.includes('like_market'));
    expect(likeConflict?.type).toBe('boolean');
  });

  it('no conflict when facts are identical', async () => {
    const existing = { budget: '100', city: 'Beijing' };
    const incoming = { budget: '100', city: 'Beijing' };
    const result = await detectConflicts(existing, incoming);
    expect(result.hasConflict).toBe(false);
  });

  it('no conflict when new fact has no existing counterpart', async () => {
    const existing = { budget: '100' };
    const incoming = { city: 'Shanghai', new_key: 'value' };
    const result = await detectConflicts(existing, incoming);
    expect(result.hasConflict).toBe(false);
  });

  it('handles partial overlap', async () => {
    const existing = { budget: '100', city: 'Beijing', lang: 'zh' };
    const incoming = { budget: '200', country: 'China' };
    const result = await detectConflicts(existing, incoming);
    expect(result.hasConflict).toBe(true);
    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0].oldFact).toContain('budget');
  });

  it('Chinese boolean synonyms', async () => {
    const existing = { preference: '喜欢' };
    const incoming = { preference: '不喜欢' };
    const result = await detectConflicts(existing, incoming);
    expect(result.hasConflict).toBe(true);
    expect(result.conflicts[0].type).toBe('boolean');
  });

  it('English boolean synonyms', async () => {
    const existing = { setting: 'yes' };
    const incoming = { setting: 'no' };
    const result = await detectConflicts(existing, incoming);
    expect(result.hasConflict).toBe(true);
    expect(result.conflicts[0].type).toBe('boolean');
  });

  it('numeric string with decimals', async () => {
    const existing = { price: '99.9' };
    const incoming = { price: '199.99' };
    const result = await detectConflicts(existing, incoming);
    expect(result.hasConflict).toBe(true);
    expect(result.conflicts[0].type).toBe('numeric');
  });

  it('non-numeric strings that look like numbers but are not', async () => {
    const existing = { version: '1.0.0' };
    const incoming = { version: '2.0.0' };
    const result = await detectConflicts(existing, incoming);
    // version strings parse as NaN, so treated as entity conflict
    expect(result.hasConflict).toBe(true);
    expect(result.conflicts[0].type).toBe('entity');
  });

  it('empty inputs', async () => {
    const result = await detectConflicts({}, {});
    expect(result.hasConflict).toBe(false);
    expect(result.conflicts).toEqual([]);
  });
});