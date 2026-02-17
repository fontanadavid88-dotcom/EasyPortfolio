import { AppSettings, Currency, MacroIndicator, PriceProviderType, PriceTickerConfig } from '../types';
import { asCurrency, asString } from './symbolUtils';
import { fetchJsonWithDiagnostics, FetchJsonDiagnostics, toNum } from './diagnostics';
import { db } from '../db';

export type AppsScriptDiagnostics = {
  url: string;
  diag: FetchJsonDiagnostics;
};

export type AppsScriptAssetRow = {
  ticker: string;
  sheetSymbol?: string;
  currency?: Currency;
  provider?: PriceProviderType;
  exclude?: boolean;
  needsMapping?: boolean;
  close?: number;
  date?: string;
};

export type AppsScriptMacroRow = {
  id: string;
  value: number;
  min?: number;
  max?: number;
  date?: string;
};
export type AppsScriptFxRow = {
  baseCurrency: Currency;
  quoteCurrency: Currency;
  date?: string;
  rate: number;
};

export type AppsScriptResult<T> =
  | { ok: true; data: T; diag: AppsScriptDiagnostics }
  | { ok: false; error: string; diag: AppsScriptDiagnostics };

const normalizeHeader = (value: string) => value.toLowerCase().replace(/[\s_-]+/g, '');

export const buildUrl = (baseUrl: string, params: Record<string, string>): string | null => {
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    Object.entries(params).forEach(([key, value]) => {
      if (value) url.searchParams.set(key, value);
    });
    return url.toString();
  } catch {
    return null;
  }
};

const sanitizeUrlForLog = (url: string) => {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('key');
    return parsed.toString();
  } catch {
    return url;
  }
};

const logDiag = (label: string, url: string, diag: FetchJsonDiagnostics) => {
  if (!import.meta.env?.DEV) return;
  console.log('[apps-script]', label, {
    url: sanitizeUrlForLog(url),
    httpStatus: diag.httpStatus,
    contentType: diag.contentType,
    parseError: diag.parseError,
    rawPreview: diag.rawPreview.slice(0, 300)
  });
};

const extractRows = (json: unknown): unknown[] | null => {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    const rows = obj.rows || obj.data || obj.values;
    if (Array.isArray(rows)) return rows;
  }
  return null;
};

const asBool = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  }
  return undefined;
};

const getField = (row: Record<string, unknown>, aliases: string[]): unknown => {
  const lookup = new Map<string, string>();
  Object.keys(row).forEach(key => lookup.set(normalizeHeader(key), key));
  for (const alias of aliases) {
    const key = lookup.get(normalizeHeader(alias));
    if (key) return row[key];
  }
  return undefined;
};

const rowsFromMatrix = (rows: unknown[]): Record<string, unknown>[] => {
  if (rows.length === 0) return [];
  if (!Array.isArray(rows[0])) return rows as Record<string, unknown>[];
  const headerRow = rows[0] as unknown[];
  const headers = headerRow.map(h => normalizeHeader(asString(h)));
  return rows.slice(1).map((row) => {
    const arr = Array.isArray(row) ? row : [];
    const obj: Record<string, unknown> = {};
    headers.forEach((header, idx) => {
      if (!header) return;
      obj[header] = arr[idx];
    });
    return obj;
  });
};

const parseAssetRow = (row: Record<string, unknown>): AppsScriptAssetRow | null => {
  const ticker = asString(getField(row, ['ticker', 'appticker'])).trim();
  if (!ticker) return null;
  const sheetSymbol = asString(getField(row, ['sheetsymbol', 'symbol', 'sheetsymbol', 'sheet_symbol'])).trim() || undefined;
  const providerRaw = asString(getField(row, ['provider'])).toUpperCase();
  const provider = providerRaw === 'EODHD' || providerRaw === 'SHEETS' || providerRaw === 'MANUAL'
    ? (providerRaw as PriceProviderType)
    : undefined;
  const currency = asCurrency(getField(row, ['currency'])) || undefined;
  const exclude = asBool(getField(row, ['exclude']));
  const needsMapping = asBool(getField(row, ['needsmapping', 'needs_mapping']));
  const close = toNum(getField(row, ['close', 'price', 'last', 'valore', 'prezzo']));
  const date = asString(getField(row, ['date', 'data', 'asof'])).trim() || undefined;
  return { ticker, sheetSymbol, provider, currency, exclude, needsMapping, close: close ?? undefined, date };
};

