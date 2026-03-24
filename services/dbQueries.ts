import Dexie from 'dexie';
import { db } from '../db';
import { FxRate, PricePoint, TransactionType } from '../types';
import { subDaysYmd } from './dateUtils';

const priceRangeCache = new Map<string, { ts: number; data: PricePoint[] }>();
const fxRangeCache = new Map<string, { ts: number; data: FxRate[] }>();
const latestPriceCache = new Map<string, { ts: number; data: PricePoint[] }>();
const latestFxCache = new Map<string, { ts: number; data: FxRate[] }>();

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export const queryPricesForTickersRange = async (params: {
  portfolioId: string;
  tickers: string[];
  startDate: string;
  endDate: string;
  lookbackDays?: number;
  cacheTtlMs?: number;
}): Promise<PricePoint[]> => {
  const { portfolioId, tickers, startDate, endDate, lookbackDays = 0, cacheTtlMs = 5000 } = params;
  if (!tickers.length || !startDate || !endDate) return [];
  const startWithLookback = lookbackDays > 0 ? subDaysYmd(startDate, lookbackDays) : startDate;
  const endBound = `${endDate}\uffff`;
  const key = `${portfolioId}|${startWithLookback}|${endBound}|${tickers.join(',')}`;
  const cached = priceRangeCache.get(key);
  if (cached && nowMs() - cached.ts < cacheTtlMs) return cached.data;

  const result: PricePoint[] = [];
  await Promise.all(tickers.map(async (ticker) => {
    const rows = await db.prices
      .where('[ticker+date]')
      .between([ticker, startWithLookback], [ticker, endBound])
      .and(p => p.portfolioId === portfolioId)
      .toArray();
    if (rows.length) result.push(...rows);
  }));

  priceRangeCache.set(key, { ts: nowMs(), data: result });
  return result;
};

export const queryFxForPairsRange = async (params: {
  pairs: string[];
  startDate: string;
  endDate: string;
  lookbackDays?: number;
  cacheTtlMs?: number;
}): Promise<FxRate[]> => {
  const { pairs, startDate, endDate, lookbackDays = 0, cacheTtlMs = 5000 } = params;
  if (!pairs.length || !startDate || !endDate) return [];
  const startWithLookback = lookbackDays > 0 ? subDaysYmd(startDate, lookbackDays) : startDate;
  const endBound = `${endDate}\uffff`;
  const key = `${startWithLookback}|${endBound}|${pairs.join(',')}`;
  const cached = fxRangeCache.get(key);
  if (cached && nowMs() - cached.ts < cacheTtlMs) return cached.data;

  const result: FxRate[] = [];
  await Promise.all(pairs.map(async (pair) => {
    const [base, quote] = pair.split('/');
    if (!base || !quote) return;
    const rows = await db.fxRates
      .where('[baseCurrency+quoteCurrency+date]')
      .between([base, quote, startWithLookback], [base, quote, endBound])
      .toArray();
    if (rows.length) result.push(...rows as FxRate[]);
  }));

  fxRangeCache.set(key, { ts: nowMs(), data: result });
  return result;
};

export const queryLatestPricesForTickers = async (params: {
  portfolioId: string;
  tickers: string[];
  upToDate?: string;
  cacheTtlMs?: number;
}): Promise<PricePoint[]> => {
  const { portfolioId, tickers, upToDate, cacheTtlMs = 5000 } = params;
  if (!tickers.length) return [];
  const endBound = upToDate ?? Dexie.maxKey;
  const key = `${portfolioId}|${String(endBound)}|${tickers.join(',')}`;
  const cached = latestPriceCache.get(key);
  if (cached && nowMs() - cached.ts < cacheTtlMs) return cached.data;

  const result: PricePoint[] = [];
  await Promise.all(tickers.map(async (ticker) => {
    const row = await db.prices
      .where('[ticker+date]')
      .between([ticker, Dexie.minKey], [ticker, endBound])
      .and(p => p.portfolioId === portfolioId)
      .last();
    if (row) result.push(row);
  }));

  latestPriceCache.set(key, { ts: nowMs(), data: result });
  return result;
};

export const queryLatestFxForPairs = async (params: {
  pairs: string[];
  upToDate?: string;
  cacheTtlMs?: number;
}): Promise<FxRate[]> => {
  const { pairs, upToDate, cacheTtlMs = 5000 } = params;
  if (!pairs.length) return [];
  const endBound = upToDate ?? Dexie.maxKey;
  const key = `${String(endBound)}|${pairs.join(',')}`;
  const cached = latestFxCache.get(key);
  if (cached && nowMs() - cached.ts < cacheTtlMs) return cached.data;

  const result: FxRate[] = [];
  await Promise.all(pairs.map(async (pair) => {
    const [base, quote] = pair.split('/');
    if (!base || !quote) return;
    const row = await db.fxRates
      .where('[baseCurrency+quoteCurrency+date]')
      .between([base, quote, Dexie.minKey], [base, quote, endBound])
      .last();
    if (row) result.push(row as FxRate);
  }));

  latestFxCache.set(key, { ts: nowMs(), data: result });
  return result;
};

