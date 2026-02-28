import { describe, expect, it, beforeEach } from 'vitest';
import { addHiddenTicker, getHiddenTickersForPortfolio, removeHiddenTicker } from './portfolioVisibility';

describe('portfolioVisibility', () => {
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

  it('adds and removes hidden tickers per portfolio', () => {
    addHiddenTicker('p1', 'AAPL.US');
    addHiddenTicker('p1', 'AAPL.US');
    addHiddenTicker('p1', 'BTC-USD.SW');
    expect(getHiddenTickersForPortfolio('p1')).toEqual(['AAPL.US', 'BTC-USD.SW']);

    removeHiddenTicker('p1', 'AAPL.US');
    expect(getHiddenTickersForPortfolio('p1')).toEqual(['BTC-USD.SW']);
  });
});
