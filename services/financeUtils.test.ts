import { describe, it, expect } from 'vitest';
import { calculateHistoricalPerformance, calculateAnalytics, computeTWRRFromNav } from './financeUtils';
import { fillMissingPrices } from './priceBackfill';
import { AssetType, Currency, Instrument, PricePoint, Transaction, TransactionType } from '../types';
import case1 from '../__fixtures__/case1_single_asset.json';
import case3 from '../__fixtures__/case3_missing_price.json';

const instr: Instrument = { id: 'inst-test', ticker: 'TEST', symbol: 'TEST', name: 'Test', type: AssetType.Stock, currency: Currency.USD };

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

  it('tracks backfilled values and ranges', () => {
    const prices: PricePoint[] = [
      { ticker: 'AAA', date: '2024-01-03', close: 12, currency: Currency.USD }
    ];
    const dateIndex = ['2024-01-01', '2024-01-02', '2024-01-03'];
    const result = fillMissingPrices(prices, dateIndex, { tickers: ['AAA'] });
    const filled = result.filledByTicker.get('AAA');
    expect(filled?.get('2024-01-01')?.fillType).toBe('backfill');
    expect(filled?.get('2024-01-02')?.fillType).toBe('backfill');
    expect(result.meta.countsByTicker.AAA).toBe(2);
    expect(result.meta.filledRangesByTicker.AAA).toEqual({ start: '2024-01-01', end: '2024-01-02' });
  });

  it('emits warnings when gaps exceed threshold', () => {
    const prices: PricePoint[] = [
      { ticker: 'AAA', date: '2024-01-01', close: 10, currency: Currency.USD },
      { ticker: 'AAA', date: '2024-01-10', close: 11, currency: Currency.USD }
    ];
    const dateIndex = ['2024-01-01', '2024-01-10'];
    const result = fillMissingPrices(prices, dateIndex, { tickers: ['AAA'], gapWarningDays: 3 });
    expect(result.meta.warnings.length).toBe(1);
    expect(result.meta.warnings[0].gapDays).toBe(9);
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

  it('annualized return is rebased on range (twrr index)', () => {
    const history = [
      { date: '2024-01-01', value: 100, invested: 100, monthlyReturnPct: 0, cumulativeReturnPct: 0, cumulativeTWRRIndex: 2 },
      { date: '2025-01-01', value: 150, invested: 100, monthlyReturnPct: 0, cumulativeReturnPct: 0, cumulativeTWRRIndex: 3 }
    ];
    const analytics = calculateAnalytics(history as any, 'daily');
    expect(analytics.annualizedReturn).toBeCloseTo(50, 0);
  });

  it('TWRR accounts for external cashflows only', () => {
    const history = [
      { date: '2024-01-01', value: 100, invested: 100, monthlyReturnPct: 0, cumulativeReturnPct: 0 },
      { date: '2024-01-02', value: 120, invested: 110, monthlyReturnPct: 0, cumulativeReturnPct: 0 }
    ];
    const withFlow = computeTWRRFromNav(history as any, [{ date: '2024-01-02', amount: 10 }]);
    const withoutFlow = computeTWRRFromNav(history as any, []);
    expect(withFlow[1].monthlyReturnPct).toBeCloseTo(10, 5);
    expect(withoutFlow[1].monthlyReturnPct).toBeCloseTo(20, 5);
  });

  it('backfills from next available price when series starts after transactions', () => {
    const instr = case3.instruments[0] as Instrument;
    const transactions = case3.transactions.map(t => ({
      ...t,
      date: new Date(t.date)
    })) as Transaction[];
    const prices = case3.prices as PricePoint[];
    const { history } = calculateHistoricalPerformance(transactions, [instr], prices, 1, 'daily');
    const start = history.find(h => h.date === '2023-03-01');
    expect(start?.value).toBeCloseTo(55);
    expect(start?.backfilledPriceTickers).toContain('MISSING');
  });

  it('case1 single asset returns realistic range', () => {
    const instr = case1.instruments[0] as Instrument;
    const transactions = case1.transactions.map(t => ({ ...t, date: new Date(t.date) })) as Transaction[];
    const prices = case1.prices as PricePoint[];
    const { history } = calculateHistoricalPerformance(transactions, [instr], prices, 12, 'daily');
    const analytics = calculateAnalytics(history, 'daily');
    expect(analytics.annualizedReturn).toBeGreaterThan(0);
    expect(analytics.stdDev).toBeGreaterThan(0);
  });
});
