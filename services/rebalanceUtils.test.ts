import { describe, expect, it, vi } from 'vitest';
import { computeRebalanceUnits } from './rebalanceUtils';
import { Currency } from '../types';

vi.mock('./fxService', () => ({
  convertAmountFromSeries: (amount: number, base: Currency, quote: Currency) => {
    if (base === Currency.CHF && quote === Currency.USD) {
      return { value: amount * 1.1, lookup: { date: '2026-02-10', rate: 1.1 } };
    }
    return null;
  }
}));

describe('computeRebalanceUnits', () => {
  it('computes units when base and price currency match', () => {
    const result = computeRebalanceUnits({
      deltaBase: 100,
      baseCurrency: Currency.CHF,
      instrumentCurrency: Currency.CHF,
      price: 50,
      priceCurrency: Currency.CHF,
      fxRates: [],
      valuationDate: '2026-02-10'
    });
    expect(result.units).toBe(2);
  });

  it('computes units using FX conversion or returns reason on missing FX', () => {
    const result = computeRebalanceUnits({
      deltaBase: 100,
      baseCurrency: Currency.CHF,
      instrumentCurrency: Currency.USD,
      price: 10,
      priceCurrency: Currency.USD,
      fxRates: [],
      valuationDate: '2026-02-10'
    });
    expect(result.units).toBeCloseTo(11);

    const missing = computeRebalanceUnits({
      deltaBase: 100,
      baseCurrency: Currency.CHF,
      instrumentCurrency: Currency.EUR,
      price: 10,
      priceCurrency: Currency.EUR,
      fxRates: [],
      valuationDate: '2026-02-10'
    });
    expect(missing.reason).toBe('missing_fx');
  });
});
