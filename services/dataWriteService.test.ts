import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Currency } from '../types';

type MockPriceRow = {
  id?: number;
  portfolioId?: string;
  instrumentId?: string;
  ticker: string;
  date: string;
  close: number;
  currency: Currency;
};

type MockFxRow = {
  id?: number;
  baseCurrency: Currency;
  quoteCurrency: Currency;
  date: string;
  rate: number;
  source?: string;
};

const state = {
  instruments: [] as any[],
  prices: [] as MockPriceRow[],
  fxRates: [] as MockFxRow[]
};

let nextPriceId = 1000;
let nextFxId = 2000;

vi.mock('../db', () => {
  const priceQueryState: { ticker?: string; from?: string; to?: string; predicate?: (row: MockPriceRow) => boolean } = {};
  const fxQueryState: { base?: Currency; quote?: Currency; from?: string; to?: string } = {};

  const pricesTable = {
    where: vi.fn(() => pricesTable),
    between: vi.fn((rangeStart: [string, string], rangeEnd: [string, string]) => {
      priceQueryState.ticker = rangeStart[0];
      priceQueryState.from = rangeStart[1];
      priceQueryState.to = rangeEnd[1];
      return pricesTable;
    }),
    and: vi.fn((predicate: (row: MockPriceRow) => boolean) => {
      priceQueryState.predicate = predicate;
      return pricesTable;
    }),
    toArray: vi.fn(async () => {
      return state.prices.filter(row => {
        if (priceQueryState.ticker && row.ticker !== priceQueryState.ticker) return false;
        if (priceQueryState.from && row.date < priceQueryState.from) return false;
        if (priceQueryState.to && row.date > priceQueryState.to) return false;
        if (priceQueryState.predicate && !priceQueryState.predicate(row)) return false;
        return true;
      });
    }),
    bulkPut: vi.fn(async (rows: MockPriceRow[]) => {
      rows.forEach(row => {
        if (row.id !== undefined) {
          const idx = state.prices.findIndex(existing => existing.id === row.id);
          if (idx >= 0) {
            state.prices[idx] = { ...state.prices[idx], ...row };
            return;
          }
        }
        state.prices.push({ ...row, id: row.id ?? nextPriceId++ });
      });
    }),
    bulkDelete: vi.fn(async (ids: number[]) => {
      state.prices = state.prices.filter(row => !ids.includes(row.id as number));
    })
  };

  const fxRatesTable = {
    where: vi.fn(() => fxRatesTable),
    between: vi.fn((rangeStart: [Currency, Currency, string], rangeEnd: [Currency, Currency, string]) => {
      fxQueryState.base = rangeStart[0];
      fxQueryState.quote = rangeStart[1];
      fxQueryState.from = rangeStart[2];
      fxQueryState.to = rangeEnd[2];
      return fxRatesTable;
    }),
    toArray: vi.fn(async () => {
      return state.fxRates.filter(row => {
        if (fxQueryState.base && row.baseCurrency !== fxQueryState.base) return false;
        if (fxQueryState.quote && row.quoteCurrency !== fxQueryState.quote) return false;
        if (fxQueryState.from && row.date < fxQueryState.from) return false;
        if (fxQueryState.to && row.date > fxQueryState.to) return false;
        return true;
      });
    }),
    bulkPut: vi.fn(async (rows: MockFxRow[]) => {
      rows.forEach(row => {
        if (row.id !== undefined) {
          const idx = state.fxRates.findIndex(existing => existing.id === row.id);
          if (idx >= 0) {
            state.fxRates[idx] = { ...state.fxRates[idx], ...row };
            return;
          }
        }
        state.fxRates.push({ ...row, id: row.id ?? nextFxId++ });
      });
    }),
    bulkDelete: vi.fn(async (ids: number[]) => {
      state.fxRates = state.fxRates.filter(row => !ids.includes(row.id as number));
    })
  };

  const instrumentsTable = {
    where: vi.fn(() => instrumentsTable),
    equals: vi.fn((portfolioId: string) => ({
      toArray: vi.fn(async () => state.instruments.filter(row => (row.portfolioId || 'default') === portfolioId))
    }))
  };

  return {
    db: {
      instruments: instrumentsTable,
      prices: pricesTable,
      fxRates: fxRatesTable,
      transaction: async (...args: any[]) => {
        const callback = args[args.length - 1];
        return callback();
      }
    }
  };
});

