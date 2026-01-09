import { describe, it, expect } from 'vitest';
import { calculateHistoricalPerformance, calculateAnalytics } from './financeUtils';
import { AssetType, Currency, Instrument, PricePoint, Transaction, TransactionType } from '../types';

const instr: Instrument = { ticker: 'TEST', name: 'Test', type: AssetType.Stock, currency: Currency.USD };

describe('financeUtils daily series', () => {
  it('forward-fills missing prices between trading days', () => {
    const transactions: Transaction[] = [
      { date: new Date('2024-01-01'), type: TransactionType.Buy, instrumentTicker: 'TEST', quantity: 1, price: 10, fees: 0, currency: Currency.USD, account: 'A' }
    ];
    const prices: PricePoint[] = [
      { ticker: 'TEST', date: '2024-01-01', close: 10, currency: Currency.USD },
      { ticker: 'TEST', date: '2024-01-03', close: 12, currency: Currency.USD }
    ];

    const { history } = calculateHistoricalPerformance(transactions, [instr], prices, 1, 'daily');
    const day2 = history.find(h => h.date === '2024-01-02');
    const day3 = history.find(h => h.date === '2024-01-03');
    expect(day2?.value).toBeCloseTo(10); // forward fill price 10
    expect(day3?.value).toBeCloseTo(12); // updated price 12
  });

  it('accumulates holdings after buy and sell', () => {
    const transactions: Transaction[] = [
      { date: new Date('2024-01-01'), type: TransactionType.Buy, instrumentTicker: 'TEST', quantity: 10, price: 10, fees: 0, currency: Currency.USD, account: 'A' },
      { date: new Date('2024-01-02'), type: TransactionType.Sell, instrumentTicker: 'TEST', quantity: 3, price: 11, fees: 0, currency: Currency.USD, account: 'A' }
    ];
    const prices: PricePoint[] = [
      { ticker: 'TEST', date: '2024-01-02', close: 11, currency: Currency.USD },
      { ticker: 'TEST', date: '2024-01-03', close: 12, currency: Currency.USD }
    ];

    const { history } = calculateHistoricalPerformance(transactions, [instr], prices, 1, 'daily');
    const day3 = history.find(h => h.date === '2024-01-03');
    expect(day3?.value).toBeCloseTo(7 * 12); // 10-3 = 7 qty
  });

  it('computes daily analytics (drawdown/vol) on daily series', () => {
    const history = [
      { date: '2024-01-01', value: 100, invested: 100, monthlyReturnPct: 0, cumulativeReturnPct: 0 },
      { date: '2024-01-02', value: 80, invested: 100, monthlyReturnPct: 0, cumulativeReturnPct: -20 },
      { date: '2024-01-03', value: 90, invested: 100, monthlyReturnPct: 0, cumulativeReturnPct: -10 }
    ];
    const analytics = calculateAnalytics(history, 'daily');
    expect(analytics.maxDrawdown).toBeCloseTo(-20);
    expect(analytics.drawdownSeries[1].depth).toBeCloseTo(-20);
    expect(analytics.stdDev).toBeGreaterThan(0);
  });
});