const parseMacroRow = (row: Record<string, unknown>): AppsScriptMacroRow | null => {
  const id = asString(getField(row, ['id', 'key', 'indicator'])).trim();
  const value = toNum(getField(row, ['value', 'val', 'current']));
  if (!id || value === null) return null;
  const min = toNum(getField(row, ['min']));
  const max = toNum(getField(row, ['max']));
  const date = asString(getField(row, ['date', 'data', 'asof'])).trim() || undefined;
  return { id, value, min: min ?? undefined, max: max ?? undefined, date };
};

const parseFxRow = (row: Record<string, unknown>): AppsScriptFxRow | null => {
  const baseCurrency = asCurrency(getField(row, ['baseCurrency', 'base', 'from', 'ccyFrom', 'base_ccy', 'basecurrency']));
  const quoteCurrency = asCurrency(getField(row, ['quoteCurrency', 'quote', 'to', 'ccyTo', 'quote_ccy', 'quotecurrency']));
  const rate = toNum(getField(row, ['rate', 'fx', 'value', 'val']));
  if (!baseCurrency || !quoteCurrency || rate === null) return null;
  const date = asString(getField(row, ['date', 'data', 'asof'])).trim() || undefined;
  return { baseCurrency, quoteCurrency, rate, date };
};

export const fetchAppsScript = async (
  settings: AppSettings,
  kind: 'ping' | 'assetsMap' | 'macro' | 'fx',
  params: Record<string, string> = {}
): Promise<AppsScriptResult<unknown>> => {
  const baseUrl = settings.appsScriptUrl?.trim() || '';
  const key = settings.appsScriptApiKey?.trim() || '';
  if (!baseUrl || !key) {
    return {
      ok: false,
      error: 'DISABILITATO',
      diag: { url: baseUrl || '', diag: { httpStatus: 0, ok: false, rawPreview: '' } }
    };
  }
  const url = buildUrl(baseUrl, { kind, key, ...params });
  if (!url) {
    return {
      ok: false,
      error: 'URL non valido',
      diag: { url: baseUrl, diag: { httpStatus: 0, ok: false, rawPreview: '' } }
    };
  }
  const diag = await fetchJsonWithDiagnostics(url);
  logDiag(kind, url, diag);
  if (!diag.ok) {
    return { ok: false, error: `HTTP ${diag.httpStatus}`, diag: { url, diag } };
  }
  return { ok: true, data: diag.json, diag: { url, diag } };
};

export const fetchAppsScriptPing = async (settings: AppSettings): Promise<AppsScriptResult<Record<string, unknown>>> => {
  const result = await fetchAppsScript(settings, 'ping');
  if (!result.ok) return result;
  if (result.data && typeof result.data === 'object') {
    return { ok: true, data: result.data as Record<string, unknown>, diag: result.diag };
  }
  return { ok: false, error: 'Risposta non valida', diag: result.diag };
};

export const fetchAssetsMap = async (settings: AppSettings): Promise<AppsScriptResult<AppsScriptAssetRow[]>> => {
  const result = await fetchAppsScript(settings, 'assetsMap', { sheet: 'ASSET_MAP', range: 'A1:Z999' });
  if (!result.ok) return result;
  const rows = extractRows(result.data);
  if (!rows) return { ok: false, error: 'Risposta non valida', diag: result.diag };
  const normalized = rowsFromMatrix(rows);
  const parsed = normalized.map(parseAssetRow).filter((row): row is AppsScriptAssetRow => Boolean(row));
  return { ok: true, data: parsed, diag: result.diag };
};

export const fetchMacro = async (settings: AppSettings): Promise<AppsScriptResult<AppsScriptMacroRow[]>> => {
  const result = await fetchAppsScript(settings, 'macro');
  if (!result.ok) return result;
  const rows = extractRows(result.data);
  if (!rows) return { ok: false, error: 'Risposta non valida', diag: result.diag };
  const normalized = rowsFromMatrix(rows);
  const parsed = normalized.map(parseMacroRow).filter((row): row is AppsScriptMacroRow => Boolean(row));
  return { ok: true, data: parsed, diag: result.diag };
};

export const fetchFx = async (settings: AppSettings): Promise<AppsScriptResult<AppsScriptFxRow[]>> => {
  const result = await fetchAppsScript(settings, 'fx', { sheet: 'FX', range: 'A1:Z999' });
  if (!result.ok) return result;

  const rows = extractRows(result.data);
  if (!rows) return { ok: false, error: 'Risposta non valida', diag: result.diag };

  const normalized = rowsFromMatrix(rows);
  const parsed = normalized.map(parseFxRow).filter((row): row is AppsScriptFxRow => Boolean(row));

  return { ok: true, data: parsed, diag: result.diag };
};

