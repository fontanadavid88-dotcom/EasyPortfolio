import { db } from '../db';
import { BacktestImport, BacktestImportPrice } from '../types';
import { BacktestCsvPreview, BacktestCsvParsedRow } from './backtestCsvImport';
import { subDaysYmd } from './dateUtils';

export const saveBacktestImport = async (params: {
  portfolioId: string;
  preview: BacktestCsvPreview;
  rows: BacktestCsvParsedRow[];
  meta: {
    name: string;
    ticker: string;
    currency: string;
    assetClass: BacktestImport['assetClass'];
    notes?: string;
  };
  originalFileName: string;
}): Promise<number> => {
  const { portfolioId, preview, rows, meta, originalFileName } = params;
  const now = new Date().toISOString();

  const importRow: BacktestImport = {
    createdAt: now,
    updatedAt: now,
    name: meta.name.trim(),
    ticker: meta.ticker.trim(),
    currency: meta.currency.trim().toUpperCase(),
    assetClass: meta.assetClass,
    sourceLabel: 'CSV_IMPORT',
    rowCount: preview.rowCountRaw,
    validRowCount: preview.rowCountValid,
    firstDate: preview.firstDate,
    lastDate: preview.lastDate,
    originalFileName,
    notes: meta.notes,
    portfolioId
  };

  return db.transaction('rw', [db.backtestImports, db.backtestImportPrices], async () => {
    const importId = Number(await db.backtestImports.add(importRow));
    const prices: BacktestImportPrice[] = rows.map(row => ({
      importId,
      date: row.date,
      close: row.close
    }));
    if (prices.length > 0) {
      await db.backtestImportPrices.bulkPut(prices);
    }
    await db.backtestImports.update(importId, { updatedAt: new Date().toISOString() });
    return importId;
  });
};

export const listBacktestImports = async (portfolioId: string): Promise<BacktestImport[]> => {
  const rows = await db.backtestImports
    .where('portfolioId')
    .equals(portfolioId)
    .toArray();
  return rows.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
};

export const getBacktestImportPrices = async (importId: number): Promise<BacktestImportPrice[]> => {
  return db.backtestImportPrices.where('importId').equals(importId).sortBy('date');
};

export const getBacktestImportPricesByImportIds = async (params: {
  importIds: number[];
  startDate: string;
  endDate: string;
  lookbackDays?: number;
}): Promise<BacktestImportPrice[]> => {
  const { importIds, startDate, endDate, lookbackDays = 0 } = params;
  if (!importIds.length || !startDate || !endDate) return [];
  const startWithLookback = lookbackDays > 0 ? subDaysYmd(startDate, lookbackDays) : startDate;
  const endBound = `${endDate}\uffff`;
  const result: BacktestImportPrice[] = [];
  await Promise.all(importIds.map(async (importId) => {
    const rows = await db.backtestImportPrices
      .where('[importId+date]')
      .between([importId, startWithLookback], [importId, endBound])
      .toArray();
    if (rows.length) result.push(...rows);
  }));
  return result;
};

export const deleteBacktestImport = async (importId: number): Promise<void> => {
  await db.transaction('rw', [db.backtestImports, db.backtestImportPrices], async () => {
    await db.backtestImportPrices.where('importId').equals(importId).delete();
    await db.backtestImports.delete(importId);
  });
};
