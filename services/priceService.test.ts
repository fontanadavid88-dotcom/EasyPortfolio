import { describe, it, expect } from 'vitest';
import { buildCoverageRows, resolvePriceSyncConfig, mapEodhdHistoryRows } from './priceService';
import { AppSettings, AssetType, Currency, Instrument } from '../types';

describe('buildCoverageRows', () => {
  it('maps coverage rows to instruments and fills defaults', () => {
    const instruments: Instrument[] = [
      {
        id: 1,
        ticker: 'SWDA.SW',
        name: 'iShares Core MSCI World',
        isin: 'IE00B4L5Y983',
        type: AssetType.ETF,
        currency: Currency.CHF,
        preferredListing: { exchangeCode: 'SW', symbol: 'SWDA.SW', currency: Currency.CHF }
      },
      {
        id: 2,
        ticker: 'AAPL.US',
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
    expect(rows[0].instrumentId).toBe(1);
    expect(rows[0].status).toBe('OK');

    expect(rows[1].ticker).toBe('AAPL.US');
    expect(rows[1].status).toBe('PARZIALE');

    expect(rows[2].ticker).toBe('MISSING');
    expect(rows[2].isin).toBeNull();
    expect(rows[2].from).toBe('N/D');
    expect(rows[2].to).toBe('N/D');
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
