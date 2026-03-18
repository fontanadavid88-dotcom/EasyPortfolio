import { describe, expect, it, vi } from 'vitest';
import { runGapFill, runLatestSync } from './syncActionsService';
import { Currency } from '../types';
import type { AppSettings } from '../types';

vi.mock('./priceService', () => ({
  syncPrices: vi.fn(),
  getTickersForBackfill: vi.fn(),
  backfillPricesForPortfolio: vi.fn(),
  fetchLatestEodhdPrice: vi.fn(),
  buildPointsForSave: vi.fn(),
  resolvePriceSyncConfig: vi.fn()
}));

vi.mock('./fxService', () => ({
  backfillFxRatesForPortfolio: vi.fn(),
  getFxPairsForPortfolio: vi.fn()
}));

vi.mock('./appsScriptService', () => ({
  syncFxRates: vi.fn()
}));

vi.mock('./syncStatusService', () => ({
  setLastLatestSyncAt: vi.fn(),
  setLastGapFillAt: vi.fn()
}));

vi.mock('../db', () => {
  const toArray = vi.fn();
  const equals = vi.fn(() => ({ toArray }));
  const where = vi.fn(() => ({ equals }));
  const bulkPut = vi.fn();
  return {
    db: {
      instruments: { where },
      prices: { bulkPut }
    },
    __mock: { toArray, bulkPut, where, equals }
  };
});

vi.mock('./financeUtils', () => ({
  getCanonicalTicker: (inst: any) => inst?.ticker || inst?.symbol || inst?.preferredListing?.symbol || ''
}));

vi.mock('./symbolUtils', () => ({
  resolveEodhdSymbol: (symbol: string) => symbol
}));

const { syncPrices, getTickersForBackfill, backfillPricesForPortfolio, fetchLatestEodhdPrice, buildPointsForSave, resolvePriceSyncConfig } = await import('./priceService');
const { backfillFxRatesForPortfolio, getFxPairsForPortfolio } = await import('./fxService');
const { syncFxRates } = await import('./appsScriptService');
const { setLastLatestSyncAt, setLastGapFillAt } = await import('./syncStatusService');
const dbMock = (await import('../db') as any).__mock;

const baseSettings: AppSettings = {
  eodhdApiKey: 'key',
  googleSheetUrl: '',
  appsScriptUrl: 'https://script',
  appsScriptApiKey: 'token',
  baseCurrency: Currency.CHF,
  minHistoryDate: '2020-01-01',
  priceBackfillScope: 'current',
  preferredExchangesOrder: ['SW'],
  priceTickerConfig: {}
};

describe('syncActionsService', () => {
  it('runLatestSync calls prices then fx and sets timestamp on ok', async () => {
    const calls: string[] = [];
    (syncPrices as unknown as any).mockImplementation(async () => {
      calls.push('prices');
      return { status: 'ok', updatedTickers: ['AAA'], failedTickers: [], sheet: { enabled: true } };
    });
    (syncFxRates as unknown as any).mockImplementation(async () => {
      calls.push('fx');
      return { ok: true, count: 2 };
    });
    (dbMock.toArray as unknown as any).mockResolvedValue([]);

    const outcome = await runLatestSync({ portfolioId: 'p1', settings: baseSettings });
    expect(calls).toEqual(['prices', 'fx']);
    expect(outcome.ok).toBe(true);
    expect(setLastLatestSyncAt).toHaveBeenCalled();
  });

  it('runLatestSync falls back to EODHD when sheet misses tickers', async () => {
    (syncPrices as unknown as any).mockResolvedValue({
      status: 'partial',
      updatedTickers: [],
      failedTickers: [{ ticker: 'AAA' }],
      sheet: { enabled: true }
    });
    (syncFxRates as unknown as any).mockResolvedValue({ ok: true, count: 0 });
    (resolvePriceSyncConfig as unknown as any).mockReturnValue({ excluded: false, needsMapping: false, provider: 'SHEETS' });
    (fetchLatestEodhdPrice as unknown as any).mockResolvedValue({ date: '2026-03-02', close: 123 });
    (buildPointsForSave as unknown as any).mockReturnValue([{ id: 1 }]);
    (dbMock.toArray as unknown as any).mockResolvedValue([{ id: 1, ticker: 'AAA', currency: 'CHF' }]);

    const outcome = await runLatestSync({ portfolioId: 'p1', settings: baseSettings });
    expect(fetchLatestEodhdPrice).toHaveBeenCalled();
    expect(outcome.updatedFallbackTickers).toEqual(['AAA']);
    expect(outcome.ok).toBe(true);
    expect(setLastLatestSyncAt).toHaveBeenCalled();
  });

  it('runGapFill calls prices then fx and emits progress', async () => {
    const calls: string[] = [];
    const messages: string[] = [];
    (getTickersForBackfill as unknown as any).mockResolvedValue(['AAA']);
    (backfillPricesForPortfolio as unknown as any).mockImplementation(async (_pid: string, _t: string[], _d: string, onProgress?: any) => {
      calls.push('prices');
      if (onProgress) {
        onProgress({ ticker: 'AAA', index: 1, total: 1, phase: 'backfill' });
        onProgress({ ticker: 'AAA', index: 1, total: 1, phase: 'done' });
      }
      return { status: 'ok', updatedTickers: [], skipped: 0, mode: 'AUTO_GAPS' };
    });
    (getFxPairsForPortfolio as unknown as any).mockResolvedValue(['USD/CHF']);
    (backfillFxRatesForPortfolio as unknown as any).mockImplementation(async () => {
      calls.push('fx');
      return { status: 'ok', updatedPairs: [], skipped: 0, mode: 'AUTO_GAPS' };
    });

    const outcome = await runGapFill({
      portfolioId: 'p1',
      settings: baseSettings,
      onProgress: (msg) => messages.push(msg)
    });
    expect(calls).toEqual(['prices', 'fx']);
    expect(messages.length).toBeGreaterThan(0);
    expect(outcome.ok).toBe(true);
    expect(setLastGapFillAt).toHaveBeenCalled();
  });
});
