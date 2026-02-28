import { describe, it, expect } from 'vitest';
import { addDays, format } from 'date-fns';
import { calculateHistoricalPerformance, computeMwrrSeries, computeTWRRFromNav } from './financeUtils';
import { analyzePriceSeries } from './dataQuality';
import { AssetType, Currency, TransactionType, Instrument, Transaction, PricePoint } from '../types';

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const makeYmd = (start: Date, offset: number) => format(addDays(start, offset), 'yyyy-MM-dd');

const buildLargeDataset = (opts?: { instruments?: number; days?: number }) => {
  const instrumentCount = opts?.instruments ?? 50;
  const days = opts?.days ?? 200;
  const start = new Date('2020-01-02T00:00:00Z');
  const instruments: Instrument[] = [];
  const transactions: Transaction[] = [];
  const prices: PricePoint[] = [];

  for (let i = 0; i < instrumentCount; i += 1) {
    const ticker = `TICK${i}`;
    instruments.push({
      id: i + 1,
      ticker,
      name: `Instrument ${i}`,
      type: AssetType.Stock,
      currency: Currency.USD
    });
    transactions.push({
      date: new Date(start),
      instrumentTicker: ticker,
      type: TransactionType.Buy,
      quantity: 10,
      price: 100 + i,
      fees: 1,
      currency: Currency.USD,
      account: 'TEST'
    });
  }

  transactions.push({
    date: new Date(start),
    type: TransactionType.Deposit,
    quantity: instrumentCount * 1000,
    price: 0,
    fees: 0,
    currency: Currency.CHF,
    account: 'TEST'
  });

  for (let d = 0; d < days; d += 1) {
    const date = makeYmd(start, d);
    for (let i = 0; i < instrumentCount; i += 1) {
      const ticker = `TICK${i}`;
      prices.push({
        ticker,
        date,
        close: 100 + i * 0.1 + d * 0.01,
        currency: Currency.USD
      });
    }
  }

  return { instruments, transactions, prices };
};

describe('perf.largeDataset', () => {
  it('calculateHistoricalPerformance daily + monthly stays within soft budget', () => {
    const { instruments, transactions, prices } = buildLargeDataset({ instruments: 50, days: 200 });
    const softLimitMs = Number(process.env.PERF_HISTORY_BUDGET_MS ?? 2500);

    const t0 = nowMs();
    const daily = calculateHistoricalPerformance(transactions, instruments, prices, 24, 'daily');
    const t1 = nowMs();
    const monthly = calculateHistoricalPerformance(transactions, instruments, prices, 24, 'monthly');
    const t2 = nowMs();

    expect(daily.history.length).toBeGreaterThan(0);
    expect(monthly.history.length).toBeGreaterThan(0);
    expect(Math.round(t1 - t0)).toBeLessThan(softLimitMs);
    expect(Math.round(t2 - t1)).toBeLessThan(softLimitMs);
  });

  it('analyzePriceSeries on large series returns stats within soft budget', () => {
    const points: PricePoint[] = [];
    const start = new Date('2020-01-02T00:00:00Z');
    const totalPoints = 20000;
    for (let i = 0; i < totalPoints; i += 1) {
      points.push({
        ticker: 'BIG',
        date: makeYmd(start, i),
        close: 100 + (i % 200) * 0.5,
        currency: Currency.USD
      });
    }

    const softLimitMs = Number(process.env.PERF_SERIES_BUDGET_MS ?? 2500);
    const t0 = nowMs();
    const result = analyzePriceSeries(points, { gapDays: 7 });
    const t1 = nowMs();

    expect(result.stats.count).toBe(totalPoints);
    expect(result.stats.startDate).toBe(points[0].date);
    expect(result.stats.endDate).toBe(points[points.length - 1].date);
    expect(Math.round(t1 - t0)).toBeLessThan(softLimitMs);
  });

  it('computeTWRRFromNav + computeMwrrSeries returns series under soft budget', () => {
    const { instruments, transactions, prices } = buildLargeDataset({ instruments: 40, days: 160 });
    const history = calculateHistoricalPerformance(transactions, instruments, prices, 18, 'daily').history;
    expect(history.length).toBeGreaterThan(0);

    const externalFlows = [
      { date: history[0].date, amount: 1000 },
      { date: history[Math.min(10, history.length - 1)].date, amount: -200 }
    ];

    const softLimitMs = Number(process.env.PERF_RETURNS_BUDGET_MS ?? 2500);
    const t0 = nowMs();
    const twrr = computeTWRRFromNav(history as any, externalFlows);
    const mwrr = computeMwrrSeries(history as any, transactions as any);
    const t1 = nowMs();

    expect(twrr.length).toBe(history.length);
    expect(mwrr.length).toBe(history.length);
    expect(Math.round(t1 - t0)).toBeLessThan(softLimitMs);
  });
});
