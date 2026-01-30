import { describe, it, expect } from 'vitest';
import { Currency, InstrumentListing } from '../types';
import { buildPriceTickerConfigWithDefault, planAutoAttachListing } from './priceAttach';

describe('planAutoAttachListing', () => {
  it('respects explicit ticker override confirmation', () => {
    const listings: InstrumentListing[] = [
      { exchangeCode: 'US', symbol: 'AAPL.US', currency: Currency.USD },
      { exchangeCode: 'SW', symbol: 'AAPL.SW', currency: Currency.CHF }
    ];

    const denied = planAutoAttachListing({
      typedTicker: 'AAPL.US',
      listings,
      preferredExchangesOrder: ['SW'],
      baseCurrency: Currency.CHF,
      confirmOverride: () => false
    });

    expect(denied.preferredListing).toBeUndefined();
    expect(denied.warning).toBeTruthy();

    const accepted = planAutoAttachListing({
      typedTicker: 'AAPL.US',
      listings,
      preferredExchangesOrder: ['SW'],
      baseCurrency: Currency.CHF,
      confirmOverride: () => true
    });

    expect(accepted.preferredListing?.symbol).toBe('AAPL.SW');
    expect(accepted.listings?.length).toBe(2);
  });
});

describe('buildPriceTickerConfigWithDefault', () => {
  it('adds defaults only when missing', () => {
    const existing = {
      'AAPL.US': { provider: 'MANUAL' as const }
    };

    const unchanged = buildPriceTickerConfigWithDefault(existing, 'AAPL.US', {
      provider: 'EODHD',
      eodhdSymbol: 'AAPL.US'
    });
    expect(unchanged.changed).toBe(false);
    expect(unchanged.config['AAPL.US']?.provider).toBe('MANUAL');

    const added = buildPriceTickerConfigWithDefault(existing, 'MSFT.US', {
      provider: 'EODHD',
      eodhdSymbol: 'MSFT.US'
    });
    expect(added.changed).toBe(true);
    expect(added.config['MSFT.US']?.eodhdSymbol).toBe('MSFT.US');
  });
});
