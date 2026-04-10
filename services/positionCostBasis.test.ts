import { describe, it, expect } from 'vitest';
import { computePositionCostBasis } from './positionCostBasis';
import { Currency, Transaction, TransactionType } from '../types';

const makeTx = (overrides: Partial<Transaction>): Transaction => ({
  date: new Date('2026-01-01'),
  instrumentTicker: 'AAA',
  type: TransactionType.Buy,
  quantity: 1,
  price: 100,
  fees: 0,
  currency: Currency.USD,
  account: 'TEST',
  ...overrides
});

describe('computePositionCostBasis', () => {
  it('includes fees in PMC across multiple buys', () => {
    const txs: Transaction[] = [
      makeTx({ date: new Date('2026-01-01'), quantity: 10, price: 100, fees: 5 }),
      makeTx({ date: new Date('2026-01-10'), quantity: 5, price: 110, fees: 0 })
    ];
    const result = computePositionCostBasis(txs).get('AAA');
    expect(result?.quantity).toBeCloseTo(15, 6);
    expect(result?.totalCost).toBeCloseTo(1555, 6);
    expect(result?.avgCost).toBeCloseTo(103.6667, 4);
  });

  it('keeps PMC stable after partial sell', () => {
    const txs: Transaction[] = [
      makeTx({ date: new Date('2026-01-01'), quantity: 10, price: 100, fees: 0 }),
      makeTx({ date: new Date('2026-01-15'), type: TransactionType.Sell, quantity: 4, price: 120, fees: 0 })
    ];
    const result = computePositionCostBasis(txs).get('AAA');
    expect(result?.quantity).toBeCloseTo(6, 6);
    expect(result?.totalCost).toBeCloseTo(600, 6);
    expect(result?.avgCost).toBeCloseTo(100, 6);
  });

  it('resets PMC after full close and reopens on new buy', () => {
    const txs: Transaction[] = [
      makeTx({ date: new Date('2026-01-01'), quantity: 10, price: 100 }),
      makeTx({ date: new Date('2026-01-10'), type: TransactionType.Sell, quantity: 10, price: 90 }),
      makeTx({ date: new Date('2026-02-01'), quantity: 5, price: 80 })
    ];
    const result = computePositionCostBasis(txs).get('AAA');
    expect(result?.quantity).toBeCloseTo(5, 6);
    expect(result?.totalCost).toBeCloseTo(400, 6);
    expect(result?.avgCost).toBeCloseTo(80, 6);
  });

  it('ignores non trading transactions for PMC', () => {
    const txs: Transaction[] = [
      makeTx({ date: new Date('2026-01-01'), type: TransactionType.Dividend, quantity: 1, price: 999 }),
      makeTx({ date: new Date('2026-01-02'), type: TransactionType.Deposit, quantity: 1, price: 999 }),
      makeTx({ date: new Date('2026-01-03'), type: TransactionType.Withdrawal, quantity: 1, price: 999 }),
      makeTx({ date: new Date('2026-01-04'), type: TransactionType.Fee, quantity: 1, price: 999 }),
      makeTx({ date: new Date('2026-01-05'), quantity: 2, price: 50, fees: 2 })
    ];
    const result = computePositionCostBasis(txs).get('AAA');
    expect(result?.quantity).toBeCloseTo(2, 6);
    expect(result?.totalCost).toBeCloseTo(102, 6);
    expect(result?.avgCost).toBeCloseTo(51, 6);
  });
});
