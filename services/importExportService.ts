import Dexie from 'dexie';
import { format } from 'date-fns';
import { db } from '../db';
import {
  AppSettings,
  AssetType,
  BacktestImport,
  BacktestImportPrice,
  BacktestScenarioRecord,
  Currency,
  FxRate,
  InflationAnnualPoint,
  InflationPoint,
  Instrument,
  InstrumentListing,
  MacroIndicator,
  PricePoint,
  PriceProviderType,
  PriceTickerConfig,
  RebalancePlan,
  Transaction,
  TransactionType
} from '../types';
import { isYmd, parseYmdLocal } from './dateUtils';
import { toNum } from './diagnostics';
import { upsertFxRowsByNaturalKey, upsertPriceRowsByNaturalKey, type NaturalKeyWriteSummary } from './dataWriteService';
import { pickDefaultListing } from './listingService';

export type ImportTableName =
  | 'portfolios'
  | 'settings'
  | 'instruments'
  | 'transactions'
  | 'prices'
  | 'macro'
  | 'fxRates'
  | 'instrumentListings'
  | 'inflationRates'
  | 'inflationAnnualRates'
  | 'rebalancePlans'
  | 'backtestImports'
  | 'backtestImportPrices'
  | 'backtestScenarios';

export type ImportIssueReason = {
  code: string;
  count: number;
  examples: string[];
};

export type TableImportReport = {
  total: number;
  imported: number;
  discarded: number;
  created?: number;
  updated?: number;
  unchanged?: number;
  deletedDuplicates?: number;
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
  inflationRates: InflationPoint[];
  inflationAnnualRates: InflationAnnualPoint[];
  rebalancePlans: RebalancePlan[];
  backtestImports: BacktestImport[];
  backtestImportPrices: BacktestImportPrice[];
  backtestScenarios: BacktestScenarioRecord[];
};

export type BackupPayload = NormalizedPayload;

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
  'macro',
  'inflationRates',
  'inflationAnnualRates',
  'rebalancePlans',
  'backtestImports',
  'backtestImportPrices',
  'backtestScenarios'
];

const DEFAULT_PREFERRED_EXCHANGES = ['SW', 'US', 'LSE', 'XETRA', 'MI', 'PA'];

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

const applyWriteSummary = (report: ImportReport, table: ImportTableName, summary: NaturalKeyWriteSummary) => {
  report.tables[table].created = summary.created;
  report.tables[table].updated = summary.updated;
  report.tables[table].unchanged = summary.unchanged;
  report.tables[table].deletedDuplicates = summary.deletedDuplicates;
};

const asString = (value: unknown) => typeof value === 'string' ? value : value == null ? '' : String(value);

const normalizeTicker = (value: unknown) => asString(value).trim().toUpperCase();

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

const normalizePriceProvider = (value: unknown): PriceProviderType | undefined => {
  const raw = asString(value).trim().toUpperCase();
  if (raw === 'EODHD' || raw === 'SHEETS' || raw === 'MANUAL') {
    return raw as PriceProviderType;
  }
  return undefined;
};

const normalizeIsin = (value: unknown): string => asString(value).trim().toUpperCase().replace(/\s+/g, '');

const normalizeInstrumentListing = (value: unknown): InstrumentListing | null => {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const symbol = normalizeTicker(row.symbol);
  const exchangeCode = normalizeTicker(row.exchangeCode);
  const currency = normalizeCurrency(row.currency);
  if (!symbol || !exchangeCode || !currency) return null;
  const name = asString(row.name).trim();
  const type = asString(row.type).trim();
  return {
    ...(row as any),
    symbol,
    exchangeCode,
    currency,
    ...(name ? { name } : {}),
    ...(type ? { type } : {})
  };
};

const dedupeListings = (listings: InstrumentListing[]): InstrumentListing[] => {
  return Array.from(new Map(listings.map(listing => [listing.symbol, listing])).values());
};

const hasMeaningfulTickerConfig = (value: PriceTickerConfig | undefined): boolean => {
  if (!value) return false;
  return Boolean(
    value.provider
    || value.eodhdSymbol
    || value.sheetSymbol
    || value.exclude !== undefined
    || value.needsMapping !== undefined
  );
};

