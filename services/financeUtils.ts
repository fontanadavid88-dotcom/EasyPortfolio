import { Transaction, TransactionType, Instrument } from '../types';

// Simplified Newton-Raphson for XIRR
export const calculateXIRR = (transactions: { amount: number; date: Date }[], guess = 0.1): number => {
  if (transactions.length < 2) return 0;

  const func = (rate: number) => {
    return transactions.reduce((sum, t) => {
      const days = (t.date.getTime() - transactions[0].date.getTime()) / (1000 * 3600 * 24);
      return sum + t.amount / Math.pow(1 + rate, days / 365);
    }, 0);
  };

  const deriv = (rate: number) => {
    return transactions.reduce((sum, t) => {
      const days = (t.date.getTime() - transactions[0].date.getTime()) / (1000 * 3600 * 24);
      return sum - (days / 365) * t.amount / Math.pow(1 + rate, days / 365 + 1);
    }, 0);
  };

  let rate = guess;
  for (let i = 0; i < 50; i++) {
    const y = func(rate);
    const dy = deriv(rate);
    if (Math.abs(dy) < 0.000001) break;
    const newRate = rate - y / dy;
    if (Math.abs(newRate - rate) < 0.000001) return newRate;
    rate = newRate;
  }
  return rate;
};

// Simple Maintenance Rebalancing Logic
export const calculateRebalancing = (
  holdings: { ticker: string; value: number; currentPct: number; targetPct: number }[],
  totalPortfolioValue: number
) => {
  return holdings.map(h => {
    const targetValue = totalPortfolioValue * (h.targetPct / 100);
    const diff = targetValue - h.value;
    return {
      ticker: h.ticker,
      action: diff > 0 ? 'BUY' : 'SELL',
      amount: Math.abs(diff),
      currentPct: h.currentPct,
      targetPct: h.targetPct
    };
  });
};

// Calculate Holdings from Transactions
export const calculateHoldings = (transactions: Transaction[]) => {
  const holdings = new Map<string, number>();
  
  transactions.forEach(t => {
    if (!t.instrumentTicker) return;
    const current = holdings.get(t.instrumentTicker) || 0;
    if (t.type === TransactionType.Buy) holdings.set(t.instrumentTicker, current + t.quantity);
    else if (t.type === TransactionType.Sell) holdings.set(t.instrumentTicker, current - t.quantity);
  });

  return holdings;
};
