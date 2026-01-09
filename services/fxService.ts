import { db } from '../db';
import { Currency, FxRate } from '../types';
import Dexie from 'dexie';

export const getFxRate = async (base: Currency, quote: Currency, date: string): Promise<number | null> => {
  if (base === quote) return 1;
  const rows = await db.fxRates
    .where('[baseCurrency+quoteCurrency+date]')
    .between([base, quote, Dexie.minKey], [base, quote, date])
    .last();
  return rows?.rate ?? null;
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
