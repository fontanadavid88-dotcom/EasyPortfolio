import { beforeEach, describe, expect, it, vi } from 'vitest';
import { backfillPricesForPortfolio } from './priceService';
import { fetchJsonWithDiagnostics } from './diagnostics';
import { checkProxyHealth } from './apiHealthService';
import { db } from '../db';

vi.mock('../db', () => {
  const pricesTable = {
    where: vi.fn().mockReturnThis(),
    between: vi.fn().mockReturnThis(),
    and: vi.fn().mockReturnThis(),
    sortBy: vi.fn().mockResolvedValue([]),
    bulkPut: vi.fn().mockResolvedValue(undefined)
  };
  const settingsTable = {
    where: vi.fn().mockReturnThis(),
    equals: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue({
      eodhdApiKey: 'local-key',
      baseCurrency: 'CHF',
      priceTickerConfig: {}
    })
  };
  const instrumentsTable = {
    where: vi.fn().mockReturnThis(),
    equals: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockResolvedValue([
      {
        id: 1,
        ticker: 'BTC-USD.SW',
        type: 'Crypto',
        currency: 'USD'
      }
    ])
  };
  return {
    db: {
      prices: pricesTable,
      settings: settingsTable,
      instruments: instrumentsTable
    }
  };
});

vi.mock('./diagnostics', async () => {
  const actual = await vi.importActual('./diagnostics') as typeof import('./diagnostics');
  return {
    ...actual,
    fetchJsonWithDiagnostics: vi.fn()
  };
});

vi.mock('./apiHealthService', () => ({
  checkProxyHealth: vi.fn()
}));

const fetchMock = fetchJsonWithDiagnostics as unknown as {
  mockReset: () => void;
  mockResolvedValueOnce: (value: any) => void;
  mock: { calls: any[] };
};
const healthMock = checkProxyHealth as unknown as {
  mockReset: () => void;
  mockResolvedValue: (value: any) => void;
};

beforeEach(() => {
  fetchMock.mockReset();
  healthMock.mockReset();
  (db.prices.bulkPut as any).mockClear?.();
  (db.prices as any).sortBy?.mockResolvedValue([]);
  if (typeof localStorage !== 'undefined') localStorage.clear();
});

describe('backfillPricesForPortfolio AUTO_GAPS', () => {
  it('fills most recent internal gap instead of tail range', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-20T12:00:00Z'));
    try {
      healthMock.mockResolvedValue({
        ok: true,
        tested: true,
        hasEodhdKey: true,
        usingLocalKey: true,
        mode: 'vercel-proxy'
      });

      (db.prices as any).sortBy.mockResolvedValueOnce([
        { date: '2026-01-16' },
        { date: '2026-02-04' }
      ]);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        httpStatus: 200,
        contentType: 'application/json',
        rawPreview: '',
        json: [{ date: '2026-01-20', close: 100 }]
      });

      const promise = backfillPricesForPortfolio(
        'p1',
        ['BTC-USD.SW'],
        '2020-01-01',
        undefined,
        'local-key',
        { mode: 'AUTO_GAPS', maxApiCallsPerRun: 1, maxLookbackDays: 90, staleThresholdDays: 7, sleepMs: 0 }
      );
      await vi.runAllTimersAsync();
      const result = await promise;

      const url = fetchMock.mock.calls[0]?.[0] as string;
      expect(url).toContain('from=2026-01-17');
      expect(url).toContain('to=2026-02-03');
      expect(result.updatedTickers).toContain('BTC-USD.SW');
      expect((db.prices.bulkPut as any).mock.calls.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
