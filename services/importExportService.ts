import Dexie from 'dexie';
import { format } from 'date-fns';
import { db } from '../db';
import { AppSettings, Currency, Instrument, InstrumentListing, MacroIndicator, PricePoint, Transaction, TransactionType, AssetType, FxRate, PriceTickerConfig } from '../types';
import { isYmd, parseYmdLocal } from './dateUtils';
import { toNum } from './diagnostics';

export type ImportTableName =
  | 'portfolios'
  | 'settings'
  | 'instruments'
  | 'transactions'
  | 'prices'
  | 'macro'
  | 'fxRates'
  | 'instrumentListings';

export type ImportIssueReason = {
  code: string;
  count: number;
  examples: string[];
};

export type TableImportReport = {
  total: number;
  imported: number;
  discarded: number;
  reasons: ImportIssueReason[];
  error?: string;
};

export type ImportReport = {
  tables: Record<ImportTableName, TableImportReport>;
  warnings: string[];
  errors: string[];
};

export type NormalizedPayload = {
  version?: number | string;
  exportedAt?: string;
  portfolios: { id?: number; portfolioId: string; name: string }[];
  settings: AppSettings[];
  instruments: Instrument[];
  instrumentListings: (InstrumentListing & { id?: number; isin: string; portfolioId?: string })[];
  transactions: Transaction[];
  prices: PricePoint[];
  macro: MacroIndicator[];
  fxRates: FxRate[];
};

export type DetectFormatResult = {
  version?: number | string;
  warnings: string[];
};

export type ImportToDbOptions = {
  defaultPortfolioId?: string;
  mode?: 'merge';
};

const TABLES: ImportTableName[] = [
  'portfolios',
  'settings',
  'instruments',
  'instrumentListings',
  'transactions',
  'prices',
  'fxRates',
  'macro'
];

const createEmptyReport = (): ImportReport => {
  const tables = {} as Record<ImportTableName, TableImportReport>;
  TABLES.forEach(table => {
    tables[table] = { total: 0, imported: 0, discarded: 0, reasons: [] };
  });
  return { tables, warnings: [], errors: [] };
};

const addReason = (report: ImportReport, table: ImportTableName, code: string, example?: string) => {
  const entry = report.tables[table];
  let reason = entry.reasons.find(r => r.code === code);
  if (!reason) {
    reason = { code, count: 0, examples: [] };
    entry.reasons.push(reason);
  }
  reason.count += 1;
  if (example && reason.examples.length < 3) reason.examples.push(example);
};

const finalizeTable = (report: ImportReport, table: ImportTableName, total: number, imported: number) => {
  report.tables[table].total = total;
  report.tables[table].imported = imported;
  report.tables[table].discarded = Math.max(0, total - imported);
  report.tables[table].reasons = report.tables[table].reasons
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);
};

const asString = (value: unknown) => typeof value === 'string' ? value : value == null ? '' : String(value);

const normalizeTicker = (value: unknown) => asString(value).trim();

const normalizeCurrency = (value: unknown): Currency | null => {
  const raw = asString(value).trim().toUpperCase();
  if ((Object.values(Currency) as string[]).includes(raw)) return raw as Currency;
  return null;
};

const normalizeAssetType = (value: unknown): AssetType | null => {
  const raw = asString(value).trim();
  if ((Object.values(AssetType) as string[]).includes(raw)) return raw as AssetType;
  return null;
};

const normalizeTransactionType = (value: unknown): TransactionType | null => {
  const raw = asString(value).trim();
  if ((Object.values(TransactionType) as string[]).includes(raw)) return raw as TransactionType;
  return null;
};