const mergeTickerConfig = (
  base: PriceTickerConfig | undefined,
  incoming: PriceTickerConfig | undefined
): PriceTickerConfig | undefined => {
  if (!base && !incoming) return undefined;
  if (!base) return { ...incoming };
  if (!incoming) return { ...base };
  return {
    provider: base.provider || incoming.provider,
    eodhdSymbol: base.eodhdSymbol || incoming.eodhdSymbol,
    sheetSymbol: base.sheetSymbol || incoming.sheetSymbol,
    exclude: base.exclude ?? incoming.exclude,
    needsMapping: base.needsMapping ?? incoming.needsMapping
  };
};

const normalizePriceTickerConfigRecord = (
  value: unknown
): Record<string, PriceTickerConfig> | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const next: Record<string, PriceTickerConfig> = {};
  Object.entries(value as Record<string, unknown>).forEach(([rawTicker, rawConfig]) => {
    const ticker = normalizeTicker(rawTicker);
    if (!ticker || !rawConfig || typeof rawConfig !== 'object') return;
    const row = rawConfig as Record<string, unknown>;
    const entry: PriceTickerConfig = {};
    const provider = normalizePriceProvider(row.provider);
    const eodhdSymbol = normalizeTicker(row.eodhdSymbol);
    const sheetSymbol = asString(row.sheetSymbol).trim();
    if (provider) entry.provider = provider;
    if (eodhdSymbol) entry.eodhdSymbol = eodhdSymbol;
    if (sheetSymbol) entry.sheetSymbol = sheetSymbol;
    if (row.exclude !== undefined) entry.exclude = Boolean(row.exclude);
    if (row.needsMapping !== undefined) entry.needsMapping = Boolean(row.needsMapping);
    next[ticker] = mergeTickerConfig(next[ticker], entry) || {};
  });
  return next;
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

