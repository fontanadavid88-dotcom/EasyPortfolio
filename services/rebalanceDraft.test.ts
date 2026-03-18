import { beforeEach, describe, expect, it } from 'vitest';
import { clearDraft, getDraftAgeLabel, getDraftKey, loadDraft, saveDraft } from './rebalanceDraft';

describe('rebalanceDraft', () => {
  beforeEach(() => {
    if (typeof localStorage === 'undefined') {
      const store = new Map<string, string>();
      (globalThis as any).localStorage = {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, value); },
        removeItem: (key: string) => { store.delete(key); },
        clear: () => { store.clear(); },
        key: (index: number) => Array.from(store.keys())[index] ?? null,
        get length() { return store.size; }
      };
    } else {
      localStorage.clear();
    }
  });

  it('save/load roundtrip works per portfolio', () => {
    const payload = { v: 1 as const, portfolioId: 'p1', savedAt: Date.now(), strategy: 'ACCUMULATE', totalAmount: 1200 };
    saveDraft('p1', payload);
    expect(loadDraft('p1')).toMatchObject({ portfolioId: 'p1', strategy: 'ACCUMULATE', totalAmount: 1200 });
    expect(loadDraft('p2')).toBeNull();
    clearDraft('p1');
    expect(loadDraft('p1')).toBeNull();
  });

  it('loadDraft clears corrupted JSON', () => {
    const key = getDraftKey('p1');
    localStorage.setItem(key, '{invalid-json');
    expect(loadDraft('p1')).toBeNull();
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('getDraftAgeLabel returns "ora" for recent timestamps', () => {
    expect(getDraftAgeLabel(Date.now())).toBe('ora');
  });
});
