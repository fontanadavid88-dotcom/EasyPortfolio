import { describe, expect, it } from 'vitest';
import { AssetType, Currency, Instrument, PortfolioPosition, Transaction, TransactionType } from '../types';
import { computePortfolioCostMetrics } from './portfolioCostService';
import { FxRateRow } from './fxService';

const makePosition = (ticker: string, value: number): PortfolioPosition => ({
  ticker,
  name: ticker,
  assetType: AssetType.ETF,
  currency: Currency.CHF,
  quantity: 1,
  currentPrice: value,
  currentValueCHF: value,
  targetPct: 0,
  currentPct: 0
});

const instruments: Instrument[] = [
  { ticker: 'AAA', name: 'AAA', type: AssetType.ETF, currency: Currency.CHF, terPct: 0.2 },
  { ticker: 'BBB', name: 'BBB', type: AssetType.ETF, currency: Currency.CHF, terPct: 0.4 },
  { ticker: 'CCC', name: 'CCC', type: AssetType.Stock, currency: Currency.CHF }
];

const tx = (overrides: Partial<Transaction>): Transaction => ({
  date: new Date('2026-01-01'),
  type: TransactionType.Buy,
  instrumentTicker: 'AAA',
  quantity: 1,
  price: 100,
  fees: 0,
  currency: Currency.CHF,
  account: 'A',
  ...overrides
});

describe('portfolioCostService', () => {
  it('computes weighted TER, coverage and annual TER cost without treating missing TER as zero', () => {
    const result = computePortfolioCostMetrics({
      transactions: [],
      instruments,
      positions: [
        makePosition('AAA', 1000),
        makePosition('BBB', 1000),
        makePosition('CCC', 2000)
      ],
      fxRates: [],
      rangeStartDate: '2026-01-01',
      rangeEndDate: '2026-12-31',
      baseCurrency: Currency.CHF
    });

    expect(result.weightedTerPct).toBeCloseTo(0.15);
    expect(result.annualTerCostBase).toBeCloseTo(6);
    expect(result.terCoveragePct).toBeCloseTo(50);
    expect(result.coveredValueBase).toBeCloseTo(2000);
    expect(result.uncoveredValueBase).toBeCloseTo(2000);
    expect(result.missingTerTickers).toEqual(['CCC']);
  });

  it('computes all-time, YTD and active range transaction fees including Fee rows', () => {
    const result = computePortfolioCostMetrics({
      transactions: [
        tx({ date: new Date('2025-12-31'), type: TransactionType.Buy, fees: 3 }),
        tx({ date: new Date('2026-01-10'), type: TransactionType.Sell, fees: 2 }),
        tx({ date: new Date('2026-02-01'), type: TransactionType.Fee, quantity: 5, fees: 0 }),
        tx({ date: new Date('2026-03-01'), type: TransactionType.Deposit, quantity: 100, fees: 99 })
      ],
      instruments,
      positions: [],
      fxRates: [],
      rangeStartDate: '2026-02-01',
      rangeEndDate: '2026-02-28',
      baseCurrency: Currency.CHF
    });

    expect(result.transactionFeesAllTimeBase).toBeCloseTo(10);
    expect(result.transactionFeesYtdBase).toBeCloseTo(7);
    expect(result.transactionFeesRangeBase).toBeCloseTo(5);
  });

  it('converts fees via FX and skips rows with missing FX', () => {
    const fxRates: FxRateRow[] = [
      { baseCurrency: Currency.USD, quoteCurrency: Currency.CHF, date: '2026-01-01', rate: 0.9 }
    ];
    const result = computePortfolioCostMetrics({
      transactions: [
        tx({ date: new Date('2026-01-02'), type: TransactionType.Buy, fees: 10, currency: Currency.USD }),
        tx({ date: new Date('2026-01-02'), type: TransactionType.Sell, fees: 10, currency: Currency.EUR })
      ],
      instruments,
      positions: [],
      fxRates,
      rangeStartDate: '2026-01-01',
      rangeEndDate: '2026-01-31',
      baseCurrency: Currency.CHF
    });

    expect(result.transactionFeesAllTimeBase).toBeCloseTo(9);
    expect(result.transactionFeesRangeBase).toBeCloseTo(9);
    expect(result.missingFxCount).toBe(1);
  });
});