const normalizeYmd = (value: unknown): string | null => {
  const raw = asString(value).trim();
  if (!raw) return null;
  if (isYmd(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return format(parsed, 'yyyy-MM-dd');
};

const normalizeDateObj = (value: unknown): Date | null => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const raw = asString(value).trim();
  if (!raw) return null;
  if (isYmd(raw)) {
    const parsed = parseYmdLocal(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const normalizeNumber = (value: unknown): number | null => {
  const num = toNum(value);
  if (num === null || !Number.isFinite(num)) return null;
  return num;
};

export const detectFormat = (payload: unknown): DetectFormatResult => {
  const warnings: string[] = [];
  if (!payload || typeof payload !== 'object') {
    warnings.push('Formato JSON non valido.');
    return { warnings };
  }
  const version = (payload as any).version;
  if (version === undefined || version === null || version === '') {
    warnings.push('Formato senza versione: provo import best-effort.');
  } else if (typeof version !== 'number' && typeof version !== 'string') {
    warnings.push('Versione non riconosciuta: provo import best-effort.');
  }
  return { version, warnings };
};

export const validateAndNormalize = (payload: any): { normalized: NormalizedPayload; report: ImportReport; warnings: string[]; errors: string[] } => {
  const report = createEmptyReport();
  const warnings: string[] = [];
  const errors: string[] = [];

  if (!payload || typeof payload !== 'object') {
    errors.push('Formato JSON non valido');
    return {
      normalized: {
        portfolios: [],
        settings: [],
        instruments: [],
        instrumentListings: [],
        transactions: [],
        prices: [],
        macro: [],
        fxRates: []
      },
      report,
      warnings,
      errors
    };
  }

  const rawPortfolios = Array.isArray(payload.portfolios) ? payload.portfolios : [];
  const rawSettings = Array.isArray(payload.settings) ? payload.settings : [];
  const rawInstruments = Array.isArray(payload.instruments) ? payload.instruments : [];
  const rawListings = Array.isArray(payload.instrumentListings) ? payload.instrumentListings : [];
  const rawTransactions = Array.isArray(payload.transactions) ? payload.transactions : [];
  const rawPrices = Array.isArray(payload.prices) ? payload.prices : [];
  const rawMacro = Array.isArray(payload.macro) ? payload.macro : [];
  const rawFx = Array.isArray(payload.fxRates)
    ? payload.fxRates
    : Array.isArray(payload.fx)
      ? payload.fx
      : [];

  const rawInstrumentIdToTicker = new Map<string, string>();
  rawInstruments.forEach((inst: any) => {
    const id = inst?.id;
    const ticker = normalizeTicker(inst?.symbol || inst?.ticker);
    if (id !== undefined && id !== null && ticker) {
      rawInstrumentIdToTicker.set(String(id), ticker);
    }
  });

  const normalizedPortfolios: NormalizedPayload['portfolios'] = [];
  rawPortfolios.forEach((row: any) => {
    const portfolioId = normalizeTicker(row?.portfolioId || row?.id || '');
    const name = asString(row?.name).trim();
    if (!portfolioId || !name) {
      addReason(report, 'portfolios', 'missing_required', portfolioId || name || 'row');
      return;
    }
    normalizedPortfolios.push({ ...row, portfolioId, name });
  });
  finalizeTable(report, 'portfolios', rawPortfolios.length, normalizedPortfolios.length);

  const normalizedSettings: AppSettings[] = [];
  rawSettings.forEach((row: any) => {
    const baseCurrency = normalizeCurrency(row?.baseCurrency) || Currency.CHF;
    if (!normalizeCurrency(row?.baseCurrency)) {
      addReason(report, 'settings', 'invalid_currency', asString(row?.baseCurrency));
    }
    const scope = row?.priceBackfillScope === 'all' || row?.priceBackfillScope === 'current'
      ? row.priceBackfillScope
      : 'current';
    const preferredExchangesOrder = Array.isArray(row?.preferredExchangesOrder)
      ? row.preferredExchangesOrder.map((v: any) => asString(v).trim()).filter(Boolean)
      : undefined;
    const priceTickerConfig = row?.priceTickerConfig && typeof row.priceTickerConfig === 'object'
      ? (row.priceTickerConfig as Record<string, PriceTickerConfig>)
      : undefined;

    normalizedSettings.push({
      ...row,
      baseCurrency,
      eodhdApiKey: asString(row?.eodhdApiKey),
      googleSheetUrl: asString(row?.googleSheetUrl),
      appsScriptUrl: asString(row?.appsScriptUrl),
      appsScriptApiKey: asString(row?.appsScriptApiKey),
      minHistoryDate: normalizeYmd(row?.minHistoryDate) || row?.minHistoryDate,
      priceBackfillScope: scope,
      preferredExchangesOrder,
      priceTickerConfig
    });
  });
  finalizeTable(report, 'settings', rawSettings.length, normalizedSettings.length);

  const normalizedInstruments: Instrument[] = [];
  rawInstruments.forEach((row: any) => {
    const ticker = normalizeTicker(row?.ticker || row?.symbol);
    const name = asString(row?.name).trim();
    const type = normalizeAssetType(row?.type);
    const currency = normalizeCurrency(row?.currency);
    if (!ticker || !name || !type || !currency) {
      addReason(report, 'instruments', 'missing_required', ticker || name || 'row');
      return;
    }
    const symbol = normalizeTicker(row?.symbol) || ticker;
    const id = typeof row?.id === 'number' ? row.id : undefined;
    normalizedInstruments.push({
      ...row,
      id,
      symbol,
      ticker,
      name,
      type,
      currency
    });
  });
  finalizeTable(report, 'instruments', rawInstruments.length, normalizedInstruments.length);

  const instrumentByTicker = new Map<string, Instrument>();
  normalizedInstruments.forEach(inst => {
    if (inst.symbol) instrumentByTicker.set(inst.symbol, inst);
    if (inst.ticker) instrumentByTicker.set(inst.ticker, inst);
  });

  const normalizedTransactions: Transaction[] = [];
  rawTransactions.forEach((row: any) => {
    const type = normalizeTransactionType(row?.type);
    const date = normalizeDateObj(row?.date);
    const currency = normalizeCurrency(row?.currency);
    let instrumentTicker = normalizeTicker(row?.instrumentTicker);
    const instrumentId = row?.instrumentId !== undefined && row?.instrumentId !== null
      ? String(row.instrumentId)
      : undefined;
    if (!instrumentTicker && instrumentId) {
      const mapped = rawInstrumentIdToTicker.get(String(instrumentId));
      if (mapped) instrumentTicker = mapped;
    }
    if (!instrumentTicker && type && ![TransactionType.Deposit, TransactionType.Withdrawal, TransactionType.Fee].includes(type)) {
      addReason(report, 'transactions', 'missing_instrument', row?.instrumentTicker || row?.instrumentId || 'row');
      return;
    }
    if (!type || !date || !currency) {
      addReason(report, 'transactions', 'missing_required', instrumentTicker || row?.date || 'row');
      return;
    }
    const quantity = normalizeNumber(row?.quantity);
    let price = normalizeNumber(row?.price);
    if (price === null && [TransactionType.Deposit, TransactionType.Withdrawal, TransactionType.Fee].includes(type)) {
      price = 0;
    }
    const fees = normalizeNumber(row?.fees ?? 0) ?? 0;
    if (quantity === null || price === null || quantity < 0 || price < 0 || fees < 0) {
      addReason(report, 'transactions', 'invalid_number', instrumentTicker || 'row');
      return;
    }
    normalizedTransactions.push({
      ...row,
      instrumentId: instrumentId || row?.instrumentId,
      instrumentTicker: instrumentTicker || undefined,
      date,
      type,
      quantity,
      price,
      fees,
      currency,
      account: asString(row?.account)
    });
  });
  finalizeTable(report, 'transactions', rawTransactions.length, normalizedTransactions.length);

  const normalizedPrices: PricePoint[] = [];
  rawPrices.forEach((row: any) => {
    const ticker = normalizeTicker(row?.ticker);
    const date = normalizeYmd(row?.date);
    const close = normalizeNumber(row?.close);
    const currency = normalizeCurrency(row?.currency);
    if (!ticker || !date || close === null || close < 0 || !currency) {
      addReason(report, 'prices', 'invalid_row', ticker || row?.date || 'row');
      return;
    }
    normalizedPrices.push({
      ...row,
      ticker,
      date,
      close,
      currency
    });
  });
  finalizeTable(report, 'prices', rawPrices.length, normalizedPrices.length);

  const normalizedMacro: MacroIndicator[] = [];
  rawMacro.forEach((row: any) => {
    const date = normalizeYmd(row?.date);
    const value = normalizeNumber(row?.value);
    if (!date || value === null) {
      addReason(report, 'macro', 'invalid_row', row?.date || 'row');
      return;
    }
    normalizedMacro.push({
      ...row,
      date,
      value
    });
  });
  finalizeTable(report, 'macro', rawMacro.length, normalizedMacro.length);

  const normalizedFx: FxRate[] = [];
  rawFx.forEach((row: any) => {
    const baseCurrency = normalizeCurrency(row?.baseCurrency);
    const quoteCurrency = normalizeCurrency(row?.quoteCurrency);
    const date = normalizeYmd(row?.date);
    const rate = normalizeNumber(row?.rate ?? row?.close);
    if (!baseCurrency || !quoteCurrency || !date || rate === null || rate <= 0) {
      addReason(report, 'fxRates', 'invalid_row', row?.date || 'row');
      return;
    }
    normalizedFx.push({
      ...row,
      baseCurrency,
      quoteCurrency,
      date,
      rate
    });
  });
  finalizeTable(report, 'fxRates', rawFx.length, normalizedFx.length);

  const normalizedListings: NormalizedPayload['instrumentListings'] = [];
  rawListings.forEach((row: any) => {
    const symbol = normalizeTicker(row?.symbol);
    const exchangeCode = normalizeTicker(row?.exchangeCode);
    const isin = normalizeTicker(row?.isin);
    const currency = normalizeCurrency(row?.currency);
    if (!symbol || !exchangeCode || !currency || !isin) {
      addReason(report, 'instrumentListings', 'invalid_row', isin || symbol || exchangeCode || 'row');
      return;
    }
    normalizedListings.push({
      ...row,
      isin,
      symbol,
      exchangeCode,
      currency
    });
  });
  finalizeTable(report, 'instrumentListings', rawListings.length, normalizedListings.length);

  return {
    normalized: {
      version: payload.version,
      exportedAt: payload.exportedAt,
      portfolios: normalizedPortfolios,
      settings: normalizedSettings,
      instruments: normalizedInstruments,
      instrumentListings: normalizedListings,
      transactions: normalizedTransactions,
      prices: normalizedPrices,
      macro: normalizedMacro,
      fxRates: normalizedFx
    },
    report,
    warnings,
    errors
  };
};

const applyDefaultPortfolioId = <T extends { portfolioId?: string }>(rows: T[], fallback?: string): T[] => {
  if (!fallback) return rows;
  return rows.map(row => ({ ...row, portfolioId: row.portfolioId || fallback }));
};

const mapExistingByPortfolio = async (table: Dexie.Table<any, any>, portfolioIds: string[], field = 'portfolioId') => {
  if (portfolioIds.length === 0) return new Map<string, number>();
  const rows = await table.where(field).anyOf(portfolioIds).toArray();
  const map = new Map<string, number>();
  rows.forEach((row: any) => {
    if (row?.portfolioId && row?.id) map.set(String(row.portfolioId), row.id);
  });
  return map;
};

const attachPortfolioIds = async <T extends { portfolioId?: string; id?: number }>(rows: T[], table: Dexie.Table<any, any>): Promise<T[]> => {
  const ids = Array.from(new Set(rows.map(r => r.portfolioId).filter(Boolean))) as string[];
  const existing = await mapExistingByPortfolio(table, ids);
  return rows.map(row => {
    const id = row.portfolioId ? existing.get(row.portfolioId) : undefined;
    return id ? { ...row, id } as T : row;
  });
};

const attachInstrumentIds = async (rows: Instrument[]) => {
  const tickers = Array.from(new Set(rows.map(r => r.ticker).filter(Boolean)));
  if (tickers.length === 0) return rows;
  const existing = await db.instruments.where('ticker').anyOf(tickers).toArray();
  const map = new Map<string, number>();
  existing.forEach(row => {
    if (row.ticker && row.id) {
      const key = `${row.ticker}|${row.portfolioId || ''}`;
      map.set(key, row.id);
    }
  });
  return rows.map(row => {
    const key = `${row.ticker}|${row.portfolioId || ''}`;
    const id = map.get(key);
    return id ? { ...row, id } : row;
  });
};

const attachPriceIds = async (rows: PricePoint[]) => {
  const byKey = new Map<string, PricePoint[]>();
  rows.forEach(row => {
    const key = `${row.ticker}|${row.portfolioId || ''}`;
    const list = byKey.get(key) || [];
    list.push(row);
    byKey.set(key, list);
  });

  const result: PricePoint[] = [];
  for (const [key, list] of byKey.entries()) {
    const [ticker, portfolioId] = key.split('|');
    const dates = list.map(r => r.date).sort();
    const minDate = dates[0];
    const maxDate = dates[dates.length - 1];
    const existing = await db.prices
      .where('[ticker+date]')
      .between([ticker, minDate], [ticker, maxDate])
      .and(p => (p.portfolioId || '') === (portfolioId || ''))
      .toArray();
    const existingMap = new Map<string, number>();
    existing.forEach(row => {
      if (row.date && row.id) existingMap.set(`${row.ticker}|${row.date}|${row.portfolioId || ''}`, row.id);
    });
    list.forEach(row => {
      const id = existingMap.get(`${row.ticker}|${row.date}|${row.portfolioId || ''}`);
      result.push(id ? { ...row, id } : row);
    });
  }
  return result;
};

const attachFxIds = async (rows: FxRate[]) => {
  const byPair = new Map<string, FxRate[]>();
  rows.forEach(row => {
    const key = `${row.baseCurrency}|${row.quoteCurrency}`;
    const list = byPair.get(key) || [];
    list.push(row);
    byPair.set(key, list);
  });

  const result: FxRate[] = [];
  for (const [key, list] of byPair.entries()) {
    const [baseCurrency, quoteCurrency] = key.split('|') as [Currency, Currency];
    const dates = list.map(r => r.date).sort();
    const minDate = dates[0];
    const maxDate = dates[dates.length - 1];
    const existing = await db.fxRates
      .where('[baseCurrency+quoteCurrency+date]')
      .between([baseCurrency, quoteCurrency, minDate], [baseCurrency, quoteCurrency, maxDate])
      .toArray();
    const existingMap = new Map<string, number>();
    existing.forEach(row => {
      if (row.date && row.id) existingMap.set(`${row.baseCurrency}|${row.quoteCurrency}|${row.date}`, row.id);
    });
    list.forEach(row => {
      const id = existingMap.get(`${row.baseCurrency}|${row.quoteCurrency}|${row.date}`);
      result.push(id ? { ...row, id } : row);
    });
  }
  return result;
};

export const importToDb = async (
  normalized: NormalizedPayload,
  options?: ImportToDbOptions,
  baseReport?: ImportReport
): Promise<{ report: ImportReport; warnings: string[]; errors: string[] }> => {
  const report = baseReport ? JSON.parse(JSON.stringify(baseReport)) as ImportReport : createEmptyReport();
  const warnings: string[] = [];
  const errors: string[] = [];
  const fallbackPortfolioId = options?.defaultPortfolioId;

  const portfolios = normalized.portfolios.slice();
  const settings = applyDefaultPortfolioId(normalized.settings.slice(), fallbackPortfolioId);
  const instruments = applyDefaultPortfolioId(normalized.instruments.slice(), fallbackPortfolioId);
  const instrumentListings = applyDefaultPortfolioId(normalized.instrumentListings.slice(), fallbackPortfolioId);
  const transactions = applyDefaultPortfolioId(normalized.transactions.slice(), fallbackPortfolioId);
  const prices = applyDefaultPortfolioId(normalized.prices.slice(), fallbackPortfolioId);
  const macro = applyDefaultPortfolioId(normalized.macro.slice(), fallbackPortfolioId);
  const fxRates = normalized.fxRates.slice();

  if (!baseReport) {
    finalizeTable(report, 'portfolios', portfolios.length, portfolios.length);
    finalizeTable(report, 'settings', settings.length, settings.length);
    finalizeTable(report, 'instruments', instruments.length, instruments.length);
    finalizeTable(report, 'instrumentListings', instrumentListings.length, instrumentListings.length);
    finalizeTable(report, 'transactions', transactions.length, transactions.length);
    finalizeTable(report, 'prices', prices.length, prices.length);
    finalizeTable(report, 'fxRates', fxRates.length, fxRates.length);
    finalizeTable(report, 'macro', macro.length, macro.length);
  }

  try {
    const preparedPortfolios = await attachPortfolioIds(portfolios, db.portfolios);
    await db.transaction('rw', db.portfolios, async () => {
      if (preparedPortfolios.length) await db.portfolios.bulkPut(preparedPortfolios);
    });
  } catch (e: any) {
    report.tables.portfolios.error = e?.message || String(e);
    report.tables.portfolios.imported = 0;
    errors.push(`Portfolios: ${report.tables.portfolios.error}`);
  }

  try {
    const preparedSettings = await attachPortfolioIds(settings, db.settings);
    await db.transaction('rw', db.settings, async () => {
      if (preparedSettings.length) await db.settings.bulkPut(preparedSettings);
    });
  } catch (e: any) {
    report.tables.settings.error = e?.message || String(e);
    report.tables.settings.imported = 0;
    errors.push(`Settings: ${report.tables.settings.error}`);
  }

  try {
    const preparedInstruments = await attachInstrumentIds(instruments);
    await db.transaction('rw', db.instruments, async () => {
      if (preparedInstruments.length) await db.instruments.bulkPut(preparedInstruments);
    });
  } catch (e: any) {
    report.tables.instruments.error = e?.message || String(e);
    report.tables.instruments.imported = 0;
    errors.push(`Instruments: ${report.tables.instruments.error}`);
  }

  try {
    await db.transaction('rw', db.instrumentListings, async () => {
      if (instrumentListings.length) await db.instrumentListings.bulkPut(instrumentListings);
    });
  } catch (e: any) {
    report.tables.instrumentListings.error = e?.message || String(e);
    report.tables.instrumentListings.imported = 0;
    errors.push(`Listings: ${report.tables.instrumentListings.error}`);
  }

  try {
    await db.transaction('rw', db.transactions, async () => {
      if (transactions.length) await db.transactions.bulkPut(transactions);
    });
  } catch (e: any) {
    report.tables.transactions.error = e?.message || String(e);
    report.tables.transactions.imported = 0;
    errors.push(`Transactions: ${report.tables.transactions.error}`);
  }

  try {
    const preparedPrices = await attachPriceIds(prices);
    await db.transaction('rw', db.prices, async () => {
      if (preparedPrices.length) await db.prices.bulkPut(preparedPrices);
    });
  } catch (e: any) {
    report.tables.prices.error = e?.message || String(e);
    report.tables.prices.imported = 0;
    errors.push(`Prices: ${report.tables.prices.error}`);
  }

  try {
    const preparedFx = await attachFxIds(fxRates);
    await db.transaction('rw', db.fxRates, async () => {
      if (preparedFx.length) await db.fxRates.bulkPut(preparedFx);
    });
  } catch (e: any) {
    report.tables.fxRates.error = e?.message || String(e);
    report.tables.fxRates.imported = 0;
    errors.push(`FX: ${report.tables.fxRates.error}`);
  }

  try {
    await db.transaction('rw', db.macro, async () => {
      if (macro.length) await db.macro.bulkPut(macro);
    });
  } catch (e: any) {
    report.tables.macro.error = e?.message || String(e);
    report.tables.macro.imported = 0;
    errors.push(`Macro: ${report.tables.macro.error}`);
  }

  console.info('[IMPORT]', {
    portfolios: report.tables.portfolios,
    settings: report.tables.settings,
    instruments: report.tables.instruments,
    transactions: report.tables.transactions,
    prices: report.tables.prices,
    fxRates: report.tables.fxRates,
    macro: report.tables.macro,
    warnings,
    errors
  });

  return { report, warnings, errors };
};
