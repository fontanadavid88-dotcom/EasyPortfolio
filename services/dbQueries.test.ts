import { beforeEach, describe, expect, it, vi } from 'vitest';
import { countTransactionsForTickerGlobal, deleteInstrumentGloballySafely, getNetPositionForTicker } from './dbQueries';
import { TransactionType } from '../types';
import { db } from '../db';

vi.mock('../db', () => {
  const transactionsTable = {
    where: vi.fn().mockReturnThis(),
    equals: vi.fn().mockReturnThis(),
    and: vi.fn().mockReturnThis(),
    count: vi.fn().mockResolvedValue(0),
    toArray: vi.fn().mockResolvedValue([])
  };
  const instrumentsTable = {
    where: vi.fn().mockReturnThis(),
    equals: vi.fn().mockReturnThis(),
    and: vi.fn().mockReturnThis(),
    delete: vi.fn().mockResolvedValue(0)
  };
  const pricesTable = {
    where: vi.fn().mockReturnThis(),
    between: vi.fn().mockReturnThis(),
    and: vi.fn().mockReturnThis(),
    delete: vi.fn().mockResolvedValue(0)
  };
  return {
    db: {
      transactions: transactionsTable,
      instruments: instrumentsTable,
      prices: pricesTable,
      transaction: vi.fn(async (_mode: string, _tables: any[], fn: () => Promise<void>) => fn())
    }
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('dbQueries', () => {
  it('countTransactionsForTickerGlobal returns count across portfolios', async () => {
    (db.transactions.count as any).mockResolvedValueOnce(2);
    const count = await countTransactionsForTickerGlobal('AAPL.US');
    expect(count).toBe(2);
    expect(db.transactions.where).toHaveBeenCalledWith('instrumentTicker');
    expect((db.transactions as any).equals).toHaveBeenCalledWith('AAPL.US');
  });

  it('deleteInstrumentGloballySafely deletes instrument and prices when safe, refuses when not safe', async () => {
    (db.transactions.count as any).mockResolvedValueOnce(0);
    (db.instruments.delete as any).mockResolvedValueOnce(1);
    (db.prices.delete as any).mockResolvedValueOnce(5);

    const okResult = await deleteInstrumentGloballySafely({ ticker: 'BTC-USD.SW', deletePrices: true });
    expect(okResult.ok).toBe(true);
    expect(db.instruments.delete).toHaveBeenCalled();
    expect(db.prices.delete).toHaveBeenCalled();

    (db.transactions.count as any).mockResolvedValueOnce(3);
    const noResult = await deleteInstrumentGloballySafely({ ticker: 'BTC-USD.SW', deletePrices: true });
    expect(noResult.ok).toBe(false);
    expect(noResult.reason).toBe('has_transactions');
  });

  it('getNetPositionForTicker sums buy and sell quantities', async () => {
    (db.transactions.toArray as any).mockResolvedValueOnce([
      { type: TransactionType.Buy, quantity: 10 },
      { type: TransactionType.Sell, quantity: 4 }
    ]);
    const net = await getNetPositionForTicker({ ticker: 'AAPL.US', portfolioId: 'p1' });
    expect(net).toBe(6);

    (db.transactions.toArray as any).mockResolvedValueOnce([
      { type: TransactionType.Buy, quantity: 10 },
      { type: TransactionType.Sell, quantity: 10 }
    ]);
    const netZero = await getNetPositionForTicker({ ticker: 'AAPL.US', portfolioId: 'p1' });
    expect(netZero).toBe(0);
  });
});