export const buildBackupPayload = async (): Promise<BackupPayload> => {
  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    portfolios: await db.portfolios.toArray(),
    settings: await db.settings.toArray(),
    instruments: await db.instruments.toArray(),
    instrumentListings: await db.instrumentListings.toArray(),
    transactions: await db.transactions.toArray(),
    prices: await db.prices.toArray(),
    macro: await db.macro.toArray(),
    fxRates: await db.fxRates.toArray(),
    inflationRates: await db.inflationRates.toArray(),
    inflationAnnualRates: await db.inflationAnnualRates.toArray(),
    rebalancePlans: await db.rebalancePlans.toArray(),
    backtestImports: await db.backtestImports.toArray(),
    backtestImportPrices: await db.backtestImportPrices.toArray(),
    backtestScenarios: await db.backtestScenarios.toArray()
  };
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
        fxRates: [],
        inflationRates: [],
        inflationAnnualRates: [],
        rebalancePlans: [],
        backtestImports: [],
        backtestImportPrices: [],
        backtestScenarios: []
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
  const rawInflationRates = Array.isArray(payload.inflationRates) ? payload.inflationRates : [];
  const rawInflationAnnualRates = Array.isArray(payload.inflationAnnualRates) ? payload.inflationAnnualRates : [];
  const rawRebalancePlans = Array.isArray(payload.rebalancePlans) ? payload.rebalancePlans : [];
  const rawBacktestImports = Array.isArray(payload.backtestImports) ? payload.backtestImports : [];
  const rawBacktestImportPrices = Array.isArray(payload.backtestImportPrices) ? payload.backtestImportPrices : [];
  const rawBacktestScenarios = Array.isArray(payload.backtestScenarios) ? payload.backtestScenarios : [];

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
    const priceTickerConfig = normalizePriceTickerConfigRecord(row?.priceTickerConfig);

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
    const isin = normalizeIsin(row?.isin) || undefined;
    const preferredListing = normalizeInstrumentListing(row?.preferredListing) || undefined;
    const normalizedListingArray = Array.isArray(row?.listings)
      ? row.listings.map((listing: any) => normalizeInstrumentListing(listing)).filter(Boolean) as InstrumentListing[]
      : [];
    const listings = dedupeListings([
      ...normalizedListingArray,
      ...(preferredListing ? [preferredListing] : [])
    ]);
    if (row?.preferredListing && !preferredListing) {
      addReason(report, 'instruments', 'invalid_preferred_listing', ticker);
    }
    if (Array.isArray(row?.listings) && listings.length < row.listings.length) {
      addReason(report, 'instruments', 'invalid_or_duplicate_listings', ticker);
    }
    normalizedInstruments.push({
      ...row,
      id,
      symbol,
      ticker,
      name,
      type,
      currency,
      isin,
      preferredListing,
      listings: listings.length ? listings : undefined
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

  const normalizedInflationRates: InflationPoint[] = [];
  rawInflationRates.forEach((row: any) => {
    const currency = normalizeCurrency(row?.currency);
    const date = normalizeYmd(row?.date);
    const index = normalizeNumber(row?.index);
    if (!currency || !date || index === null || index <= 0) {
      addReason(report, 'inflationRates', 'invalid_row', row?.date || row?.currency || 'row');
      return;
    }
    normalizedInflationRates.push({
      ...row,
      currency,
      date,
      index
    });
  });
  finalizeTable(report, 'inflationRates', rawInflationRates.length, normalizedInflationRates.length);

  const normalizedInflationAnnualRates: InflationAnnualPoint[] = [];
  rawInflationAnnualRates.forEach((row: any) => {
    const currency = normalizeCurrency(row?.currency);
    const year = normalizeNumber(row?.year);
    const ratePct = normalizeNumber(row?.ratePct);
    if (!currency || year === null || ratePct === null) {
      addReason(report, 'inflationAnnualRates', 'invalid_row', row?.year || row?.currency || 'row');
      return;
    }
    normalizedInflationAnnualRates.push({
      ...row,
      currency,
      year: Math.trunc(year),
      ratePct
    });
  });
  finalizeTable(report, 'inflationAnnualRates', rawInflationAnnualRates.length, normalizedInflationAnnualRates.length);

  const normalizedRebalancePlans: RebalancePlan[] = [];
  rawRebalancePlans.forEach((row: any) => {
    const portfolioId = asString(row?.portfolioId).trim();
    const id = asString(row?.id).trim();
    if (!portfolioId || !id || !Array.isArray(row?.items)) {
      addReason(report, 'rebalancePlans', 'invalid_row', id || portfolioId || 'row');
      return;
    }
    normalizedRebalancePlans.push({
      ...row,
      id,
      portfolioId,
      createdAt: Number(row?.createdAt || 0) || Date.now(),
      items: row.items
    });
  });
  finalizeTable(report, 'rebalancePlans', rawRebalancePlans.length, normalizedRebalancePlans.length);

  const normalizedBacktestImports: BacktestImport[] = [];
  rawBacktestImports.forEach((row: any) => {
    const name = asString(row?.name).trim();
    const ticker = normalizeTicker(row?.ticker);
    const currency = asString(row?.currency).trim().toUpperCase();
    if (!name || !ticker || !currency) {
      addReason(report, 'backtestImports', 'invalid_row', name || ticker || 'row');
      return;
    }
    normalizedBacktestImports.push({
      ...row,
      name,
      ticker,
      currency
    });
  });
  finalizeTable(report, 'backtestImports', rawBacktestImports.length, normalizedBacktestImports.length);

  const normalizedBacktestImportPrices: BacktestImportPrice[] = [];
  rawBacktestImportPrices.forEach((row: any) => {
    const importId = normalizeNumber(row?.importId);
    const date = normalizeYmd(row?.date);
    const close = normalizeNumber(row?.close);
    if (importId === null || date === null || close === null || close <= 0) {
      addReason(report, 'backtestImportPrices', 'invalid_row', row?.date || row?.importId || 'row');
      return;
    }
    normalizedBacktestImportPrices.push({
      ...row,
      importId: Math.trunc(importId),
      date,
      close
    });
  });
  finalizeTable(report, 'backtestImportPrices', rawBacktestImportPrices.length, normalizedBacktestImportPrices.length);

  const normalizedBacktestScenarios: BacktestScenarioRecord[] = [];
  rawBacktestScenarios.forEach((row: any) => {
    const title = asString(row?.title).trim();
    const startDate = normalizeYmd(row?.startDate);
    const endDate = normalizeYmd(row?.endDate);
    const initialCapital = normalizeNumber(row?.initialCapital);
    if (!title || !startDate || !endDate || initialCapital === null || !Array.isArray(row?.assets)) {
      addReason(report, 'backtestScenarios', 'invalid_row', title || row?.startDate || 'row');
      return;
    }
    normalizedBacktestScenarios.push({
      ...row,
      title,
      startDate,
      endDate,
      initialCapital
    });
  });
  finalizeTable(report, 'backtestScenarios', rawBacktestScenarios.length, normalizedBacktestScenarios.length);

  const normalizedListings: NormalizedPayload['instrumentListings'] = [];
  rawListings.forEach((row: any) => {
    const symbol = normalizeTicker(row?.symbol);
    const exchangeCode = normalizeTicker(row?.exchangeCode);
    const isin = normalizeIsin(row?.isin);
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
      fxRates: normalizedFx,
      inflationRates: normalizedInflationRates,
      inflationAnnualRates: normalizedInflationAnnualRates,
      rebalancePlans: normalizedRebalancePlans,
      backtestImports: normalizedBacktestImports,
      backtestImportPrices: normalizedBacktestImportPrices,
      backtestScenarios: normalizedBacktestScenarios
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

const applyPreparedRowStats = <T extends { id?: unknown }>(report: ImportReport, table: ImportTableName, rows: T[]) => {
  report.tables[table].imported = rows.length;
  report.tables[table].created = rows.filter(row => row.id === undefined || row.id === null || row.id === '').length;
  report.tables[table].updated = rows.length - (report.tables[table].created || 0);
  report.tables[table].unchanged = 0;
  report.tables[table].deletedDuplicates = 0;
};

type ListingImportRow = NormalizedPayload['instrumentListings'][number];

type InstrumentListingResolution = {
  portfolioId: string;
  ticker: string;
  canonicalTicker: string;
  aliases: string[];
  preferredChanged: boolean;
  configRekeyedFrom: string[];
};

export const reconcileImportedListingState = (params: {
  settings: AppSettings[];
  instruments: Instrument[];
  instrumentListings: ListingImportRow[];
}): {
  settings: AppSettings[];
  instruments: Instrument[];
  instrumentListings: ListingImportRow[];
  warnings: string[];
} => {
  const settingsByPortfolio = new Map<string, AppSettings>();
  params.settings.forEach(setting => {
    settingsByPortfolio.set(setting.portfolioId || 'default', setting);
  });

  const listingRows = new Map<string, ListingImportRow>();
  const listingsByPortfolioIsin = new Map<string, ListingImportRow[]>();
  const listingsByPortfolioSymbol = new Map<string, ListingImportRow[]>();
  const addListingRow = (row: ListingImportRow) => {
    const portfolioId = row.portfolioId || 'default';
    const key = `${portfolioId}|${row.isin}|${row.symbol}`;
    listingRows.set(key, row);

    const isinKey = `${portfolioId}|${row.isin}`;
    const byIsin = listingsByPortfolioIsin.get(isinKey) || [];
    byIsin.push(row);
    listingsByPortfolioIsin.set(isinKey, byIsin);

    const symbolKey = `${portfolioId}|${row.symbol}`;
    const bySymbol = listingsByPortfolioSymbol.get(symbolKey) || [];
    bySymbol.push(row);
    listingsByPortfolioSymbol.set(symbolKey, bySymbol);
  };

  params.instrumentListings.forEach(row => {
    const listing = normalizeInstrumentListing(row);
    const isin = normalizeIsin(row.isin);
    if (!listing || !isin) return;
    addListingRow({
      ...row,
      ...listing,
      isin,
      portfolioId: row.portfolioId || 'default'
    });
  });

  const resolutions: InstrumentListingResolution[] = [];

  const instruments = params.instruments.map(instrument => {
    const portfolioId = instrument.portfolioId || 'default';
    const settings = settingsByPortfolio.get(portfolioId);
    const preferredExchangesOrder = settings?.preferredExchangesOrder || DEFAULT_PREFERRED_EXCHANGES;
    const baseCurrency = settings?.baseCurrency || instrument.currency || Currency.CHF;
    const config = settings?.priceTickerConfig || {};
    const configuredListingSymbols = new Set(
      Object.entries(config)
        .filter(([, value]) => hasMeaningfulTickerConfig(value))
        .map(([ticker]) => ticker)
    );

    const normalizedIsin = normalizeIsin(instrument.isin) || undefined;
    const nestedListings = dedupeListings([
      ...(instrument.preferredListing ? [instrument.preferredListing] : []).map(listing => normalizeInstrumentListing(listing)).filter(Boolean) as InstrumentListing[],
      ...((instrument.listings || []).map(listing => normalizeInstrumentListing(listing)).filter(Boolean) as InstrumentListing[])
    ]);

    const aliasSymbols = new Set<string>(
      [instrument.ticker, instrument.symbol, ...nestedListings.map(listing => listing.symbol)]
        .map(value => normalizeTicker(value))
        .filter(Boolean)
    );

    const repoListingsByIsin = normalizedIsin
      ? (listingsByPortfolioIsin.get(`${portfolioId}|${normalizedIsin}`) || []).map(row => normalizeInstrumentListing(row)).filter(Boolean) as InstrumentListing[]
      : [];
    const repoListingsByAlias = Array.from(aliasSymbols)
      .flatMap(symbol => listingsByPortfolioSymbol.get(`${portfolioId}|${symbol}`) || [])
      .map(row => normalizeInstrumentListing(row))
      .filter(Boolean) as InstrumentListing[];

    const mergedListings = dedupeListings([
      ...nestedListings,
      ...repoListingsByIsin,
      ...repoListingsByAlias
    ]);

    const configuredListings = mergedListings.filter(listing => configuredListingSymbols.has(listing.symbol));
    const previousPreferredSymbol = normalizeTicker(instrument.preferredListing?.symbol);
    const preferredFromPayload = previousPreferredSymbol
      ? mergedListings.find(listing => listing.symbol === previousPreferredSymbol)
      : undefined;
    const explicitSymbolMatch = instrument.symbol
      ? mergedListings.find(listing => listing.symbol === normalizeTicker(instrument.symbol))
      : undefined;
    const tickerMatch = mergedListings.find(listing => listing.symbol === instrument.ticker);

    let preferredListing: InstrumentListing | undefined;
    if (preferredFromPayload) {
      preferredListing = preferredFromPayload;
    } else if (configuredListings.length === 1) {
      preferredListing = configuredListings[0];
    } else if (configuredListings.length > 1) {
      preferredListing = configuredListings.find(listing => listing.symbol === normalizeTicker(instrument.symbol))
        || configuredListings.find(listing => listing.symbol === instrument.ticker)
        || configuredListings[0];
    } else if (explicitSymbolMatch) {
      preferredListing = explicitSymbolMatch;
    } else if (tickerMatch) {
      preferredListing = tickerMatch;
    } else if (mergedListings.length === 1) {
      preferredListing = mergedListings[0];
    } else if (mergedListings.length > 1) {
      preferredListing = pickDefaultListing(mergedListings, preferredExchangesOrder, baseCurrency) || mergedListings[0];
    }

    const nextListings = mergedListings.length ? mergedListings : undefined;
    const canonicalTicker = preferredListing?.symbol || instrument.symbol || instrument.ticker;
    const aliases = Array.from(new Set([
      instrument.ticker,
      instrument.symbol,
      previousPreferredSymbol,
      ...mergedListings.map(listing => listing.symbol)
    ].filter(Boolean) as string[]));

    if (normalizedIsin && nextListings?.length) {
      nextListings.forEach(listing => {
        addListingRow({
          isin: normalizedIsin,
          exchangeCode: listing.exchangeCode,
          symbol: listing.symbol,
          currency: listing.currency,
          name: listing.name,
          portfolioId
        });
      });
    }

    resolutions.push({
      portfolioId,
      ticker: instrument.ticker,
      canonicalTicker,
      aliases,
      preferredChanged: Boolean(previousPreferredSymbol && preferredListing?.symbol && previousPreferredSymbol !== preferredListing.symbol),
      configRekeyedFrom: []
    });

    return {
      ...instrument,
      portfolioId,
      isin: normalizedIsin,
      preferredListing,
      listings: nextListings
    };
  });

  const settings = params.settings.map(setting => {
    const portfolioId = setting.portfolioId || 'default';
    const relevantResolutions = resolutions.filter(item => item.portfolioId === portfolioId);
    if (!relevantResolutions.length) {
      return {
        ...setting,
        portfolioId,
        priceTickerConfig: normalizePriceTickerConfigRecord(setting.priceTickerConfig) || {}
      };
    }

    const nextConfig: Record<string, PriceTickerConfig> = {
      ...(normalizePriceTickerConfigRecord(setting.priceTickerConfig) || {})
    };

    relevantResolutions.forEach(resolution => {
      const presentAliases = resolution.aliases.filter(alias => alias && hasMeaningfulTickerConfig(nextConfig[alias]));
      if (!presentAliases.length || !resolution.canonicalTicker) return;

      let mergedConfig: PriceTickerConfig | undefined = nextConfig[resolution.canonicalTicker];
      const consumedAliases = new Set<string>();
      presentAliases.forEach(alias => {
        mergedConfig = mergeTickerConfig(mergedConfig, nextConfig[alias]);
        if (alias !== resolution.canonicalTicker) {
          delete nextConfig[alias];
          consumedAliases.add(alias);
        }
      });
      if (mergedConfig) {
        nextConfig[resolution.canonicalTicker] = mergedConfig;
      }
      if (consumedAliases.size > 0) {
        resolution.configRekeyedFrom.push(...Array.from(consumedAliases));
      }
    });

    return {
      ...setting,
      portfolioId,
      priceTickerConfig: nextConfig
    };
  });

  const preferredChanges = resolutions.filter(item => item.preferredChanged).length;
  const configRekeys = resolutions.filter(item => item.configRekeyedFrom.length > 0);
  const warnings: string[] = [];
  if (preferredChanges > 0) {
    warnings.push(`Riallineati ${preferredChanges} preferred listing durante l'import.`);
  }
  if (configRekeys.length > 0) {
    const movedEntries = configRekeys.reduce((sum, item) => sum + item.configRekeyedFrom.length, 0);
    warnings.push(`Riallineate ${movedEntries} chiavi priceTickerConfig sul ticker canonico attivo.`);
  }

  return {
    settings,
    instruments,
    instrumentListings: Array.from(listingRows.values()),
    warnings
  };
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
  const listingState = reconcileImportedListingState({
    settings: applyDefaultPortfolioId(normalized.settings.slice(), fallbackPortfolioId),
    instruments: applyDefaultPortfolioId(normalized.instruments.slice(), fallbackPortfolioId),
    instrumentListings: applyDefaultPortfolioId(normalized.instrumentListings.slice(), fallbackPortfolioId)
  });
  warnings.push(...listingState.warnings);
  const settings = listingState.settings;
  const instruments = listingState.instruments;
  const instrumentListings = listingState.instrumentListings;
  const transactions = applyDefaultPortfolioId(normalized.transactions.slice(), fallbackPortfolioId);
  const prices = applyDefaultPortfolioId(normalized.prices.slice(), fallbackPortfolioId);
  const macro = applyDefaultPortfolioId(normalized.macro.slice(), fallbackPortfolioId);
  const fxRates = normalized.fxRates.slice();
  const inflationRates = applyDefaultPortfolioId(normalized.inflationRates.slice(), fallbackPortfolioId);
  const inflationAnnualRates = applyDefaultPortfolioId(normalized.inflationAnnualRates.slice(), fallbackPortfolioId);
  const rebalancePlans = applyDefaultPortfolioId(normalized.rebalancePlans.slice(), fallbackPortfolioId);
  const backtestImports = applyDefaultPortfolioId(normalized.backtestImports.slice(), fallbackPortfolioId);
  const backtestImportPrices = normalized.backtestImportPrices.slice();
  const backtestScenarios = applyDefaultPortfolioId(normalized.backtestScenarios.slice(), fallbackPortfolioId);

  if (!baseReport) {
    finalizeTable(report, 'portfolios', portfolios.length, portfolios.length);
    finalizeTable(report, 'settings', settings.length, settings.length);
    finalizeTable(report, 'instruments', instruments.length, instruments.length);
    finalizeTable(report, 'instrumentListings', instrumentListings.length, instrumentListings.length);
    finalizeTable(report, 'transactions', transactions.length, transactions.length);
    finalizeTable(report, 'prices', prices.length, prices.length);
    finalizeTable(report, 'fxRates', fxRates.length, fxRates.length);
    finalizeTable(report, 'macro', macro.length, macro.length);
    finalizeTable(report, 'inflationRates', inflationRates.length, inflationRates.length);
    finalizeTable(report, 'inflationAnnualRates', inflationAnnualRates.length, inflationAnnualRates.length);
    finalizeTable(report, 'rebalancePlans', rebalancePlans.length, rebalancePlans.length);
    finalizeTable(report, 'backtestImports', backtestImports.length, backtestImports.length);
    finalizeTable(report, 'backtestImportPrices', backtestImportPrices.length, backtestImportPrices.length);
    finalizeTable(report, 'backtestScenarios', backtestScenarios.length, backtestScenarios.length);
  }

  try {
    const preparedPortfolios = await attachPortfolioIds(portfolios, db.portfolios);
    await db.transaction('rw', db.portfolios, async () => {
      if (preparedPortfolios.length) await db.portfolios.bulkPut(preparedPortfolios);
    });
    applyPreparedRowStats(report, 'portfolios', preparedPortfolios);
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
    applyPreparedRowStats(report, 'settings', preparedSettings);
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
    applyPreparedRowStats(report, 'instruments', preparedInstruments);
  } catch (e: any) {
    report.tables.instruments.error = e?.message || String(e);
    report.tables.instruments.imported = 0;
    errors.push(`Instruments: ${report.tables.instruments.error}`);
  }

  try {
    await db.transaction('rw', db.instrumentListings, async () => {
      if (instrumentListings.length) await db.instrumentListings.bulkPut(instrumentListings);
    });
    applyPreparedRowStats(report, 'instrumentListings', instrumentListings);
  } catch (e: any) {
    report.tables.instrumentListings.error = e?.message || String(e);
    report.tables.instrumentListings.imported = 0;
    errors.push(`Listings: ${report.tables.instrumentListings.error}`);
  }

  try {
    await db.transaction('rw', db.transactions, async () => {
      if (transactions.length) await db.transactions.bulkPut(transactions);
    });
    applyPreparedRowStats(report, 'transactions', transactions);
  } catch (e: any) {
    report.tables.transactions.error = e?.message || String(e);
    report.tables.transactions.imported = 0;
    errors.push(`Transactions: ${report.tables.transactions.error}`);
  }

  try {
    const priceSummary = await upsertPriceRowsByNaturalKey(prices);
    report.tables.prices.imported = priceSummary.deduped;
    applyWriteSummary(report, 'prices', priceSummary);
  } catch (e: any) {
    report.tables.prices.error = e?.message || String(e);
    report.tables.prices.imported = 0;
    errors.push(`Prices: ${report.tables.prices.error}`);
  }

  try {
    const fxSummary = await upsertFxRowsByNaturalKey(fxRates);
    report.tables.fxRates.imported = fxSummary.deduped;
    applyWriteSummary(report, 'fxRates', fxSummary);
  } catch (e: any) {
    report.tables.fxRates.error = e?.message || String(e);
    report.tables.fxRates.imported = 0;
    errors.push(`FX: ${report.tables.fxRates.error}`);
  }

  try {
    await db.transaction('rw', db.macro, async () => {
      if (macro.length) await db.macro.bulkPut(macro);
    });
    applyPreparedRowStats(report, 'macro', macro);
  } catch (e: any) {
    report.tables.macro.error = e?.message || String(e);
    report.tables.macro.imported = 0;
    errors.push(`Macro: ${report.tables.macro.error}`);
  }

  try {
    await db.transaction('rw', db.inflationRates, async () => {
      if (inflationRates.length) await db.inflationRates.bulkPut(inflationRates);
    });
    applyPreparedRowStats(report, 'inflationRates', inflationRates);
  } catch (e: any) {
    report.tables.inflationRates.error = e?.message || String(e);
    report.tables.inflationRates.imported = 0;
    errors.push(`Inflation monthly: ${report.tables.inflationRates.error}`);
  }

  try {
    await db.transaction('rw', db.inflationAnnualRates, async () => {
      if (inflationAnnualRates.length) await db.inflationAnnualRates.bulkPut(inflationAnnualRates);
    });
    applyPreparedRowStats(report, 'inflationAnnualRates', inflationAnnualRates);
  } catch (e: any) {
    report.tables.inflationAnnualRates.error = e?.message || String(e);
    report.tables.inflationAnnualRates.imported = 0;
    errors.push(`Inflation annual: ${report.tables.inflationAnnualRates.error}`);
  }

  try {
    await db.transaction('rw', db.rebalancePlans, async () => {
      if (rebalancePlans.length) await db.rebalancePlans.bulkPut(rebalancePlans);
    });
    applyPreparedRowStats(report, 'rebalancePlans', rebalancePlans);
  } catch (e: any) {
    report.tables.rebalancePlans.error = e?.message || String(e);
    report.tables.rebalancePlans.imported = 0;
    errors.push(`Rebalance plans: ${report.tables.rebalancePlans.error}`);
  }

  try {
    await db.transaction('rw', db.backtestImports, async () => {
      if (backtestImports.length) await db.backtestImports.bulkPut(backtestImports);
    });
    applyPreparedRowStats(report, 'backtestImports', backtestImports);
  } catch (e: any) {
    report.tables.backtestImports.error = e?.message || String(e);
    report.tables.backtestImports.imported = 0;
    errors.push(`Backtest imports: ${report.tables.backtestImports.error}`);
  }

  try {
    await db.transaction('rw', db.backtestImportPrices, async () => {
      if (backtestImportPrices.length) await db.backtestImportPrices.bulkPut(backtestImportPrices);
    });
    applyPreparedRowStats(report, 'backtestImportPrices', backtestImportPrices);
  } catch (e: any) {
    report.tables.backtestImportPrices.error = e?.message || String(e);
    report.tables.backtestImportPrices.imported = 0;
    errors.push(`Backtest import prices: ${report.tables.backtestImportPrices.error}`);
  }

  try {
    await db.transaction('rw', db.backtestScenarios, async () => {
      if (backtestScenarios.length) await db.backtestScenarios.bulkPut(backtestScenarios);
    });
    applyPreparedRowStats(report, 'backtestScenarios', backtestScenarios);
  } catch (e: any) {
    report.tables.backtestScenarios.error = e?.message || String(e);
    report.tables.backtestScenarios.imported = 0;
    errors.push(`Backtest scenarios: ${report.tables.backtestScenarios.error}`);
  }

  console.info('[IMPORT]', {
    portfolios: report.tables.portfolios,
    settings: report.tables.settings,
    instruments: report.tables.instruments,
    transactions: report.tables.transactions,
    prices: report.tables.prices,
    fxRates: report.tables.fxRates,
    macro: report.tables.macro,
    inflationRates: report.tables.inflationRates,
    inflationAnnualRates: report.tables.inflationAnnualRates,
    rebalancePlans: report.tables.rebalancePlans,
    backtestImports: report.tables.backtestImports,
    backtestImportPrices: report.tables.backtestImportPrices,
    backtestScenarios: report.tables.backtestScenarios,
    warnings,
    errors
  });

  return { report, warnings, errors };
};