const { upsertPriceRowsByNaturalKey, upsertFxRowsByNaturalKey } = await import('./dataWriteService');

describe('dataWriteService', () => {
  beforeEach(() => {
    state.instruments = [];
    state.prices = [];
    state.fxRates = [];
    nextPriceId = 1000;
    nextFxId = 2000;
  });

  it('upserts prices by natural key, keeps a single row and attaches instrumentId', async () => {
    state.instruments = [
      { id: 10, portfolioId: 'p1', ticker: 'AAA', symbol: 'AAA.US', preferredListing: { symbol: 'AAA.US' } }
    ];
    state.prices = [
      { id: 1, portfolioId: 'p1', ticker: 'AAA', date: '2026-01-10', close: 100, currency: Currency.USD },
      { id: 2, portfolioId: 'p1', ticker: 'AAA', date: '2026-01-10', close: 100, currency: Currency.USD }
    ];

    const result = await upsertPriceRowsByNaturalKey([
      { portfolioId: 'p1', ticker: 'AAA', date: '2026-01-10', close: 101, currency: Currency.USD } as any,
      { portfolioId: 'p1', ticker: 'AAA', date: '2026-01-10', close: 102, currency: Currency.USD } as any
    ]);

    expect(result.deduped).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.deletedDuplicates).toBe(1);
    expect(state.prices).toHaveLength(1);
    expect(state.prices[0].id).toBe(1);
    expect(state.prices[0].close).toBe(102);
    expect(state.prices[0].instrumentId).toBe('10');

    const second = await upsertPriceRowsByNaturalKey([
      { portfolioId: 'p1', ticker: 'AAA', date: '2026-01-10', close: 102, currency: Currency.USD } as any
    ]);
    expect(second.unchanged).toBe(1);
    expect(second.updated).toBe(0);
    expect(state.prices).toHaveLength(1);
  });

  it('normalizes latest dates and collapses pre-existing same-day duplicates', async () => {
    state.prices = [
      { id: 21, portfolioId: 'p1', ticker: 'AAA', date: '2026-04-09', close: 100, currency: Currency.USD },
      { id: 22, portfolioId: 'p1', ticker: 'AAA', date: '2026-04-09T09:15:00Z', close: 100, currency: Currency.USD }
    ];

    const result = await upsertPriceRowsByNaturalKey([
      { portfolioId: 'p1', ticker: 'AAA', date: '2026-04-09T16:45:00Z', close: 105, currency: Currency.USD } as any
    ]);

    expect(result.updated).toBe(1);
    expect(result.deletedDuplicates).toBe(1);
    expect(state.prices).toHaveLength(1);
    expect(state.prices[0].id).toBe(21);
    expect(state.prices[0].date).toBe('2026-04-09');
    expect(state.prices[0].close).toBe(105);
  });

  it('upserts FX by natural key and removes duplicate rows', async () => {
    state.fxRates = [
      { id: 11, baseCurrency: Currency.EUR, quoteCurrency: Currency.CHF, date: '2026-01-10', rate: 0.93, source: 'old' },
      { id: 12, baseCurrency: Currency.EUR, quoteCurrency: Currency.CHF, date: '2026-01-10', rate: 0.93, source: 'old' }
    ];

    const result = await upsertFxRowsByNaturalKey([
      { baseCurrency: Currency.EUR, quoteCurrency: Currency.CHF, date: '2026-01-10', rate: 0.95, source: 'manual' },
      { baseCurrency: Currency.EUR, quoteCurrency: Currency.CHF, date: '2026-01-10', rate: 0.95, source: 'manual' }
    ]);

    expect(result.deduped).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.deletedDuplicates).toBe(1);
    expect(state.fxRates).toHaveLength(1);
    expect(state.fxRates[0].id).toBe(11);
    expect(state.fxRates[0].rate).toBe(0.95);
    expect(state.fxRates[0].source).toBe('manual');
  });
});
