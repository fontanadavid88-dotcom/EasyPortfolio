import { describe, it, expect } from 'vitest';
import {
  buildCoverageRows,
  resolveCoverageStartDate,
  resolveSyncStartDate,
  buildPointsForSave,
  resolvePriceSyncConfig,
  mapEodhdHistoryRows,
  computeAutoGapRange,
  isAutoGapCandidate,
  limitTickersByBudget,
  resolveBackfillSymbol,
  resolveProxyFailure
} from './priceService';
import * as priceService from './priceService';
import { AppSettings, AssetType, Currency, Instrument } from '../types';
import type { ProxyHealth } from './apiHealthService';

describe('buildCoverageRows', () => {
  it('maps coverage rows to instruments and fills defaults', () => {
    const instruments: Instrument[] = [
      {
        id: 1,
        ticker: 'SWDA.SW',
        symbol: 'SWDA.SW',
        name: 'iShares Core MSCI World',
        isin: 'IE00B4L5Y983',
        type: AssetType.ETF,
        currency: Currency.CHF,
        preferredListing: { exchangeCode: 'SW', symbol: 'SWDA.SW', currency: Currency.CHF }
      },
      {
        id: 2,
        ticker: 'AAPL.US',
        symbol: 'AAPL.US',
        name: 'Apple Inc.',
        type: AssetType.Stock,
        currency: Currency.USD,
        listings: [{ exchangeCode: 'US', symbol: 'AAPL.US', currency: Currency.USD }]
      }
    ];
    const ranges = {
      'SWDA.SW': { firstDate: '2020-01-01', lastDate: '2024-01-05' },
      'AAPL.US': { firstDate: '2023-01-10', lastDate: '2024-01-05' },
      'MISSING': {}
    };

    const rows = buildCoverageRows(
      ['SWDA.SW', 'AAPL.US', 'MISSING'],
      ranges,
      instruments,
      '2020-01-01',
      '2024-01-07'
    );

    expect(rows[0].ticker).toBe('SWDA.SW');
    expect(rows[0].isin).toBe('IE00B4L5Y983');
    expect(rows[0].instrumentId).toBe('1');
    expect(rows[0].status).toBe('OK');

    expect(rows[1].ticker).toBe('AAPL.US');
    expect(rows[1].status).toBe('PARZIALE');

    expect(rows[2].ticker).toBe('MISSING');
    expect(rows[2].isin).toBeNull();
    expect(rows[2].from).toBe('N/D');
    expect(rows[2].to).toBe('N/D');
  });

  it('respects coverage tolerance window', () => {
    const rows = buildCoverageRows(
      ['AAA'],
      { AAA: { firstDate: '2024-01-08', lastDate: '2024-01-10' } },
      [],
      '2024-01-01',
      '2024-01-17'
    );
    expect(rows[0].status).toBe('OK');
  });
});

describe('resolveCoverageStartDate', () => {
  it('clamps to max(minHistoryDate, firstTransactionDate)', () => {
    expect(resolveCoverageStartDate('2020-01-01', '2019-12-31')).toBe('2020-01-01');
    expect(resolveCoverageStartDate('2020-01-01', '2022-03-15')).toBe('2022-03-15');
  });
});

describe('resolveSyncStartDate', () => {
  it('starts from day after last price date', () => {
    const start = resolveSyncStartDate('2020-01-01', '2019-12-31', '2026-02-06');
    expect(start).toBe('2026-02-07');
  });
});

describe('buildPointsForSave', () => {
  it('assigns instrument currency when provider has none', () => {
    const points = [{
      ticker: 'AAPL.US',
      date: '2026-02-10',
      close: 123.45,
      currency: undefined as any
    }];
    const saved = buildPointsForSave(points as any, {
      ticker: 'AAPL.US',
      instrumentId: 'inst-1',
      currency: Currency.CHF,
      portfolioId: 'default'
    });
    expect(saved[0].currency).toBe(Currency.CHF);
  });
});

describe('AUTO_GAPS helpers', () => {
  it('computes from/to using lastDate+1 and lookback clamp', () => {
    const range = computeAutoGapRange('2026-02-04', '2026-02-10', 30);
    expect(range.from).toBe('2026-02-05');
    expect(range.to).toBe('2026-02-10');
  });

  it('skips when lastDate is recent', () => {
    const stale = isAutoGapCandidate('2026-02-06', '2026-02-10', 7);
    expect(stale).toBe(false);
  });

  it('stops by budget limit', () => {
    const { tickers, stoppedByBudget } = limitTickersByBudget(['A', 'B', 'C', 'D', 'E'], 2);
    expect(tickers.length).toBe(2);
    expect(stoppedByBudget).toBe(true);
  });
});

describe('resolveBackfillSymbol', () => {
  it('uses eodhdSymbol even when provider is SHEETS', () => {
    const symbol = resolveBackfillSymbol('AAA', { provider: 'SHEETS', eodhdSymbol: 'BBB.US' }, AssetType.Stock);
    expect(symbol).toBe('BBB.US');
  });
});

describe('resolveProxyFailure', () => {
  it('maps proxy unreachable to status', () => {
    const health: ProxyHealth = {
      ok: false,
      tested: true,
      hasEodhdKey: false,
      usingLocalKey: false,
      mode: 'no-key',
      message: 'Proxy /api non raggiungibile',
      diag: { httpStatus: 404, ok: false, rawPreview: '<html>' }
    };
    const result = resolveProxyFailure(health);
    expect(result?.status).toBe('proxy_unreachable');
  });
});

describe('resolvePriceSyncConfig', () => {
  it('keeps manual provider override', () => {
    const settings: AppSettings = {
      baseCurrency: Currency.CHF,
      eodhdApiKey: '',
      googleSheetUrl: '',
      priceTickerConfig: {
        'AAPL.US': { provider: 'MANUAL', eodhdSymbol: 'AAPL.US' }
      }
    };

    const cfg = resolvePriceSyncConfig('AAPL.US', settings);
    expect(cfg.provider).toBe('MANUAL');
    expect(cfg.excluded).toBe(false);
    expect(cfg.eodhdSymbol).toBe('AAPL.US');
  });
});

describe('mapEodhdHistoryRows', () => {
  it('parses numeric close from string', () => {
    const rows = mapEodhdHistoryRows('AAPL.US', [
      { date: '2024-01-02', close: '131.52' }
    ]);

    expect(rows.length).toBe(1);
    expect(rows[0].close).toBeCloseTo(131.52);
    expect(typeof rows[0].close).toBe('number');
  });
});

describe('getEodhdQuotaInfo', () => {
  it('parses quota info from object payload', async () => {
    const payload = { dailyRateLimit: 100, apiRequests: '12' };
    const globalWithFetch = globalThis as typeof globalThis & { fetch?: typeof fetch };
    const originalFetch = globalWithFetch.fetch;
    const mockResponse = {
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(payload)
    } as unknown as Response;
    globalWithFetch.fetch = async () => mockResponse;
    const settings: AppSettings = {
      baseCurrency: Currency.CHF,
      eodhdApiKey: 'x',
      googleSheetUrl: ''
    };
    const result = await priceService.getEodhdQuotaInfo(settings);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.info.dailyRateLimit).toBe(100);
      expect(result.info.apiRequests).toBe(12);
    }
    globalWithFetch.fetch = originalFetch;
  });
});
