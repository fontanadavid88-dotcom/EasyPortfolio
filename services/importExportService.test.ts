import { describe, it, expect } from 'vitest';
import { reconcileImportedListingState, validateAndNormalize } from './importExportService';
import { AssetType, Currency } from '../types';

const baseTx = {
  date: '2026-02-10',
  type: 'Buy',
  instrumentTicker: 'AAA',
  quantity: 1,
  price: 10,
  fees: 0,
  currency: 'USD',
  account: 'test'
};

describe('importExportService validateAndNormalize', () => {
  it('drops transactions with invalid date or missing instrumentTicker', () => {
    const payload = {
      transactions: [
        { ...baseTx, date: 'bad-date' },
        { ...baseTx, instrumentTicker: '' }
      ]
    };
    const { report } = validateAndNormalize(payload as any);
    expect(report.tables.transactions.total).toBe(2);
    expect(report.tables.transactions.imported).toBe(0);
    expect(report.tables.transactions.discarded).toBe(2);
  });

  it('normalizes price point close and date', () => {
    const payload = {
      prices: [
        { ticker: 'AAA', date: '2026-02-10T12:00:00Z', close: '123.45', currency: 'USD' }
      ]
    };
    const { normalized } = validateAndNormalize(payload as any);
    expect(normalized.prices[0].close).toBeCloseTo(123.45);
    expect(normalized.prices[0].date).toBe('2026-02-10');
  });

  it('reports mixed valid/invalid rows', () => {
    const payload = {
      prices: [
        { ticker: 'AAA', date: '2026-02-10', close: 10, currency: 'USD' },
        { ticker: '', date: '2026-02-10', close: 10, currency: 'USD' }
      ],
      transactions: [
        baseTx,
        { ...baseTx, date: 'invalid' }
      ]
    };
    const { report } = validateAndNormalize(payload as any);
    expect(report.tables.prices.total).toBe(2);
    expect(report.tables.prices.imported).toBe(1);
    expect(report.tables.prices.discarded).toBe(1);
    expect(report.tables.transactions.total).toBe(2);
    expect(report.tables.transactions.imported).toBe(1);
    expect(report.tables.transactions.discarded).toBe(1);
  });

  it('keeps backup sections for fx alias, inflation and rebalance plans', () => {
    const payload = {
      fx: [
        { baseCurrency: 'EUR', quoteCurrency: 'CHF', date: '2026-02-10', rate: 0.95 }
      ],
      inflationRates: [
        { currency: 'CHF', date: '2026-01-01', index: 105.2 }
      ],
      inflationAnnualRates: [
        { currency: 'CHF', year: 2025, ratePct: 1.4 }
      ],
      rebalancePlans: [
        { id: 'plan-1', portfolioId: 'p1', createdAt: 1, items: [] }
      ]
    };
    const { normalized, report } = validateAndNormalize(payload as any);
    expect(normalized.fxRates).toHaveLength(1);
    expect(normalized.inflationRates).toHaveLength(1);
    expect(normalized.inflationAnnualRates).toHaveLength(1);
    expect(normalized.rebalancePlans).toHaveLength(1);
    expect(report.tables.fxRates.imported).toBe(1);
    expect(report.tables.inflationRates.imported).toBe(1);
    expect(report.tables.inflationAnnualRates.imported).toBe(1);
    expect(report.tables.rebalancePlans.imported).toBe(1);
  });

  it('normalizes nested listings and ticker config keys', () => {
    const payload = {
      settings: [
        {
          baseCurrency: 'CHF',
          eodhdApiKey: '',
          googleSheetUrl: '',
          priceTickerConfig: {
            ' aAa.sw ': { provider: 'sheets', sheetSymbol: 'AAA_CH ' }
          }
        }
      ],
      instruments: [
        {
          ticker: 'aaa.us',
          symbol: 'aaa.us',
          name: 'AAA',
          type: 'Stock',
          currency: 'usd',
          isin: ' us0000000001 ',
          preferredListing: { exchangeCode: 'sw', symbol: 'aaa.sw', currency: 'chf' },
          listings: [
            { exchangeCode: 'sw', symbol: 'aaa.sw', currency: 'chf' },
            { exchangeCode: 'us', symbol: 'aaa.us', currency: 'usd' },
            { exchangeCode: '', symbol: '', currency: 'usd' }
          ]
        }
      ]
    };

    const { normalized } = validateAndNormalize(payload as any);
    expect(normalized.settings[0].priceTickerConfig?.['AAA.SW']).toMatchObject({
      provider: 'SHEETS',
      sheetSymbol: 'AAA_CH'
    });
    expect(normalized.instruments[0].isin).toBe('US0000000001');
    expect(normalized.instruments[0].preferredListing?.symbol).toBe('AAA.SW');
    expect(normalized.instruments[0].listings?.map(listing => listing.symbol)).toEqual(['AAA.SW', 'AAA.US']);
  });

  it('realigns priceTickerConfig to the preferred listing during import reconciliation', () => {
    const result = reconcileImportedListingState({
      settings: [
        {
          portfolioId: 'p1',
          baseCurrency: Currency.CHF,
          eodhdApiKey: '',
          googleSheetUrl: '',
          priceTickerConfig: {
            'AAA.US': { provider: 'SHEETS', sheetSymbol: 'AAA_CH' }
          }
        }
      ],
      instruments: [
        {
          portfolioId: 'p1',
          ticker: 'AAA.US',
          symbol: 'AAA.US',
          name: 'AAA',
          type: AssetType.Stock,
          currency: Currency.USD,
          isin: 'US0000000001',
          preferredListing: { exchangeCode: 'SW', symbol: 'AAA.SW', currency: Currency.CHF },
          listings: [
            { exchangeCode: 'US', symbol: 'AAA.US', currency: Currency.USD },
            { exchangeCode: 'SW', symbol: 'AAA.SW', currency: Currency.CHF }
          ]
        }
      ],
      instrumentListings: [
        {
          isin: 'US0000000001',
          exchangeCode: 'US',
          symbol: 'AAA.US',
          currency: Currency.USD,
          portfolioId: 'p1'
        }
      ]
    });

    expect(result.instruments[0].preferredListing?.symbol).toBe('AAA.SW');
    expect(result.settings[0].priceTickerConfig?.['AAA.SW']).toMatchObject({
      provider: 'SHEETS',
      sheetSymbol: 'AAA_CH'
    });
    expect(result.settings[0].priceTickerConfig?.['AAA.US']).toBeUndefined();
    expect(result.instrumentListings.map(listing => listing.symbol).sort()).toEqual(['AAA.SW', 'AAA.US']);
    expect(result.warnings.some(warning => warning.includes('priceTickerConfig'))).toBe(true);
  });

  it('keeps simple instruments unchanged when no extra listings exist', () => {
    const result = reconcileImportedListingState({
      settings: [
        {
          portfolioId: 'p1',
          baseCurrency: Currency.CHF,
          eodhdApiKey: '',
          googleSheetUrl: '',
          priceTickerConfig: {
            SIMPLE: { provider: 'MANUAL' }
          }
        }
      ],
      instruments: [
        {
          portfolioId: 'p1',
          ticker: 'SIMPLE',
          symbol: 'SIMPLE',
          name: 'Simple',
          type: AssetType.Stock,
          currency: Currency.USD
        }
      ],
      instrumentListings: []
    });

    expect(result.instruments[0].preferredListing).toBeUndefined();
    expect(result.instruments[0].listings).toBeUndefined();
    expect(result.settings[0].priceTickerConfig?.SIMPLE?.provider).toBe('MANUAL');
    expect(result.warnings).toHaveLength(0);
  });
});
