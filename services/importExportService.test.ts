import { describe, it, expect } from 'vitest';
import { validateAndNormalize } from './importExportService';

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
});