export const queryPriceBoundsForTickers = async (params: {
  portfolioId: string;
  tickers: string[];
  firstTransactionDate?: string;
}): Promise<{ firstPriceDate?: string; lastPriceDate?: string }> => {
  const { portfolioId, tickers, firstTransactionDate } = params;
  if (!tickers.length) return {};

  let firstPriceDate: string | undefined;
  let lastPriceDate: string | undefined;

  await Promise.all(tickers.map(async (ticker) => {
    const baseQuery = db.prices
      .where('[ticker+date]')
      .between([ticker, Dexie.minKey], [ticker, Dexie.maxKey])
      .and(p => p.portfolioId === portfolioId);

    const last = await baseQuery.last();
    if (last?.date && (!lastPriceDate || last.date > lastPriceDate)) {
      lastPriceDate = last.date;
    }

    if (firstTransactionDate) {
      const first = await db.prices
        .where('[ticker+date]')
        .between([ticker, firstTransactionDate], [ticker, Dexie.maxKey])
        .and(p => p.portfolioId === portfolioId)
        .first();
      if (first?.date && (!firstPriceDate || first.date < firstPriceDate)) {
        firstPriceDate = first.date;
      }
    }
  }));

  return { firstPriceDate, lastPriceDate };
};

export const countTransactionsForTicker = async (params: {
  ticker: string;
  portfolioId?: string;
}): Promise<number> => {
  const { ticker, portfolioId } = params;
  if (!ticker) return 0;
  let query = db.transactions.where('instrumentTicker').equals(ticker);
  if (portfolioId) {
    query = query.and(tx => (tx.portfolioId || '') === portfolioId);
  }
  return query.count();
};

export const countTransactionsForTickerPortfolio = async (ticker: string, portfolioId: string): Promise<number> => {
  return countTransactionsForTicker({ ticker, portfolioId });
};

export const countTransactionsForTickerGlobal = async (ticker: string): Promise<number> => {
  return countTransactionsForTicker({ ticker });
};

export const deleteInstrumentSafely = async (params: {
  ticker: string;
  portfolioId?: string;
  deletePrices?: boolean;
}): Promise<{ ok: boolean; reason?: 'has_transactions' | 'error'; deletedInstrument?: number; deletedPrices?: number; txCount?: number }> => {
  const { ticker, portfolioId, deletePrices } = params;
  if (!ticker) return { ok: false, reason: 'error' };
  const txCount = await countTransactionsForTicker({ ticker, portfolioId });
  if (txCount > 0) {
    return { ok: false, reason: 'has_transactions', txCount };
  }
  let deletedInstrument = 0;
  let deletedPrices = 0;
  try {
    await db.transaction('rw', [db.instruments, db.prices], async () => {
      deletedInstrument = await db.instruments
        .where('ticker')
        .equals(ticker)
        .and(inst => !portfolioId || (inst.portfolioId || '') === portfolioId)
        .delete();
      if (deletePrices) {
        deletedPrices = await db.prices
          .where('[ticker+date]')
          .between([ticker, Dexie.minKey], [ticker, Dexie.maxKey])
          .and(p => !portfolioId || (p.portfolioId || '') === portfolioId)
          .delete();
      }
    });
    return { ok: true, deletedInstrument, deletedPrices };
  } catch {
    return { ok: false, reason: 'error' };
  }
};

export const deleteInstrumentGloballySafely = async (params: {
  ticker: string;
  deletePrices?: boolean;
}): Promise<{ ok: boolean; reason?: 'has_transactions' | 'error'; deletedInstrument?: number; deletedPrices?: number; txCount?: number }> => {
  const { ticker, deletePrices } = params;
  if (!ticker) return { ok: false, reason: 'error' };
  const txCount = await countTransactionsForTickerGlobal(ticker);
  if (txCount > 0) {
    return { ok: false, reason: 'has_transactions', txCount };
  }
  let deletedInstrument = 0;
  let deletedPrices = 0;
  try {
    await db.transaction('rw', [db.instruments, db.prices], async () => {
      deletedInstrument = await db.instruments.where('ticker').equals(ticker).delete();
      if (deletePrices) {
        deletedPrices = await db.prices
          .where('[ticker+date]')
          .between([ticker, Dexie.minKey], [ticker, Dexie.maxKey])
          .delete();
      }
    });
    return { ok: true, deletedInstrument, deletedPrices };
  } catch {
    return { ok: false, reason: 'error' };
  }
};

export const getNetPositionForTicker = async (params: {
  ticker: string;
  portfolioId?: string;
}): Promise<number> => {
  const { ticker, portfolioId } = params;
  if (!ticker) return 0;
  let query = db.transactions.where('instrumentTicker').equals(ticker);
  if (portfolioId) {
    query = query.and(tx => (tx.portfolioId || '') === portfolioId);
  }
  const rows = await query.toArray();
  let net = 0;
  rows.forEach(tx => {
    if (tx.type === TransactionType.Buy) net += (tx.quantity || 0);
    if (tx.type === TransactionType.Sell) net -= (tx.quantity || 0);
  });
  return net;
};
