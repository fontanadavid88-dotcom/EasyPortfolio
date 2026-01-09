import { describe, it, expect } from 'vitest';
import { buildCoverageRows } from './priceService';
import { AssetType, Currency, Instrument } from '../types';

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
