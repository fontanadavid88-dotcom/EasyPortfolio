import { describe, expect, it } from 'vitest';
import { computeSyncStatus } from './syncStatusService';
import { AssetClass, AssetType, Currency, Instrument, PricePoint } from '../types';

describe('syncStatusService', () => {
  it('flags missing prices', () => {
    const holdings = new Map<string, number>([['AAA', 1]]);
    const status = computeSyncStatus({
      baseCurrency: Currency.CHF,
      holdings,
      instruments: [],
      latestPrices: [],
      latestFx: [],
      prices: [],
      fxRates: [],
      valuationDate: '2026-03-03',
      today: '2026-03-03'
    });
    expect(status.missingTickers).toEqual(['AAA']);
    expect(status.latestPricesOk).toBe(false);
  });

  it('flags missing FX pairs', () => {
    const holdings = new Map<string, number>([['USD_STOCK', 2]]);
    const instruments: Instrument[] = [{
      ticker: 'USD_STOCK',
      name: 'US Stock',
      type: AssetType.Stock,
      assetClass: AssetClass.STOCK,
      currency: Currency.USD
    }];
    const latestPrices: PricePoint[] = [{
      ticker: 'USD_STOCK',
      date: '2026-03-03',
      close: 100,
      currency: Currency.USD,
      portfolioId: 'p1'
    }];
    const status = computeSyncStatus({
      baseCurrency: Currency.CHF,
      holdings,
      instruments,
      latestPrices,
      latestFx: [],
      prices: latestPrices,
      fxRates: [],
      valuationDate: '2026-03-03',
      today: '2026-03-03'
    });
    expect(status.missingPairs).toEqual(['USD/CHF']);
    expect(status.latestFxOk).toBe(false);
  });

  it('returns ok when prices and FX are complete', () => {
    const holdings = new Map<string, number>([['CH_STOCK', 1]]);
    const instruments: Instrument[] = [{
      ticker: 'CH_STOCK',
      name: 'Swiss Stock',
      type: AssetType.Stock,
      assetClass: AssetClass.STOCK,
      currency: Currency.CHF
    }];
    const latestPrices: PricePoint[] = [{
      ticker: 'CH_STOCK',
      date: '2026-03-03',
      close: 50,
      currency: Currency.CHF,
      portfolioId: 'p1'
    }];
    const status = computeSyncStatus({
      baseCurrency: Currency.CHF,
      holdings,
      instruments,
      latestPrices,
      latestFx: [],
      prices: latestPrices,
      fxRates: [],
      valuationDate: '2026-03-03',
      today: '2026-03-03'
    });
    expect(status.latestPricesOk).toBe(true);
    expect(status.latestFxOk).toBe(true);
    expect(status.quality.ok).toBe(true);
  });
});
