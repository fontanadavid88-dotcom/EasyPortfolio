import { Currency, PricePoint } from '../types';
import { diffDaysYmd } from './dateUtils';
import { PRICE_GAP_DAYS } from './constants';

export type FilledPricePoint = PricePoint & {
  synthetic: boolean;
  fillType?: 'forward' | 'backfill';
  sourceDate?: string;
};

export type PriceFillWarning = {
  ticker: string;
  startDate: string;
  endDate: string;
  gapDays: number;
};

export type PriceFillMeta = {
  totalFilled: number;
  countsByTicker: Record<string, number>;
  filledRangesByTicker: Record<string, { start: string; end: string }>;
  warnings: PriceFillWarning[];
};

export type FillMissingPricesResult = {
  filledByTicker: Map<string, Map<string, FilledPricePoint>>;
  meta: PriceFillMeta;
};

const sortByDateAsc = (rows: PricePoint[]) =>
  rows.slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));

const normalizeCurrency = (value?: Currency) => value || Currency.CHF;

const buildWarnings = (ticker: string, rows: PricePoint[], gapWarningDays: number): PriceFillWarning[] => {
  const warnings: PriceFillWarning[] = [];
  const sorted = sortByDateAsc(rows);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (!prev.date || !curr.date) continue;
    const gap = diffDaysYmd(curr.date, prev.date);
    if (gap > gapWarningDays) {
      warnings.push({
        ticker,
        startDate: prev.date,
        endDate: curr.date,
        gapDays: gap
      });
    }
  }
  return warnings;
};

export const fillMissingPrices = (
  prices: PricePoint[],
  dateIndex: string[],
  options?: { tickers?: string[]; gapWarningDays?: number }
): FillMissingPricesResult => {
  const gapWarningDays = options?.gapWarningDays ?? PRICE_GAP_DAYS;
  const tickers = (options?.tickers && options.tickers.length > 0)
    ? options.tickers
    : Array.from(new Set(prices.map(p => p.ticker).filter(Boolean)));

  const pricesByTicker = new Map<string, PricePoint[]>();
  prices.forEach(p => {
    if (!p?.ticker || !p?.date) return;
    if (tickers.length > 0 && !tickers.includes(p.ticker)) return;
    const arr = pricesByTicker.get(p.ticker) || [];
    arr.push({ ...p, currency: normalizeCurrency(p.currency) });
    pricesByTicker.set(p.ticker, arr);
  });

  const filledByTicker = new Map<string, Map<string, FilledPricePoint>>();
  const countsByTicker: Record<string, number> = {};
  const filledRangesByTicker: Record<string, { start: string; end: string }> = {};
  const warnings: PriceFillWarning[] = [];
  let totalFilled = 0;

  tickers.forEach(ticker => {
    const rows = sortByDateAsc(pricesByTicker.get(ticker) || []);
    if (rows.length === 0) {
      filledByTicker.set(ticker, new Map());
      return;
    }

    warnings.push(...buildWarnings(ticker, rows, gapWarningDays));

    let lastActual: PricePoint | null = null;
    let nextIdx = 0;
    const filledByDate = new Map<string, FilledPricePoint>();

    dateIndex.forEach(dateStr => {
      while (nextIdx < rows.length && rows[nextIdx].date < dateStr) {
        lastActual = rows[nextIdx];
        nextIdx += 1;
      }

      if (nextIdx < rows.length && rows[nextIdx].date === dateStr) {
        const current = rows[nextIdx];
        lastActual = current;
        nextIdx += 1;
        filledByDate.set(dateStr, { ...current, synthetic: false });
        return;
      }

      if (lastActual) {
        const filled: FilledPricePoint = {
          ...lastActual,
          date: dateStr,
          synthetic: true,
          fillType: 'forward',
          sourceDate: lastActual.date
        };
        filledByDate.set(dateStr, filled);
        countsByTicker[ticker] = (countsByTicker[ticker] || 0) + 1;
        totalFilled += 1;
        const range = filledRangesByTicker[ticker];
        if (!range || dateStr < range.start) {
          filledRangesByTicker[ticker] = { start: dateStr, end: range?.end || dateStr };
        } else if (dateStr > range.end) {
          filledRangesByTicker[ticker] = { start: range.start, end: dateStr };
        }
        return;
      }

      if (nextIdx < rows.length) {
        const nextPrice = rows[nextIdx];
        const filled: FilledPricePoint = {
          ...nextPrice,
          date: dateStr,
          synthetic: true,
          fillType: 'backfill',
          sourceDate: nextPrice.date
        };
        filledByDate.set(dateStr, filled);
        countsByTicker[ticker] = (countsByTicker[ticker] || 0) + 1;
        totalFilled += 1;
        const range = filledRangesByTicker[ticker];
        if (!range || dateStr < range.start) {
          filledRangesByTicker[ticker] = { start: dateStr, end: range?.end || dateStr };
        } else if (dateStr > range.end) {
          filledRangesByTicker[ticker] = { start: range.start, end: dateStr };
        }
      }
    });

    filledByTicker.set(ticker, filledByDate);
  });

  return {
    filledByTicker,
    meta: {
      totalFilled,
      countsByTicker,
      filledRangesByTicker,
      warnings
    }
  };
};
