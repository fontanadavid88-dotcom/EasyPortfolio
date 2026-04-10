import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runGapFill, runLatestSync } from './syncActionsService';
import { Currency } from '../types';
import type { AppSettings } from '../types';

vi.mock('./priceService', () => ({
  syncPrices: vi.fn(),
  getTickersForBackfill: vi.fn(),
  backfillPricesForPortfolio: vi.fn(),
  fetchLatestEodhdPrice: vi.fn(),
  buildPointsForSave: vi.fn(),
  resolvePriceSyncConfig: vi.fn(),
  describeLatestPriceFetchError: vi.fn((error: any) => error?.message || 'Errore latest EODHD'),
  isLatestPriceFetchError: vi.fn((error: any) => Boolean(error?.httpStatus || error?.payloadPreview))
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

vi.mock('./dataWriteService', () => ({
  upsertPriceRowsByNaturalKey: vi.fn().mockResolvedValue({
    received: 0,
    deduped: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    deletedDuplicates: 0,
    written: 0
  })
}));

const { syncPrices, getTickersForBackfill, backfillPricesForPortfolio, fetchLatestEodhdPrice, buildPointsForSave, resolvePriceSyncConfig } = await import('./priceService');
const { backfillFxRatesForPortfolio, getFxPairsForPortfolio } = await import('./fxService');
const { syncFxRates } = await import('./appsScriptService');
const { setLastLatestSyncAt, setLastGapFillAt } = await import('./syncStatusService');
const { upsertPriceRowsByNaturalKey } = await import('./dataWriteService');
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
    expect(upsertPriceRowsByNaturalKey).toHaveBeenCalled();
    expect(outcome.updatedFallbackTickers).toEqual(['AAA']);
    expect(outcome.ok).toBe(true);
    expect(setLastLatestSyncAt).toHaveBeenCalled();
  });

  it('runLatestSync returns partial when fallback updates some tickers and others still fail', async () => {
    (syncPrices as unknown as any).mockResolvedValue({
      status: 'partial',
      updatedTickers: ['BBB'],
      failedTickers: [{ ticker: 'AAA', reason: 'Sheets: prezzo non trovato' }, { ticker: 'CCC', reason: 'Sheets: prezzo non trovato' }],
      sheet: { enabled: true }
    });
    (syncFxRates as unknown as any).mockResolvedValue({ ok: true, count: 0 });
    (resolvePriceSyncConfig as unknown as any).mockReturnValue({ excluded: false, needsMapping: false, provider: 'SHEETS' });
    (fetchLatestEodhdPrice as unknown as any)
      .mockResolvedValueOnce({ date: '2026-03-02', close: 123 })
      .mockRejectedValueOnce(new Error('Payload latest EODHD non valido: close non numerico'));
    (buildPointsForSave as unknown as any).mockReturnValue([{ id: 1 }]);
    (dbMock.toArray as unknown as any).mockResolvedValue([
      { id: 1, ticker: 'AAA', currency: 'CHF' },
      { id: 2, ticker: 'BBB', currency: 'CHF' },
      { id: 3, ticker: 'CCC', currency: 'CHF' }
    ]);

    const outcome = await runLatestSync({ portfolioId: 'p1', settings: baseSettings });
    expect(outcome.priceResult.status).toBe('partial');
    expect(outcome.priceResult.updatedTickers).toEqual(['BBB', 'AAA']);
    expect(outcome.priceResult.failedTickers).toEqual([
      { ticker: 'CCC', reason: 'Payload latest EODHD non valido: close non numerico' }
    ]);
    expect(outcome.ok).toBe(true);
  });

  it('runLatestSync returns failed with useful message when zero tickers are updated', async () => {
    (syncPrices as unknown as any).mockResolvedValue({
      status: 'failed',
      updatedTickers: [],
      failedTickers: [{ ticker: 'AAA', reason: 'Sheets: prezzo non trovato' }],
      sheet: { enabled: true },
      message: 'Nessun ticker aggiornato. AAA: Sheets: prezzo non trovato'
    });
    (syncFxRates as unknown as any).mockResolvedValue({ ok: true, count: 0 });
    (resolvePriceSyncConfig as unknown as any).mockReturnValue({ excluded: false, needsMapping: false, provider: 'SHEETS' });
    (fetchLatestEodhdPrice as unknown as any).mockRejectedValue(new Error('Payload latest EODHD non valido: close non numerico'));
    (dbMock.toArray as unknown as any).mockResolvedValue([{ id: 1, ticker: 'AAA', currency: 'CHF' }]);

    const outcome = await runLatestSync({ portfolioId: 'p1', settings: baseSettings });
    expect(outcome.ok).toBe(false);
    expect(outcome.priceResult.status).toBe('failed');
    expect(outcome.priceResult.message).toContain('Nessun ticker aggiornato');
    expect(outcome.priceResult.message).toContain('AAA');
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
