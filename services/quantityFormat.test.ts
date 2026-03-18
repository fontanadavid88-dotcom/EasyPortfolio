import { describe, expect, it } from 'vitest';
import { formatQuantity } from './quantityFormat';
import { AssetClass, AssetType, Currency, Instrument } from '../types';

describe('quantityFormat', () => {
  it('formats non-crypto as integer', () => {
    const etf: Instrument = {
      ticker: 'VWRL.SW',
      name: 'Vanguard ETF',
      type: AssetType.ETF,
      currency: Currency.CHF
    };
    expect(formatQuantity(24.6298, etf)).toBe('25');
  });

  it('formats crypto with up to 6 decimals', () => {
    const btc: Instrument = {
      ticker: 'BTC-USD',
      name: 'Bitcoin',
      type: AssetType.Crypto,
      assetClass: AssetClass.CRYPTO,
      currency: Currency.USD
    };
    expect(formatQuantity(0.013336, btc)).toBe('0.013336');
  });

  it('trims trailing zeros for crypto', () => {
    const eth: Instrument = {
      ticker: 'ETH-USD',
      name: 'Ethereum',
      type: AssetType.Crypto,
      assetClass: AssetClass.CRYPTO,
      currency: Currency.USD
    };
    expect(formatQuantity(1.2, eth)).toBe('1.2');
  });

  it('uses tradePrecisionDecimals override when provided', () => {
    const etf: Instrument = {
      ticker: 'VWRL.SW',
      name: 'Vanguard ETF',
      type: AssetType.ETF,
      currency: Currency.CHF,
      tradePrecisionDecimals: 2
    };
    expect(formatQuantity(24.6298, etf)).toBe('24.63');
  });
});
