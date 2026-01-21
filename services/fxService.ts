import { db } from '../db';
import { Currency } from '../types';
import Dexie from 'dexie';

export const getFxRate = async (base: Currency, quote: Currency, date: string): Promise<number | null> => {
  if (base === quote) return 1;
  const rows = await db.fxRates
    .where('[baseCurrency+quoteCurrency+date]')
    .between([base, quote, Dexie.minKey], [base, quote, date])
    .last();
  return rows?.rate ?? null;
};

export type FxRateLookup = {
  rate: number;
  date: string;
  source?: string;
  inverse?: boolean;
};

export type FxRateRow = {
  baseCurrency: Currency;
  quoteCurrency: Currency;
  date: string;
  rate: number;
  source?: string;
};

export const getFxRateWithDate = async (
  base: Currency,
  quote: Currency,
  date: string
): Promise<FxRateLookup | null> => {
  if (base === quote) return { rate: 1, date };
  const row = await db.fxRates
    .where('[baseCurrency+quoteCurrency+date]')
    .between([base, quote, Dexie.minKey], [base, quote, date])
    .last() as FxRateRow | undefined;
  if (row?.rate) return { rate: row.rate, date: row.date, source: row.source };
  const inverse = await db.fxRates
    .where('[baseCurrency+quoteCurrency+date]')
    .between([quote, base, Dexie.minKey], [quote, base, date])
    .last() as FxRateRow | undefined;
  if (inverse?.rate) {
    return { rate: 1 / inverse.rate, date: inverse.date, source: inverse.source, inverse: true };
  }
  return null;
};

export const resolveFxRateFromSeries = (
  fxRates: FxRateRow[],
  base: Currency,
  quote: Currency,
  date: string
): FxRateLookup | null => {
  if (base === quote) return { rate: 1, date };
  let directRate: number | null = null;
  let directDate = '';
  let directSource: string | undefined;
  let inverseRate: number | null = null;
  let inverseDate = '';
  let inverseSource: string | undefined;
  fxRates.forEach(row => {
    if (row.date > date) return;
    if (row.baseCurrency === base && row.quoteCurrency === quote) {
      if (!directDate || row.date > directDate) {
        directRate = row.rate;
        directDate = row.date;
        directSource = row.source;
      }
    }
    if (row.baseCurrency === quote && row.quoteCurrency === base) {
      if (!inverseDate || row.date > inverseDate) {
        inverseRate = row.rate;
        inverseDate = row.date;
        inverseSource = row.source;
      }
    }
  });
  if (directRate !== null) return { rate: directRate, date: directDate, source: directSource };
  if (inverseRate !== null) return { rate: 1 / inverseRate, date: inverseDate, source: inverseSource, inverse: true };
  return null;
};

export const convertAmount = async (
  amount: number,
  from: Currency,
  to: Currency,
  date: string
): Promise<number | null> => {
  if (!Number.isFinite(amount)) return null;
  if (from === to) return amount;
  const lookup = await getFxRateWithDate(from, to, date);
  if (!lookup) return null;
  return amount * lookup.rate;
};

export const convertAmountFromSeries = (
  amount: number,
  from: Currency,
  to: Currency,
  date: string,
  fxRates: FxRateRow[]
): { value: number; lookup: FxRateLookup } | null => {
  if (!Number.isFinite(amount)) return null;
  if (from === to) {
    return { value: amount, lookup: { rate: 1, date } };
  }
  const lookup = resolveFxRateFromSeries(fxRates, from, to, date);
  if (!lookup) return null;
  return { value: amount * lookup.rate, lookup };
};

export const importFxCsv = async (file: File, base: Currency, quote: Currency, source = 'manual'): Promise<number> => {
  const text = await file.text();
  const lines = text.trim().split(/\r?\n/);
  let count = 0;
  for (const line of lines.slice(1)) { // skip header
    const [date, rateStr] = line.split(',').map(s => s.trim());
    const rate = parseFloat(rateStr);
    if (!date || !isFinite(rate)) continue;
    await db.fxRates.put({ baseCurrency: base, quoteCurrency: quote, date, rate, source });
    count++;
  }
  return count;
};
