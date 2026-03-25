import { Currency, Transaction, TransactionType } from '../types';

export type PositionCostBasis = {
  ticker: string;
  quantity: number;
  totalCost: number;
  avgCost?: number;
  currency?: Currency;
};

export const computePositionCostBasis = (transactions: Transaction[]): Map<string, PositionCostBasis> => {
  const sorted = transactions
    .filter(t => Boolean(t.instrumentTicker))
    .slice()
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  const running = new Map<string, { quantity: number; totalCost: number; currency?: Currency }>();

  sorted.forEach(tx => {
    if (!tx.instrumentTicker) return;
    if (tx.type !== TransactionType.Buy && tx.type !== TransactionType.Sell) return;
    const ticker = tx.instrumentTicker;
    const entry = running.get(ticker) || { quantity: 0, totalCost: 0, currency: tx.currency };
    if (!entry.currency && tx.currency) entry.currency = tx.currency;

    const qty = Number(tx.quantity || 0);
    if (!Number.isFinite(qty) || qty <= 0) return;
    const price = Number(tx.price || 0);
    const fees = Number(tx.fees || 0);

    if (tx.type === TransactionType.Buy) {
      entry.totalCost += qty * price + (Number.isFinite(fees) ? fees : 0);
      entry.quantity += qty;
    } else if (tx.type === TransactionType.Sell) {
      if (entry.quantity <= 0) {
        entry.quantity = 0;
        entry.totalCost = 0;
      } else {
        const avgCost = entry.totalCost / entry.quantity;
        const qtySold = Math.min(qty, entry.quantity);
        entry.totalCost -= avgCost * qtySold;
        entry.quantity -= qtySold;
        if (entry.quantity <= 1e-8) {
          entry.quantity = 0;
          entry.totalCost = 0;
        }
      }
    }

    running.set(ticker, entry);
  });

  const result = new Map<string, PositionCostBasis>();
  running.forEach((entry, ticker) => {
    if (entry.quantity <= 0) return;
    const avgCost = entry.totalCost / entry.quantity;
    result.set(ticker, {
      ticker,
      quantity: entry.quantity,
      totalCost: entry.totalCost,
      avgCost: Number.isFinite(avgCost) ? avgCost : undefined,
      currency: entry.currency
    });
  });

  return result;
};