export const applyAssetsMapToSettings = (
  settings: AppSettings,
  rows: AppsScriptAssetRow[]
): { settings: AppSettings; changed: boolean } => {
  const current = settings.priceTickerConfig || {};
  let changed = false;
  const next: Record<string, PriceTickerConfig> = { ...current };
  rows.forEach(row => {
    const ticker = row.ticker;
    if (!ticker) return;
    const existing = next[ticker] || {};
    const updated: PriceTickerConfig = { ...existing };
    const hasSheetSymbol = Boolean(existing.sheetSymbol && existing.sheetSymbol.trim());
    const hasProvider = Boolean(existing.provider);
    const hasExclude = existing.exclude !== undefined;
    const hasNeedsMapping = existing.needsMapping !== undefined;

    if (row.sheetSymbol && !hasSheetSymbol) {
      updated.sheetSymbol = row.sheetSymbol;
    }
    if (row.exclude !== undefined && !hasExclude) {
      updated.exclude = row.exclude;
    }
    if (row.needsMapping !== undefined && !hasNeedsMapping) {
      updated.needsMapping = row.needsMapping;
    }
    if (row.provider && !hasProvider) {
      updated.provider = row.provider;
    } else if (!hasProvider && row.sheetSymbol && !row.provider) {
      updated.provider = 'SHEETS';
    }
    const hasChanges = JSON.stringify(existing) !== JSON.stringify(updated);
    if (hasChanges) {
      changed = true;
      next[ticker] = updated;
    }
  });
  return changed ? { settings: { ...settings, priceTickerConfig: next }, changed: true } : { settings, changed: false };
};

export const buildAssetsMapIndex = (rows: AppsScriptAssetRow[]): Map<string, AppsScriptAssetRow> => {
  const map = new Map<string, AppsScriptAssetRow>();
  rows.forEach(row => {
    if (row.ticker) map.set(row.ticker, row);
  });
  return map;
};

export const getPriceFromAssetsMap = (
  rows: Map<string, AppsScriptAssetRow>,
  ticker: string
): { close: number; date: string; currency?: Currency } | null => {
  const row = rows.get(ticker);
  if (!row || row.close === undefined) return null;
  const date = row.date || new Date().toISOString().split('T')[0];
  return { close: row.close, date, currency: row.currency };
};

export const applyMacroRowsToDexie = async (
  rows: AppsScriptMacroRow[],
  portfolioId: string,
  db: { macro: { where: Function; bulkPut: Function; toArray: Function } }
): Promise<number> => {
  if (!rows.length) return 0;
  const existing = await db.macro.where('portfolioId').equals(portfolioId).toArray();
  const existingMap = new Map<string, number>();
  existing.forEach((row: MacroIndicator) => {
    const key = `${row.date}|${row.note || ''}`;
    if (row.id) existingMap.set(key, row.id);
  });
  const today = new Date().toISOString().split('T')[0];
  const toSave: MacroIndicator[] = rows.map(row => {
    const date = row.date || today;
    const key = `${date}|${row.id}`;
    const id = existingMap.get(key);
    const inputs: Record<string, number> = {};
    if (row.min !== undefined) inputs.min = row.min;
    if (row.max !== undefined) inputs.max = row.max;
    return {
      id,
      portfolioId,
      date,
      value: row.value,
      note: row.id,
      inputs: Object.keys(inputs).length ? inputs : undefined
    };
  });
  await db.macro.bulkPut(toSave);
  return toSave.length;
};

export const applyFxRowsToDexie = async (
  rows: AppsScriptFxRow[],
  db: { fxRates: { bulkPut: Function } },
  source = 'apps-script'
): Promise<number> => {
  if (!rows.length) return 0;
  const today = new Date().toISOString().split('T')[0];

  const toSave = rows.map(r => ({
    baseCurrency: r.baseCurrency,
    quoteCurrency: r.quoteCurrency,
    date: r.date || today,
    rate: r.rate,
    source
  }));

  await db.fxRates.bulkPut(toSave);
  return toSave.length;
};

export type SyncFxResult = {
  ok: boolean;
  count?: number;
  rows?: AppsScriptFxRow[];
  error?: string;
  diag?: AppsScriptDiagnostics;
};

export const syncFxRates = async (
  settings: AppSettings,
  source = 'apps_script'
): Promise<SyncFxResult> => {
  try {
    const result = await fetchFx(settings);
    if (!result.ok) {
      return { ok: false, error: result.error, diag: result.diag };
    }
    const rows = result.data || [];
    const count = await applyFxRowsToDexie(rows, db, source);
    return { ok: true, count, rows, diag: result.diag };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Errore sync FX' };
  }
};
