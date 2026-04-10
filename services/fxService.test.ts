import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Currency } from '../types';
import { backfillFxRatesForPortfolio, dedupeFxRows, fetchEodhdFxRange } from './fxService';
import { fetchJsonWithDiagnostics } from './diagnostics';
import { checkProxyHealth } from './apiHealthService';
import { db } from '../db';

vi.mock('./dataWriteService', () => ({
  upsertFxRowsByNaturalKey: vi.fn().mockResolvedValue({
    received: 0,
    deduped: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    deletedDuplicates: 0,
    written: 0
  })
}));

vi.mock('../db', () => {
  const fxRatesTable = {
    where: vi.fn().mockReturnThis(),
    between: vi.fn().mockReturnThis(),
    sortBy: vi.fn().mockResolvedValue([]),
    bulkPut: vi.fn().mockResolvedValue(undefined)
  };
  const settingsTable = {
    where: vi.fn().mockReturnThis(),
    equals: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue({ eodhdApiKey: 'local-key', baseCurrency: 'CHF' })
  };
  const instrumentsTable = {
    where: vi.fn().mockReturnThis(),
    equals: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockResolvedValue([])
  };
  return {
    db: {
      fxRates: fxRatesTable,
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

const fetchMock = fetchJsonWithDiagnostics as unknown as { mockReset: () => void; mockResolvedValueOnce: (v: any) => void; mockImplementation: (fn: any) => void; mock: { calls: any[] } };
const { upsertFxRowsByNaturalKey } = await import('./dataWriteService');
const healthMock = checkProxyHealth as unknown as { mockReset: () => void; mockResolvedValue: (v: any) => void };

beforeEach(() => {
  fetchMock.mockReset();
  healthMock.mockReset();
  (upsertFxRowsByNaturalKey as any).mockClear?.();
  (db.fxRates as any).sortBy?.mockResolvedValue([]);
  if (typeof localStorage !== 'undefined') localStorage.clear();
});

afterEach(() => {});

describe('fetchEodhdFxRange', () => {
  it('inverts rates when inverse symbol is returned', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      httpStatus: 404,
      contentType: 'text/html',
      rawPreview: '<html>'
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      httpStatus: 200,
      contentType: 'application/json',
      rawPreview: '',
      json: [{ date: '2026-02-10', close: 2 }]
    });

    const result = await fetchEodhdFxRange(
      Currency.EUR,
      Currency.CHF,
      '2026-02-01',
      '2026-02-10',
      'key',
      'proxy'
    );

    expect(result.ok).toBe(true);
    expect(result.inverted).toBe(true);
    expect(result.rows[0].rate).toBeCloseTo(0.5);
  });
});

describe('dedupeFxRows', () => {
  it('dedupes by base/quote/date', () => {
    const rows = [
      { baseCurrency: Currency.EUR, quoteCurrency: Currency.CHF, date: '2026-02-10', rate: 1 },
      { baseCurrency: Currency.EUR, quoteCurrency: Currency.CHF, date: '2026-02-10', rate: 1.1 }
    ];
    const deduped = dedupeFxRows(rows);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].rate).toBe(1.1);
  });
});

describe('backfillFxRatesForPortfolio', () => {
  it('fills most recent internal gap within lookback window', async () => {
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

      (db.fxRates as any).sortBy.mockResolvedValueOnce([
        { date: '2026-01-16' },
        { date: '2026-02-18' }
      ]);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        httpStatus: 200,
        contentType: 'application/json',
        rawPreview: '',
        json: [{ date: '2026-02-01', close: 1.1 }]
      });

      const promise = backfillFxRatesForPortfolio(
        'p1',
        ['EUR/CHF'],
        undefined,
        'local-key',
        { mode: 'AUTO_GAPS', maxApiCallsPerRun: 1, maxLookbackDays: 90, staleThresholdDays: 7, sleepMs: 0 }
      );
      await vi.runAllTimersAsync();
      const result = await promise;

      const url = fetchMock.mock.calls[0]?.[0] as string;
      expect(url).toContain('from=2026-01-17');
      expect(url).toContain('to=2026-02-17');
      expect(result.status).toBe('ok');
      expect(result.updatedPairs).toContain('EUR/CHF');
      expect((upsertFxRowsByNaturalKey as any).mock.calls.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns quota_exhausted on 402', async () => {
    healthMock.mockResolvedValue({
      ok: true,
      tested: true,
      hasEodhdKey: true,
      usingLocalKey: true,
      mode: 'vercel-proxy'
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      httpStatus: 402,
      contentType: 'application/json',
      rawPreview: ''
    });

    const result = await backfillFxRatesForPortfolio(
      'p1',
      ['EUR/CHF'],
      undefined,
      'local-key',
      { mode: 'AUTO_GAPS', maxApiCallsPerRun: 1, maxLookbackDays: 30, sleepMs: 0 }
    );

    expect(result.status).toBe('quota_exhausted');
  });

  it('falls back to direct when proxy endpoint is missing', async () => {
    healthMock.mockResolvedValue({
      ok: true,
      tested: true,
      hasEodhdKey: true,
      usingLocalKey: true,
      mode: 'vercel-proxy'
    });

    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).startsWith('/api/eodhd-proxy')) {
        return { ok: false, httpStatus: 404, contentType: 'text/html', rawPreview: '<html>' };
      }
      return {
        ok: true,
        httpStatus: 200,
        contentType: 'application/json',
        rawPreview: '',
        json: [{ date: '2026-02-10', close: 1.1 }]
      };
    });

    const result = await backfillFxRatesForPortfolio(
      'p1',
      ['EUR/CHF'],
      undefined,
      'local-key',
      { mode: 'AUTO_GAPS', maxApiCallsPerRun: 1, maxLookbackDays: 30, sleepMs: 0 }
    );

    expect(result.status).toBe('ok');
    expect(result.updatedPairs).toContain('EUR/CHF');
    expect((upsertFxRowsByNaturalKey as any).mock.calls.length).toBe(1);
    expect(fetchMock.mock.calls.length).toBe(3);
  });
});
