import { db, getCurrentPortfolioId } from '../db';
import { AppSettings, AssetType, Currency, Instrument, PricePoint, PriceProviderType, PriceTickerConfig, TransactionType } from '../types';
import { format, subDays, addDays } from 'date-fns';
import Dexie from 'dexie';
import { isValidEodhdSymbol, resolveEodhdSymbol } from './symbolUtils';
import { fetchJsonWithDiagnostics, FetchJsonDiagnostics, toNum } from './diagnostics';
import { applyAssetsMapToSettings, buildAssetsMapIndex, fetchAssetsMap, getPriceFromAssetsMap, AppsScriptAssetRow } from './appsScriptService';
import { addDaysYmd, diffDaysYmd, subDaysYmd } from './dateUtils';
import { COVERAGE_TOLERANCE_DAYS } from './constants';
import { checkProxyHealth, ProxyHealth } from './apiHealthService';
import { getHiddenTickersForPortfolio } from './portfolioVisibility';

const EODHD_PROXY_ENDPOINT = '/api/eodhd-proxy';
const EODHD_DIRECT_BASE = 'https://eodhd.com';
const PROXY_ERROR_MESSAGE = 'Impossibile raggiungere proxy API';
const PROXY_HELP_MESSAGE = 'Proxy /api non raggiungibile. Avvia `npm run dev:vercel` oppure verifica il deploy del proxy /api.';
const EODHD_MISSING_KEY_MESSAGE = 'Chiave EODHD mancante. Inseriscila in Settings o in `.env.local`.';
const DEFAULT_PROVIDER: PriceProviderType = 'EODHD';
const EODHD_SYNC_DELAY_MS = 250;
const EODHD_BACKFILL_MAX_DAYS = 90;
const EODHD_MAX_REQUESTS_PER_SESSION = 20;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let eodhdRequestsUsed = 0;
let eodhdQueue: Promise<void> = Promise.resolve();
let eodhdProxyAvailable: boolean | null = null;

const isProxyMissingResponse = (diag: FetchJsonDiagnostics): boolean => {
  if (diag.httpStatus !== 404) return false;
  const ct = (diag.contentType || '').toLowerCase();
  if (ct.includes('text/html')) return true;
  const preview = (diag.rawPreview || '').trim().toLowerCase();
  return preview.startsWith('<!doctype html') || preview.startsWith('<html') || preview.includes('cannot get') || preview.includes('not found');
};

const applyProxyHealth = (health?: ProxyHealth | null) => {
  if (!health) return;
  if (health.ok) {
    eodhdProxyAvailable = true;
  } else if (health.mode === 'direct-local-key') {
    eodhdProxyAvailable = false;
  }
};

export const resolveProxyFailure = (health?: ProxyHealth | null): { status: 'proxy_unreachable'; message: string } | null => {
  if (!health || !health.tested) return null;
  if (!health.ok && health.mode !== 'direct-local-key') {
    return { status: 'proxy_unreachable', message: health.message || PROXY_HELP_MESSAGE };
  }
  return null;
};

const enqueueEodhdRequest = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (eodhdRequestsUsed >= EODHD_MAX_REQUESTS_PER_SESSION) {
    throw new Error('EODHD_LIMIT_REACHED');
  }
  eodhdRequestsUsed += 1;
  const task = eodhdQueue.then(async () => {
    const result = await fn();
    await sleep(EODHD_SYNC_DELAY_MS);
    return result;
  });
  eodhdQueue = task.then(() => undefined, () => undefined);
  return task;
};

const buildEodhdHeaders = (apiKey?: string) => {
  const trimmed = apiKey?.trim();
  return trimmed ? { 'x-eodhd-key': trimmed } : undefined;
};

const buildEodhdProxyUrl = (path: string, params: Record<string, string>) => {
  const search = new URLSearchParams({ path });
  Object.entries(params).forEach(([key, value]) => {
    if (value) search.append(key, value);
  });
  return `${EODHD_PROXY_ENDPOINT}?${search.toString()}`;
};

const buildEodhdDirectUrl = (path: string, params: Record<string, string>, apiKey?: string) => {
  const url = new URL(`${EODHD_DIRECT_BASE}${path}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value) url.searchParams.append(key, value);
  });
  if (apiKey) url.searchParams.set('api_token', apiKey);
  return url.toString();
};

class EodhdError extends Error {
  httpStatus: number;
  contentType?: string;
  rawPreview?: string;

  constructor(message: string, diag: FetchJsonDiagnostics) {
    super(message);
    this.name = 'EodhdError';
    this.httpStatus = diag.httpStatus;
    this.contentType = diag.contentType;
    this.rawPreview = diag.rawPreview;
  }
}

const isEodhdError = (value: unknown): value is EodhdError => {
  return value instanceof EodhdError;
};

type EodhdFetchMode = 'proxy' | 'direct';

type EodhdFetchResult = {
  diag: FetchJsonDiagnostics;
  url: string;
  mode: EodhdFetchMode;
  proxyMissing?: boolean;
};

const fetchEodhdJson = async (
  path: string,
  params: Record<string, string>,
  apiKey?: string,
  options?: { signal?: AbortSignal; useQueue?: boolean }
): Promise<EodhdFetchResult> => {
  const trimmedKey = apiKey?.trim() || '';
  const run = async (): Promise<EodhdFetchResult> => {
    if (eodhdProxyAvailable !== false) {
      const proxyUrl = buildEodhdProxyUrl(path, params);
      const headers = buildEodhdHeaders(trimmedKey);
      const diag = await fetchJsonWithDiagnostics(proxyUrl, headers ? { headers, signal: options?.signal } : { signal: options?.signal });
      if (!diag.ok && isProxyMissingResponse(diag)) {
        eodhdProxyAvailable = false;
        if (trimmedKey) {
          const directUrl = buildEodhdDirectUrl(path, params, trimmedKey);
          const directDiag = await fetchJsonWithDiagnostics(directUrl, { signal: options?.signal });
          return { diag: directDiag, url: directUrl, mode: 'direct', proxyMissing: true };
        }
        return { diag, url: proxyUrl, mode: 'proxy', proxyMissing: true };
      }
      if (diag.ok) eodhdProxyAvailable = true;
      return { diag, url: proxyUrl, mode: 'proxy' };
    }
    const directUrl = buildEodhdDirectUrl(path, params, trimmedKey);
    const diag = await fetchJsonWithDiagnostics(directUrl, { signal: options?.signal });
    return { diag, url: directUrl, mode: 'direct' };
  };

  if (options?.useQueue === false) return run();
  return enqueueEodhdRequest(run);
};

export type EodhdQuotaInfo = {
  dailyRateLimit?: number;
  apiRequests?: number;
  requestsPerMinute?: number;
  requestsPerDay?: number;
  remaining?: number;
};

export const getEodhdQuotaInfo = async (
  settings: AppSettings
): Promise<{ ok: true; info: EodhdQuotaInfo; diag: FetchJsonDiagnostics } | { ok: false; error: string; diag: FetchJsonDiagnostics }> => {
  const result = await fetchEodhdJson('/api/user', { fmt: 'json' }, settings.eodhdApiKey, { useQueue: false });
  const diag = result.diag;
  if (!diag.ok && result.proxyMissing) {
    return { ok: false, error: PROXY_ERROR_MESSAGE, diag };
  }
  if (diag.httpStatus === 402) {
    return { ok: false, error: 'Quota esaurita / piano non sufficiente', diag };
  }
  if (!diag.ok) {
    return { ok: false, error: `HTTP ${diag.httpStatus}`, diag };
  }
  if (!diag.json || Array.isArray(diag.json) || typeof diag.json !== 'object') {
    return { ok: false, error: 'Risposta non valida', diag };
  }
  const obj = diag.json as Record<string, unknown>;
  const dailyRateLimit = toNum(obj.dailyRateLimit ?? obj.daily_rate_limit ?? obj.rateLimit ?? obj.rate_limit);
  const apiRequests = toNum(obj.apiRequests ?? obj.api_requests ?? obj.requests ?? obj.api_usage);
  const requestsPerMinute = toNum(obj.requestsPerMinute ?? obj.requests_per_minute);
  const requestsPerDay = toNum(obj.requestsPerDay ?? obj.requests_per_day);
  const remaining = dailyRateLimit !== null && apiRequests !== null ? dailyRateLimit - apiRequests : null;
  const info: EodhdQuotaInfo = {};
  if (dailyRateLimit !== null) info.dailyRateLimit = dailyRateLimit;
  if (apiRequests !== null) info.apiRequests = apiRequests;
  if (requestsPerMinute !== null) info.requestsPerMinute = requestsPerMinute;
  if (requestsPerDay !== null) info.requestsPerDay = requestsPerDay;
  if (remaining !== null) info.remaining = remaining;
  if (Object.keys(info).length === 0) {
    return { ok: false, error: 'Risposta non valida', diag };
  }
  return { ok: true, info, diag };
};

interface PriceProvider {
  getLatestPrice(ticker: string): Promise<Partial<PricePoint> | null>;
  getHistory(ticker: string, from: string, to: string): Promise<PricePoint[]>;
}

export interface CoverageRow {
  ticker: string;
  isin?: string | null;
  name?: string | null;
  instrumentId?: string;
  from: string;
  to: string;
  status: 'OK' | 'INCOMPLETO' | 'PARZIALE';
}

export type SyncPricesSummary = {
  status: 'ok' | 'partial' | 'error' | 'quota_exhausted' | 'proxy_unreachable';
  updatedTickers: string[];
  failedTickers: { ticker: string; reason: string }[];
  sheet: { enabled: boolean; reason?: string };
  message?: string;
  quota?: { ticker: string; httpStatus: number; contentType?: string; rawPreview?: string };
};

export type BackfillMode = 'MANUAL_FULL' | 'AUTO_GAPS';

export type BackfillOptions = {
  mode?: BackfillMode;
  maxApiCallsPerRun?: number;
  maxLookbackDays?: number;
  staleThresholdDays?: number;
  sleepMs?: number;
  portfolioScope?: 'current' | 'allPortfolios';
  maxDailyCalls?: number;
};

const resolveInstrumentForTicker = (instruments: Instrument[], ticker: string): Instrument | undefined => {
  return instruments.find(i => i.preferredListing?.symbol === ticker)
    || instruments.find(i => i.symbol === ticker)
    || instruments.find(i => i.ticker === ticker)
    || instruments.find(i => i.listings?.some(l => l.symbol === ticker));
};

const getCanonicalTickerFromInstrument = (instrument: Instrument): string => {
  return instrument.preferredListing?.symbol || instrument.symbol || instrument.ticker;
};

const filterHiddenTickers = (tickers: string[], portfolioId: string): string[] => {
  const hidden = new Set(getHiddenTickersForPortfolio(portfolioId));
  if (hidden.size === 0) return tickers;
  return tickers.filter(t => !hidden.has(t));
};

export const getTickerConfig = (settings: AppSettings | null | undefined, ticker: string): PriceTickerConfig => {
  return settings?.priceTickerConfig?.[ticker] || {};
};

export const resolvePriceSyncConfig = (
  ticker: string,
  settings?: AppSettings | null
): { provider: PriceProviderType; eodhdSymbol: string; sheetSymbol: string; excluded: boolean; needsMapping: boolean } => {
  const cfg = getTickerConfig(settings, ticker);
  const provider = (cfg.provider || DEFAULT_PROVIDER) as PriceProviderType;
  const eodhdSymbol = cfg.eodhdSymbol?.trim() || ticker;
  const sheetSymbol = cfg.sheetSymbol?.trim() || ticker;
  const needsMapping = Boolean(cfg.needsMapping);
  const excluded = Boolean(cfg.exclude) || needsMapping;
  return { provider, eodhdSymbol, sheetSymbol, excluded, needsMapping };
};

export const getResolvedSymbol = (
  ticker: string,
  settings: AppSettings | null | undefined,
  provider: PriceProviderType,
  assetType?: AssetType
): string | null => {
  const cfg = getTickerConfig(settings, ticker);
  if (cfg.exclude || cfg.needsMapping) return null;
  if (provider === 'MANUAL') return null;
  if (provider === 'SHEETS') {
    const symbol = cfg.sheetSymbol?.trim();
    return symbol ? symbol : null;
  }
  const raw = cfg.eodhdSymbol?.trim() || ticker;
  if (!raw) return null;
  const resolved = resolveEodhdSymbol(raw, assetType);
  return isValidEodhdSymbol(resolved, assetType) ? resolved : null;
};

export const resolveCoverageStartDate = (minHistoryDate: string, firstTransactionDate?: string): string => {
  if (!firstTransactionDate) return minHistoryDate;
  return firstTransactionDate > minHistoryDate ? firstTransactionDate : minHistoryDate;
};

export const resolveSyncStartDate = (
  earliestDateNeeded: string,
  minPriceDate?: string,
  maxPriceDate?: string
): string => {
  if (minPriceDate && minPriceDate > earliestDateNeeded) return earliestDateNeeded;
  if (maxPriceDate) return addDaysYmd(maxPriceDate, 1);
  return earliestDateNeeded;
};

export const buildPointsForSave = (
  points: PricePoint[],
  params: { ticker: string; instrumentId?: string; currency?: Currency; portfolioId: string }
): PricePoint[] => {
  return points.map(p => ({
    ...p,
    ticker: params.ticker,
    instrumentId: params.instrumentId,
    currency: (params.currency || p.currency) as any,
    portfolioId: params.portfolioId
  }));
};

export const resolveBackfillSymbol = (
  ticker: string,
  cfg: PriceTickerConfig,
  assetType?: AssetType
): string => {
  const raw = cfg.eodhdSymbol?.trim() || ticker;
  return resolveEodhdSymbol(raw, assetType);
};

export const isAutoGapCandidate = (
  lastDate: string | undefined,
  today: string,
  staleThresholdDays: number
): boolean => {
  if (!lastDate) return true;
  const cutoff = subDaysYmd(today, staleThresholdDays);
  return lastDate <= cutoff;
};

export const computeAutoGapRange = (
  lastDate: string | undefined,
  today: string,
  maxLookbackDays: number
): { from: string; to: string } => {
  const minFrom = subDaysYmd(today, maxLookbackDays);
  if (!lastDate) return { from: minFrom, to: today };
  const nextDay = addDaysYmd(lastDate, 1);
  return { from: nextDay < minFrom ? minFrom : nextDay, to: today };
};

export const limitTickersByBudget = (
  tickers: string[],
  maxApiCallsPerRun?: number,
  maxDailyCalls?: number,
  dailyUsed = 0
): { tickers: string[]; stoppedByBudget: boolean } => {
  const runLimit = maxApiCallsPerRun !== undefined ? Math.max(0, maxApiCallsPerRun) : tickers.length;
  const dailyLimit = maxDailyCalls !== undefined ? Math.max(0, maxDailyCalls - dailyUsed) : tickers.length;
  const cap = Math.min(runLimit, dailyLimit);
  return { tickers: tickers.slice(0, cap), stoppedByBudget: tickers.length > cap };
};

export const buildCoverageRows = (
  tickers: string[],
  ranges: Record<string, { firstDate?: string; lastDate?: string }>,
  instruments: Instrument[],
  startTargetDate: string,
  today: string
): CoverageRow[] => {
  return tickers.map((rawTicker) => {
    const ticker = rawTicker && rawTicker.trim() ? rawTicker : '--';
    const range = ranges[rawTicker] || {};
    const from = range.firstDate || 'N/D';
    const to = range.lastDate || 'N/D';
    const okStart = range.firstDate
      ? diffDaysYmd(range.firstDate, startTargetDate) <= COVERAGE_TOLERANCE_DAYS
      : false;
    const okEnd = range.lastDate
      ? diffDaysYmd(today, range.lastDate) <= COVERAGE_TOLERANCE_DAYS
      : false;
    const status: CoverageRow['status'] = okStart && okEnd ? 'OK' : okStart || okEnd ? 'PARZIALE' : 'INCOMPLETO';
    const instrument = rawTicker ? resolveInstrumentForTicker(instruments, rawTicker) : undefined;

    return {
      ticker,
      isin: instrument?.isin ?? null,
      name: instrument?.name ?? null,
      instrumentId: instrument?.id ? String(instrument.id) : undefined,
      from,
      to,
      status
    };
  });
};

// 1. EODHD Provider
class EodhdPriceProvider implements PriceProvider {
  private apiKey?: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey?.trim() || undefined;
  }

  async getLatestPrice(ticker: string): Promise<Partial<PricePoint> | null> {
    try {
      // For real implementation, use EODHD real-time or EOD endpoint
      const result = await fetchEodhdJson(`/api/real-time/${encodeURIComponent(ticker)}`, { fmt: 'json' }, this.apiKey);
      const diag = result.diag;
      if (!diag.ok && result.proxyMissing) {
        throw new Error(PROXY_ERROR_MESSAGE);
      }
      if (!diag.ok) {
        if (diag.httpStatus === 402) throw new EodhdError('quota_exhausted', diag);
        if (diag.httpStatus >= 500) throw new Error(PROXY_ERROR_MESSAGE);
        throw new EodhdError(`EODHD ${diag.httpStatus}`, diag);
      }
      if (!diag.json || typeof diag.json !== 'object') {
        throw new EodhdError('invalid_payload', diag);
      }
      const data = diag.json as Record<string, unknown>;
      const rawClose = data?.adjusted_close ?? data?.close;
      const close = toNum(rawClose);
      if (close === null) {
        throw new Error('EODHD close non numerico');
      }
      return {
        close,
        date: format(new Date(), 'yyyy-MM-dd')
      };
    } catch (e: any) {
      if (e?.message === PROXY_ERROR_MESSAGE) throw e;
      if (e?.message === 'EODHD_LIMIT_REACHED') throw e;
      if (e instanceof TypeError) throw new Error(PROXY_ERROR_MESSAGE);
      console.error('EODHD Latest Error', e);
      return null;
    }
  }

  async getHistory(ticker: string, from: string, to: string): Promise<PricePoint[]> {
    try {
      const result = await fetchEodhdJson(`/api/eod/${encodeURIComponent(ticker)}`, { from, to, fmt: 'json' }, this.apiKey);
      const diag = result.diag;
      const url = result.url;
      if (!diag.ok && result.proxyMissing) {
        throw new Error(PROXY_ERROR_MESSAGE);
      }
      if (!diag.ok) {
        if (diag.httpStatus === 402) throw new EodhdError('quota_exhausted', diag);
        if (diag.httpStatus === 404) {
          console.warn('[EODHD] 404', { ticker, symbol: ticker, url });
        }
        if (diag.httpStatus >= 500) throw new Error(PROXY_ERROR_MESSAGE);
        throw new EodhdError(`EODHD ${diag.httpStatus}`, diag);
      }
      if (!Array.isArray(diag.json)) {
        if (import.meta.env?.DEV) {
          console.warn('[EODHD] invalid_payload', {
            ticker,
            symbol: ticker,
            url,
            httpStatus: diag.httpStatus,
            contentType: diag.contentType,
            rawPreview: diag.rawPreview
          });
        }
        throw new EodhdError(`invalid_payload http=${diag.httpStatus} ct=${diag.contentType || 'n/a'}`, diag);
      }

      return mapEodhdHistoryRows(ticker, diag.json);
    } catch (e: any) {
      if (e?.message === PROXY_ERROR_MESSAGE) throw e;
      if (e?.message === 'EODHD_LIMIT_REACHED') throw e;
      if (e instanceof TypeError) throw new Error(PROXY_ERROR_MESSAGE);
      if (String(e?.message || '').includes('invalid_payload')) throw e;
      console.error('EODHD History Error', e);
      return [];
    }
  }
}

export const fetchLatestEodhdPrice = async (ticker: string, apiKey?: string): Promise<Partial<PricePoint> | null> => {
  const provider = new EodhdPriceProvider(apiKey);
  return provider.getLatestPrice(ticker);
};

export const mapEodhdHistoryRows = (ticker: string, data: unknown[]): PricePoint[] => {
  return data
    .map((row: any) => {
      const date = String(row?.date || '');
      const closeRaw = row?.adjusted_close ?? row?.close;
      const close = toNum(closeRaw);
      if (!date || close === null) return null;
      return {
        ticker,
        date,
        close,
        currency: undefined as any // Currency resolved from listing/instrument in caller.
      } as PricePoint;
    })
    .filter((row): row is PricePoint => Boolean(row));
};

// 2. Google Sheet Provider
type SheetRow = { ticker: string; close: number; currency?: Currency; date?: string };
type SheetFetchResult = { rows: SheetRow[]; disabledReason?: string };

class GoogleSheetsPriceProvider implements PriceProvider {
  private sheetUrl: string;
  private cached?: SheetFetchResult;

  constructor(sheetUrl: string) {
    this.sheetUrl = sheetUrl;
  }

  private parseJsonRows(raw: any): SheetRow[] | null {
    if (Array.isArray(raw)) {
      return raw
        .map((row: any) => ({
          ticker: String(row.ticker || row.Ticker || '').trim(),
          close: Number(row.close ?? row.Close),
          currency: (row.currency || row.Currency) as Currency | undefined,
          date: row.date || row.Date
        }))
        .filter(r => r.ticker && Number.isFinite(r.close));
    }
    return null;
  }

  private parseGvizRows(text: string): SheetRow[] | null {
    if (!text.includes('google.visualization.Query.setResponse')) return null;
    const jsonText = text.substring(47).slice(0, -2);
    const json = JSON.parse(jsonText);
    if (!json?.table?.rows) return null;
    return json.table.rows.map((r: any) => ({
      ticker: r.c[0]?.v,
      close: r.c[1]?.v,
      currency: r.c[2]?.v as Currency | undefined,
      date: r.c[3]?.v
    })).filter((r: any) => r.ticker && Number.isFinite(r.close));
  }

  private splitCsvLine(line: string): string[] {
    const out: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }
      if (ch === ',' && !inQuotes) {
        out.push(cur);
        cur = '';
        continue;
      }
      cur += ch;
    }
    out.push(cur);
    return out.map(s => s.trim());
  }

  private parseCsvRows(text: string): SheetRow[] | null {
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return null;
    const headers = this.splitCsvLine(lines[0]).map(h => h.toLowerCase());
    const tickerIdx = headers.indexOf('ticker');
    const closeIdx = headers.indexOf('close');
    if (tickerIdx === -1 || closeIdx === -1) return null;
    const currencyIdx = headers.indexOf('currency');
    const dateIdx = headers.indexOf('date');
    const rows = lines.slice(1).map(line => {
      const cols = this.splitCsvLine(line);
      return {
        ticker: String(cols[tickerIdx] || '').trim(),
        close: Number(cols[closeIdx]),
        currency: (currencyIdx >= 0 ? cols[currencyIdx] : undefined) as Currency | undefined,
        date: dateIdx >= 0 ? cols[dateIdx] : undefined
      } as SheetRow;
    }).filter(r => r.ticker && Number.isFinite(r.close));
    return rows.length ? rows : null;
  }

  async getSheetRows(): Promise<SheetFetchResult> {
    if (this.cached) return this.cached;
    const rawUrl = this.sheetUrl?.trim() || '';
    if (!rawUrl) {
      this.cached = { rows: [], disabledReason: 'Sheet URL non configurato' };
      return this.cached;
    }
    let parsed: URL | null = null;
    try {
      parsed = new URL(rawUrl);
    } catch {
      this.cached = { rows: [], disabledReason: 'Sheet URL non valido' };
      return this.cached;
    }

    const urlLooksGviz = parsed.pathname.includes('/gviz') || parsed.searchParams.has('gviz');
    const urlLooksExport = parsed.searchParams.has('output') || parsed.searchParams.has('format');
    const isSheetShare = parsed.hostname.includes('google.com')
      && parsed.pathname.includes('/spreadsheets/')
      && parsed.pathname.includes('/edit');
    if (!urlLooksGviz && !urlLooksExport) {
      this.cached = {
        rows: [],
        disabledReason: isSheetShare
          ? 'Sheet URL non e un endpoint export (usa /export?format=csv o /gviz/tq)'
          : 'Sheet URL non e un endpoint export'
      };
      return this.cached;
    }

    try {
      const res = await fetch(`/api/sheets?url=${encodeURIComponent(rawUrl)}`);
      if (!res.ok) {
        const msg = await res.text();
        if (res.status >= 500) throw new Error(PROXY_ERROR_MESSAGE);
        console.warn('Sheet fetch error', msg);
        this.cached = { rows: [], disabledReason: 'Sheet non disponibile' };
        return this.cached;
      }
      const text = await res.text();
      const trimmed = text.trim();
      if (!trimmed || trimmed.startsWith('<')) {
        this.cached = { rows: [], disabledReason: 'Sheet ha risposto con HTML' };
        return this.cached;
      }
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        const parsedJson = JSON.parse(trimmed);
        const rows = this.parseJsonRows(parsedJson);
        if (rows) {
          this.cached = { rows };
          return this.cached;
        }
      }
      const csvRows = this.parseCsvRows(trimmed);
      if (csvRows) {
        this.cached = { rows: csvRows };
        return this.cached;
      }
      const gvizRows = this.parseGvizRows(trimmed);
      if (gvizRows) {
        this.cached = { rows: gvizRows };
        return this.cached;
      }
      this.cached = { rows: [], disabledReason: 'Sheet non e in formato supportato' };
      return this.cached;
    } catch (e: any) {
      if (e?.message === PROXY_ERROR_MESSAGE) throw e;
      if (e instanceof TypeError) throw new Error(PROXY_ERROR_MESSAGE);
      console.warn('Sheet fetch error', e);
      this.cached = { rows: [], disabledReason: 'Sheet non disponibile' };
      return this.cached;
    }
  }

  async getLatestPrice(ticker: string): Promise<Partial<PricePoint> | null> {
    const result = await this.getSheetRows();
    const row = result.rows.find(r => r.ticker === ticker);
    if (!row) return null;
    return {
      close: row.close,
      date: row.date || format(new Date(), 'yyyy-MM-dd'),
      currency: row.currency
    };
  }

  async getHistory(_ticker: string, _from: string, _to: string): Promise<PricePoint[]> {
    // Sheet is assumed to only have latest prices based on prompt description
    return [];
  }
}

// 3. Orchestrator
export const syncPrices = async (
  apiKeyOverride?: string,
  options?: { portfolioId?: string; mode?: 'FULL' | 'LATEST' }
): Promise<SyncPricesSummary> => {
  const summary: SyncPricesSummary = {
    status: 'ok',
    updatedTickers: [],
    failedTickers: [],
    sheet: { enabled: true }
  };
  const portfolioId = options?.portfolioId || getCurrentPortfolioId();
  const mode = options?.mode || 'FULL';
  const latestOnly = mode === 'LATEST';
  const persistSyncMeta = (status?: string) => {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(`prices:lastSyncAt:${portfolioId}`, new Date().toISOString());
      localStorage.setItem(`prices:lastSyncStatus:${portfolioId}`, status || 'ok');
    } catch {
      // ignore localStorage failures
    }
  };
  let settings = await db.settings.where('portfolioId').equals(portfolioId).first();
  if (!settings) {
    summary.status = 'error';
    summary.failedTickers.push({ ticker: '*', reason: 'Impostazioni mancanti' });
    summary.sheet = { enabled: false, reason: 'Impostazioni mancanti' };
    persistSyncMeta(summary.status);
    return summary;
  }

  const instruments = await db.instruments.where('portfolioId').equals(portfolioId).toArray();
  const eodhdKey = apiKeyOverride?.trim() || settings.eodhdApiKey;
  const eodhd = new EodhdPriceProvider(eodhdKey);
  const sheet = new GoogleSheetsPriceProvider(settings.googleSheetUrl);
  const appsScriptEnabled = Boolean(settings.appsScriptUrl?.trim() && settings.appsScriptApiKey?.trim());
  let appsScriptIndex = new Map<string, AppsScriptAssetRow>();
  let appsScriptError: string | null = null;

  if (appsScriptEnabled) {
    try {
      const assetsResult = await fetchAssetsMap(settings);
      if (assetsResult.ok) {
        appsScriptIndex = buildAssetsMapIndex(assetsResult.data);
        const updated = applyAssetsMapToSettings(settings, assetsResult.data);
        if (updated.changed) {
          await db.settings.put({ ...updated.settings, id: settings.id, portfolioId });
          settings = updated.settings;
        }
      } else {
        appsScriptError = assetsResult.error;
      }
    } catch (e: any) {
      appsScriptError = e?.message || 'Apps Script non disponibile';
    }
  }
  let sheetResult: SheetFetchResult = { rows: [] };
  try {
    sheetResult = await sheet.getSheetRows();
    if (sheetResult.disabledReason) {
      summary.sheet = { enabled: false, reason: sheetResult.disabledReason };
    }
  } catch (e: any) {
    summary.sheet = { enabled: false, reason: e?.message || 'Sheet non disponibile' };
  }

  const today = format(new Date(), 'yyyy-MM-dd');
  const eodhdLimitFrom = format(subDays(new Date(), EODHD_BACKFILL_MAX_DAYS), 'yyyy-MM-dd');
  const allTx = await db.transactions.where('portfolioId').equals(portfolioId).sortBy('date');
  const earliestDateNeeded = allTx.length > 0
    ? format(subDays(allTx[0].date, 7), 'yyyy-MM-dd')
    : format(subDays(new Date(), 365), 'yyyy-MM-dd');
  const failedSet = new Set<string>();

  const needsEodhd = !latestOnly && instruments.some(instr => {
    if (instr.type === 'Cash') return false;
    const ticker = getCanonicalTickerFromInstrument(instr);
    if (!ticker) return false;
    const cfg = resolvePriceSyncConfig(ticker, settings);
    if (cfg.excluded || cfg.provider === 'MANUAL' || cfg.needsMapping) return false;
    return cfg.provider === 'EODHD';
  });

  let proxyHealth: ProxyHealth | null = null;
  if (needsEodhd) {
    proxyHealth = await checkProxyHealth({ eodhdApiKey: eodhdKey });
    applyProxyHealth(proxyHealth);
    if (import.meta.env?.DEV) {
      console.log('[SYNC][Prices]', {
        phase: 'proxy-check',
        ok: proxyHealth.ok,
        mode: proxyHealth.mode,
        usingLocalKey: proxyHealth.usingLocalKey,
        hasEodhdKey: proxyHealth.hasEodhdKey
      });
    }
    const proxyFailure = resolveProxyFailure(proxyHealth);
    if (proxyFailure) {
      summary.status = proxyFailure.status;
      summary.message = proxyFailure.message;
      persistSyncMeta(summary.status);
      return summary;
    }
    if (!proxyHealth.hasEodhdKey && !proxyHealth.usingLocalKey) {
      summary.status = 'error';
      summary.message = EODHD_MISSING_KEY_MESSAGE;
      persistSyncMeta(summary.status);
      return summary;
    }
  }

  for (const instr of instruments) {
    if (instr.type === 'Cash') continue;
    const priceTicker = getCanonicalTickerFromInstrument(instr);
    const priceCurrency = instr.preferredListing?.currency || instr.currency;
    const tickerConfig = resolvePriceSyncConfig(priceTicker, settings);
    if (latestOnly && tickerConfig.provider !== 'SHEETS') continue;
    if (tickerConfig.excluded || tickerConfig.provider === 'MANUAL' || tickerConfig.needsMapping) continue;
    const resolvedSymbol = tickerConfig.provider === 'EODHD'
      ? getResolvedSymbol(priceTicker, settings, 'EODHD', instr.type)
      : null;
    if (import.meta.env?.DEV) {
      const lookupKey = tickerConfig.provider === 'SHEETS'
        ? (tickerConfig.sheetSymbol || priceTicker)
        : (resolvedSymbol || tickerConfig.eodhdSymbol || priceTicker);
      console.log('[SYNC][Prices]', {
        ticker: priceTicker,
        provider: tickerConfig.provider,
        lookupKey,
        mode: proxyHealth?.mode || 'unknown'
      });
    }
    if (tickerConfig.provider === 'EODHD' && !resolvedSymbol) {
      if (!failedSet.has(priceTicker)) {
        summary.failedTickers.push({ ticker: priceTicker, reason: 'Symbol EODHD non valido' });
        failedSet.add(priceTicker);
      }
      continue;
    }

    const existing = instr.id
      ? await db.prices
        .where('[instrumentId+date]')
        .between([String(instr.id), Dexie.minKey], [String(instr.id), Dexie.maxKey])
        .and(p => p.portfolioId === portfolioId)
        .sortBy('date')
      : await db.prices
        .where('[ticker+date]')
        .between([priceTicker, Dexie.minKey], [priceTicker, Dexie.maxKey])
        .and(p => p.portfolioId === portfolioId)
        .sortBy('date');

    const minPriceDate = existing[0]?.date;
    const maxPriceDate = existing[existing.length - 1]?.date;

    const startDate = resolveSyncStartDate(earliestDateNeeded, minPriceDate, maxPriceDate);

    if (tickerConfig.provider === 'EODHD' && startDate >= today) continue;

    let newPoints: PricePoint[] = [];
    let eodhdError = '';
    let sheetError = '';
    let didEodhdRequest = false;

    if (tickerConfig.provider === 'EODHD') {
      try {
        didEodhdRequest = true;
        if (!resolvedSymbol) throw new Error('Symbol EODHD non valido');
        const effectiveStart = startDate < eodhdLimitFrom ? eodhdLimitFrom : startDate;
        if (effectiveStart !== today) {
          newPoints = await eodhd.getHistory(resolvedSymbol, effectiveStart, today);
        }
      } catch (e: any) {
        if (e?.message === 'EODHD_LIMIT_REACHED') {
          summary.status = summary.updatedTickers.length > 0 ? 'partial' : 'error';
          summary.message = 'Limite EODHD sessione raggiunto (20 richieste).';
          break;
        }
        if (isEodhdError(e) && e.httpStatus === 402) {
          summary.status = 'quota_exhausted';
          summary.message = 'Quota EODHD esaurita (402). Sync interrotta.';
          summary.quota = {
            ticker: priceTicker,
            httpStatus: e.httpStatus,
            contentType: e.contentType,
            rawPreview: e.rawPreview
          };
          break;
        }
        eodhdError = e?.message || 'Errore EODHD';
        if (eodhdError === PROXY_ERROR_MESSAGE) {
          summary.status = 'proxy_unreachable';
          summary.message = proxyHealth?.message || PROXY_HELP_MESSAGE;
          break;
        }
        if (String(eodhdError).includes('404')) {
          const url = buildEodhdProxyUrl(`/api/eod/${encodeURIComponent(tickerConfig.eodhdSymbol)}`, { from: startDate, to: today, fmt: 'json' });
          console.warn('[EODHD] 404', { ticker: priceTicker, symbol: resolvedSymbol, url });
        }
        if (!failedSet.has(priceTicker)) {
          summary.failedTickers.push({ ticker: priceTicker, reason: eodhdError || 'Errore EODHD' });
          failedSet.add(priceTicker);
        }
      }
    }

    if (newPoints.length === 0) {
      if (tickerConfig.provider === 'SHEETS') {
        if (appsScriptEnabled && appsScriptIndex.size > 0) {
          const mapped = getPriceFromAssetsMap(appsScriptIndex, priceTicker);
          if (mapped) {
            newPoints.push({
              ticker: priceTicker,
              date: mapped.date || today,
              close: mapped.close,
              currency: priceCurrency || mapped.currency
            });
          } else {
            const row = appsScriptIndex.get(priceTicker);
            sheetError = row ? 'Apps Script: prezzo non valido' : 'Apps Script: ticker non trovato';
          }
        } else if (appsScriptEnabled) {
          sheetError = appsScriptError ? `Apps Script: ${appsScriptError}` : 'Apps Script: nessun dato';
        } else {
          sheetError = 'Apps Script non configurato';
        }

        if (newPoints.length === 0 && summary.sheet.enabled) {
          const latest = await sheet.getLatestPrice(tickerConfig.sheetSymbol);
          if (latest && latest.close) {
            newPoints.push({
              ticker: priceTicker,
              date: latest.date || today,
              close: latest.close,
              currency: priceCurrency || (latest.currency as any)
            });
            sheetError = '';
          }
        }
      } else if (!eodhdError && summary.sheet.enabled) {
        const latest = await sheet.getLatestPrice(tickerConfig.sheetSymbol);
        if (latest && latest.close) {
          newPoints.push({
            ticker: priceTicker,
            date: latest.date || today,
            close: latest.close,
            currency: priceCurrency || (latest.currency as any)
          });
        }
      }
    }

    if (newPoints.length > 0) {
      const pointsToSave = buildPointsForSave(newPoints, {
        ticker: priceTicker,
        instrumentId: String(instr.id),
        currency: priceCurrency,
        portfolioId
      });
      await db.prices.bulkPut(pointsToSave);
      summary.updatedTickers.push(priceTicker);
    } else if (!failedSet.has(priceTicker)) {
      if (tickerConfig.provider === 'SHEETS') {
        if (sheetError) {
          summary.failedTickers.push({ ticker: priceTicker, reason: sheetError });
        } else if (!summary.sheet.enabled) {
          summary.failedTickers.push({ ticker: priceTicker, reason: `Sheets: ${summary.sheet.reason || 'non disponibile'}` });
        } else {
          summary.failedTickers.push({ ticker: priceTicker, reason: 'Sheets: prezzo non trovato' });
        }
      } else {
        const reason = eodhdError || 'Nessun dato disponibile';
        summary.failedTickers.push({ ticker: priceTicker, reason });
      }
      failedSet.add(priceTicker);
    }
    if (didEodhdRequest) {
      await sleep(EODHD_SYNC_DELAY_MS);
    }
  }

  if (summary.status === 'quota_exhausted' || summary.status === 'proxy_unreachable') {
    persistSyncMeta(summary.status);
    return summary;
  }
  if (summary.failedTickers.length > 0) {
    summary.status = summary.updatedTickers.length > 0 ? 'partial' : 'error';
  }
  persistSyncMeta(summary.status);
  return summary;
};

// Helpers per backfill
export const getTickersForBackfill = async (
  portfolioId: string,
  scope: 'current' | 'all',
  options?: { includeHidden?: boolean }
): Promise<string[]> => {
  const tx = await db.transactions.where('portfolioId').equals(portfolioId).toArray();
  const instruments = await db.instruments.where('portfolioId').equals(portfolioId).toArray();
  const canonicalByTicker = new Map<string, string>();
  const instrumentById = new Map<string, Instrument>();
  instruments.forEach(inst => {
    const canonical = getCanonicalTickerFromInstrument(inst);
    if (inst.ticker) canonicalByTicker.set(inst.ticker, canonical);
    if (inst.symbol) canonicalByTicker.set(inst.symbol, canonical);
    instrumentById.set(String(inst.id), inst);
  });
  const mapCanonical = (ticker: string) => canonicalByTicker.get(ticker) || ticker;
  const resolveTxTicker = (t: { instrumentId?: string; instrumentTicker?: string }) => {
    if (t.instrumentId) {
      const inst = instrumentById.get(String(t.instrumentId));
      if (inst) return getCanonicalTickerFromInstrument(inst);
    }
    if (t.instrumentTicker) return mapCanonical(t.instrumentTicker);
    return null;
  };
  if (scope === 'all') {
    const all = Array.from(new Set(tx.map(t => resolveTxTicker(t)).filter(Boolean))) as string[];
    const list = Array.from(new Set(all.map(mapCanonical)));
    return options?.includeHidden ? list : filterHiddenTickers(list, portfolioId);
  }

  const qtyMap = new Map<string, number>();
  tx.forEach(t => {
    const key = resolveTxTicker(t);
    if (!key) return;
    const cur = qtyMap.get(key) || 0;
    if (t.type === TransactionType.Buy) qtyMap.set(key, cur + (t.quantity || 0));
    if (t.type === TransactionType.Sell) qtyMap.set(key, cur - (t.quantity || 0));
  });
  const current = Array.from(qtyMap.entries())
    .filter(([, qty]) => qty > 1e-8)
    .map(([ticker]) => ticker);
  if (current.length === 0) {
    const all = Array.from(new Set(tx.map(t => resolveTxTicker(t)).filter(Boolean))) as string[];
    const list = Array.from(new Set(all.map(mapCanonical)));
    return options?.includeHidden ? list : filterHiddenTickers(list, portfolioId);
  }
  const list = Array.from(new Set(current.map(mapCanonical)));
  return options?.includeHidden ? list : filterHiddenTickers(list, portfolioId);
};

export const getPriceCoverage = async (portfolioId: string, tickers: string[], minHistoryDate: string) => {
  const instruments = await db.instruments.where('portfolioId').equals(portfolioId).toArray();
  const ranges: Record<string, { firstDate?: string; lastDate?: string }> = {};
  let earliestCoveredDate: string | undefined;
  let latestCoveredDate: string | undefined;
  const txSorted = await db.transactions.where('portfolioId').equals(portfolioId).sortBy('date');
  const firstTransactionDate = txSorted[0]?.date ? format(txSorted[0].date, 'yyyy-MM-dd') : undefined;
  const startTargetDate = resolveCoverageStartDate(minHistoryDate, firstTransactionDate);

  for (const t of tickers) {
    if (!t) {
      ranges[t] = {};
      continue;
    }
    const rows = await db.prices
      .where('[ticker+date]')
      .between([t, Dexie.minKey], [t, Dexie.maxKey])
      .and(p => p.portfolioId === portfolioId)
      .sortBy('date');
    const first = rows[0]?.date;
    const last = rows[rows.length - 1]?.date;
    ranges[t] = { firstDate: first, lastDate: last };
    if (first && last) {
      earliestCoveredDate = earliestCoveredDate ? (first > earliestCoveredDate ? first : earliestCoveredDate) : first;
      latestCoveredDate = latestCoveredDate ? (last < latestCoveredDate ? last : latestCoveredDate) : last;
    }
  }

  const today = format(new Date(), 'yyyy-MM-dd');
  const perTicker = buildCoverageRows(tickers, ranges, instruments, startTargetDate, today);
  const okCount = perTicker.filter(p => p.status === 'OK').length;
  return { earliestCoveredDate, latestCoveredDate, perTicker, okCount };
};

const getBudgetKey = (dateStr: string) => `eodhd_budget_${dateStr}`;

const readDailyBudget = (dateStr: string): { used: number } => {
  if (typeof localStorage === 'undefined') return { used: 0 };
  const raw = localStorage.getItem(getBudgetKey(dateStr));
  if (!raw) return { used: 0 };
  try {
    const parsed = JSON.parse(raw) as { used?: number };
    return { used: Number(parsed.used || 0) };
  } catch {
    return { used: 0 };
  }
};

const writeDailyBudget = (dateStr: string, used: number) => {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(getBudgetKey(dateStr), JSON.stringify({ used }));
};

const bumpDailyBudget = (dateStr: string, delta = 1): number => {
  const current = readDailyBudget(dateStr);
  const next = Math.max(0, current.used + delta);
  writeDailyBudget(dateStr, next);
  return next;
};

export const getEodhdDailyBudgetStatus = (dateStr?: string) => {
  const day = dateStr || format(new Date(), 'yyyy-MM-dd');
  const { used } = readDailyBudget(day);
  return { key: getBudgetKey(day), used };
};

export const backfillPricesForPortfolio = async (
  portfolioId: string,
  tickers: string[],
  minHistoryDate: string,
  onProgress?: (info: { ticker: string; index: number; total: number; phase: 'backfill' | 'forward' | 'done'; error?: string }) => void,
  apiKeyOverride?: string,
  options?: BackfillOptions
): Promise<BackfillSummary> => {
  const summary: BackfillSummary = { status: 'ok', updatedTickers: [], skipped: 0, stoppedByBudget: false, mode: options?.mode || 'MANUAL_FULL' };
  const persistBackfillAt = () => {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(`prices:lastBackfillAt:${portfolioId}`, new Date().toISOString());
    } catch {
      // ignore localStorage failures
    }
  };
  let settings = await db.settings.where('portfolioId').equals(portfolioId).first();
  if (!settings) {
    const msg = 'Impostazioni mancanti';
    if (onProgress) onProgress({ ticker: '', index: 0, total: tickers.length, phase: 'done', error: msg });
    return { status: 'error', message: msg };
  }

  const mode: BackfillMode = options?.mode || 'MANUAL_FULL';
  const maxApiCallsPerRun = options?.maxApiCallsPerRun ?? (mode === 'AUTO_GAPS' ? 10 : 20);
  const maxLookbackDays = options?.maxLookbackDays ?? (mode === 'AUTO_GAPS' ? 30 : 365);
  const staleThresholdDays = options?.staleThresholdDays ?? 7;
  const sleepMs = options?.sleepMs ?? 400;
  const maxDailyCalls = options?.maxDailyCalls;

  const eodhdKey = apiKeyOverride?.trim() || settings.eodhdApiKey?.trim();
  const eodhd = new EodhdPriceProvider(eodhdKey);
  const today = format(new Date(), 'yyyy-MM-dd');
  const minAllowedFrom = subDaysYmd(today, maxLookbackDays);
  const instruments = await db.instruments.where('portfolioId').equals(portfolioId).toArray();
  const priceCurrencyByTicker = new Map<string, Currency>();
  const instrumentIdByTicker = new Map<string, string>();
  const instrumentTypeByTicker = new Map<string, AssetType>();
  instruments.forEach(inst => {
    const ticker = getCanonicalTickerFromInstrument(inst);
    if (!ticker) return;
    priceCurrencyByTicker.set(ticker, inst.preferredListing?.currency || inst.currency);
    instrumentTypeByTicker.set(ticker, inst.type);
    if (inst.id) instrumentIdByTicker.set(ticker, String(inst.id));
  });
  const filtered = tickers.filter(t => {
    const cfg = resolvePriceSyncConfig(t, settings);
    return !cfg.excluded && cfg.provider !== 'MANUAL';
  });

  let proxyHealth: ProxyHealth | null = null;
  if (filtered.length > 0) {
    proxyHealth = await checkProxyHealth({ eodhdApiKey: eodhdKey });
    applyProxyHealth(proxyHealth);
    if (import.meta.env?.DEV) {
      console.log('[SYNC][Prices]', {
        phase: 'proxy-check',
        ok: proxyHealth.ok,
        mode: proxyHealth.mode,
        usingLocalKey: proxyHealth.usingLocalKey,
        hasEodhdKey: proxyHealth.hasEodhdKey
      });
    }
    const proxyFailure = resolveProxyFailure(proxyHealth);
    if (proxyFailure) {
      return {
        status: proxyFailure.status,
        message: proxyFailure.message,
        updatedTickers: [],
        skipped: tickers.length,
        stoppedByBudget: false,
        mode
      };
    }
    if (!proxyHealth.hasEodhdKey && !proxyHealth.usingLocalKey) {
      return {
        status: 'error',
        message: EODHD_MISSING_KEY_MESSAGE,
        updatedTickers: [],
        skipped: tickers.length,
        stoppedByBudget: false,
        mode
      };
    }
  }
  let usedThisRun = 0;
  let dailyUsed = readDailyBudget(today).used;

  if (mode === 'AUTO_GAPS') {
    type AutoGapCandidate = {
      ticker: string;
      lastDate?: string;
      range: { from: string; to: string };
      reason: 'internal-gap' | 'tail-stale';
      sortDate?: string;
    };
    const candidates: AutoGapCandidate[] = [];
    for (const ticker of filtered) {
      const existing = await db.prices
        .where('[ticker+date]')
        .between([ticker, minAllowedFrom], [ticker, today])
        .and(p => p.portfolioId === portfolioId)
        .sortBy('date');
      const lastDate = existing[existing.length - 1]?.date;

      let chosenRange: { from: string; to: string; gapDays: number } | null = null;
      if (existing.length > 1) {
        for (let idx = 0; idx < existing.length - 1; idx++) {
          const curr = existing[idx]?.date;
          const next = existing[idx + 1]?.date;
          if (!curr || !next) continue;
          const gapDays = diffDaysYmd(next, curr) - 1;
          if (gapDays < staleThresholdDays) continue;
          const fromCandidate = addDaysYmd(curr, 1);
          const toCandidate = subDaysYmd(next, 1);
          const from = fromCandidate < minAllowedFrom ? minAllowedFrom : fromCandidate;
          const to = toCandidate > today ? today : toCandidate;
          if (from > to) continue;
          if (!chosenRange || to > chosenRange.to) {
            chosenRange = { from, to, gapDays };
          }
        }
      }

      if (chosenRange) {
        candidates.push({
          ticker,
          lastDate,
          range: { from: chosenRange.from, to: chosenRange.to },
          reason: 'internal-gap',
          sortDate: chosenRange.to
        });
        continue;
      }

      if (isAutoGapCandidate(lastDate, today, staleThresholdDays)) {
        const range = computeAutoGapRange(lastDate, today, maxLookbackDays);
        if (range.from > range.to) {
          summary.skipped = (summary.skipped || 0) + 1;
          if (import.meta.env?.DEV) {
            console.log('[PRICE][Backfill]', { ticker, reason: 'skip-empty-range', from: range.from, to: range.to });
          }
          continue;
        }
        candidates.push({
          ticker,
          lastDate,
          range,
          reason: 'tail-stale',
          sortDate: lastDate
        });
      } else {
        summary.skipped = (summary.skipped || 0) + 1;
        if (import.meta.env?.DEV) {
          console.log('[PRICE][Backfill]', { ticker, reason: 'skip-up-to-date', lastDate });
        }
      }
    }

    candidates.sort((a, b) => {
      if (!a.sortDate && !b.sortDate) return 0;
      if (!a.sortDate) return -1;
      if (!b.sortDate) return 1;
      return a.sortDate.localeCompare(b.sortDate);
    });

    const budgetLimit = limitTickersByBudget(candidates.map(c => c.ticker), maxApiCallsPerRun, maxDailyCalls, dailyUsed);
    const limitedSet = new Set(budgetLimit.tickers);
    summary.stoppedByBudget = budgetLimit.stoppedByBudget;

    const limitedCandidates = candidates.filter(c => limitedSet.has(c.ticker));
    for (let i = 0; i < limitedCandidates.length; i++) {
      const { ticker, range, reason } = limitedCandidates[i];
      const cfg = resolvePriceSyncConfig(ticker, settings);
      const assetType = instrumentTypeByTicker.get(ticker);
      const symbol = resolveBackfillSymbol(ticker, cfg, assetType);
      const priceCurrency = priceCurrencyByTicker.get(ticker);
      const instrumentId = instrumentIdByTicker.get(ticker);
      if (!isValidEodhdSymbol(symbol, assetType)) {
        const message = 'Symbol EODHD non valido';
        if (onProgress) onProgress({ ticker, index: i + 1, total: limitedCandidates.length, phase: 'backfill', error: message });
        summary.status = 'error';
        summary.message = message;
        continue;
      }

      if (onProgress) onProgress({ ticker, index: i + 1, total: limitedCandidates.length, phase: 'backfill' });
      if (import.meta.env?.DEV) {
        console.log('[PRICE][Backfill]', { ticker, reason, from: range.from, to: range.to });
      }
      if (maxApiCallsPerRun !== undefined && usedThisRun >= maxApiCallsPerRun) {
        summary.stoppedByBudget = true;
        break;
      }
      if (maxDailyCalls !== undefined && dailyUsed >= maxDailyCalls) {
        summary.stoppedByBudget = true;
        break;
      }
      usedThisRun += 1;
      dailyUsed = bumpDailyBudget(today, 1);
      try {
        const pts = await eodhd.getHistory(symbol, range.from, range.to);
        if (pts.length > 0) {
          const toSaveRaw = buildPointsForSave(pts, {
            ticker,
            instrumentId,
            currency: priceCurrency,
            portfolioId
          });
          const deduped = new Map<string, PricePoint>();
          toSaveRaw.forEach(point => {
            deduped.set(`${point.ticker}|${point.date}|${point.portfolioId}`, point);
          });
          const toSave = Array.from(deduped.values());
          if (toSave.length > 0) {
            await db.prices.bulkPut(toSave);
            summary.updatedTickers?.push(ticker);
            if (reason === 'internal-gap' && !summary.message) {
              summary.message = `Backfill prezzi: riempito gap ${ticker} ${range.from} -> ${range.to}`;
            }
          } else {
            summary.skipped = (summary.skipped || 0) + 1;
          }
        } else {
          summary.skipped = (summary.skipped || 0) + 1;
        }
      } catch (e: any) {
        if (e?.message === 'EODHD_LIMIT_REACHED') {
          summary.status = 'error';
          summary.message = 'Limite EODHD sessione raggiunto (20 richieste).';
          break;
        }
        if (isEodhdError(e) && e.httpStatus === 402) {
          summary.status = 'quota_exhausted';
          summary.message = 'Quota EODHD esaurita (402). Backfill interrotto.';
          summary.quota = {
            ticker,
            httpStatus: e.httpStatus,
            contentType: e.contentType,
            rawPreview: e.rawPreview
          };
          break;
        }
        const message = e?.message || String(e);
        if (onProgress) onProgress({ ticker, index: i + 1, total: limitedCandidates.length, phase: 'backfill', error: message });
        if (message === PROXY_ERROR_MESSAGE) {
          summary.status = 'proxy_unreachable';
          summary.message = proxyHealth?.message || PROXY_HELP_MESSAGE;
          break;
        }
        summary.status = 'error';
        summary.message = message;
      }
      await new Promise(res => setTimeout(res, sleepMs));
    }

    if (onProgress) onProgress({ ticker: '', index: limitedCandidates.length, total: limitedCandidates.length, phase: 'done' });
    return summary;
  }

  for (let i = 0; i < filtered.length; i++) {
    const ticker = filtered[i];
    const cfg = resolvePriceSyncConfig(ticker, settings);
    const assetType = instrumentTypeByTicker.get(ticker);
    const resolvedSymbol = resolveBackfillSymbol(ticker, cfg, assetType);
    const priceCurrency = priceCurrencyByTicker.get(ticker);
    const instrumentId = instrumentIdByTicker.get(ticker);
    try {
      if (onProgress) onProgress({ ticker, index: i + 1, total: filtered.length, phase: 'backfill' });
      const existing = await db.prices
        .where('[ticker+date]')
        .between([ticker, Dexie.minKey], [ticker, Dexie.maxKey])
        .and(p => p.portfolioId === portfolioId)
        .sortBy('date');

      const minInDb = existing[0]?.date;
      const maxInDb = existing[existing.length - 1]?.date;

      const ranges: { from: string; to: string }[] = [];
      if (!minInDb || minInDb > minHistoryDate) {
        const from = minHistoryDate < minAllowedFrom ? minAllowedFrom : minHistoryDate;
        ranges.push({ from, to: minInDb ? subDaysYmd(minInDb, 1) : today });
      }
      if (!maxInDb || maxInDb < today) {
        const fromCandidate = maxInDb ? addDaysYmd(maxInDb, 1) : minHistoryDate;
        const from = fromCandidate < minAllowedFrom ? minAllowedFrom : fromCandidate;
        ranges.push({ from, to: today });
      }

      const limitedRanges = ranges.filter(r => r.from <= r.to);

      let stopForBudget = false;
      for (const r of limitedRanges) {
        if (maxApiCallsPerRun !== undefined && usedThisRun >= maxApiCallsPerRun) {
          summary.stoppedByBudget = true;
          stopForBudget = true;
          break;
        }
        if (maxDailyCalls !== undefined && dailyUsed >= maxDailyCalls) {
          summary.stoppedByBudget = true;
          stopForBudget = true;
          break;
        }
        if (onProgress) onProgress({ ticker, index: i + 1, total: filtered.length, phase: 'forward' });
        if (!isValidEodhdSymbol(resolvedSymbol, assetType)) throw new Error('Symbol EODHD non valido');
        usedThisRun += 1;
        dailyUsed = bumpDailyBudget(today, 1);
        const pts = await eodhd.getHistory(resolvedSymbol, r.from, r.to);
        if (pts.length > 0) {
          const toSave = buildPointsForSave(pts, {
            ticker,
            instrumentId,
            currency: priceCurrency,
            portfolioId
          });
          await db.prices.bulkPut(toSave);
          if (!summary.updatedTickers?.includes(ticker)) summary.updatedTickers?.push(ticker);
        }
        await new Promise(res => setTimeout(res, sleepMs));
      }
      if (stopForBudget) break;
    } catch (e: any) {
      if (e?.message === 'EODHD_LIMIT_REACHED') {
        summary.status = 'error';
        summary.message = 'Limite EODHD sessione raggiunto (20 richieste).';
        break;
      }
      if (isEodhdError(e) && e.httpStatus === 402) {
        summary.status = 'quota_exhausted';
        summary.message = 'Quota EODHD esaurita (402). Backfill interrotto.';
        summary.quota = {
          ticker,
          httpStatus: e.httpStatus,
          contentType: e.contentType,
          rawPreview: e.rawPreview
        };
        break;
      }
      const message = e?.message || String(e);
      if (onProgress) onProgress({ ticker, index: i + 1, total: filtered.length, phase: 'backfill', error: message });
      if (message === PROXY_ERROR_MESSAGE) {
        summary.status = 'proxy_unreachable';
        summary.message = proxyHealth?.message || PROXY_HELP_MESSAGE;
        break;
      }
      summary.status = 'error';
      summary.message = message;
    }
  }
  if (onProgress) onProgress({ ticker: '', index: filtered.length, total: filtered.length, phase: 'done' });
  persistBackfillAt();
  return summary;
};

export type SheetTestResult = {
  status: 'ok' | 'not_found' | 'disabled' | 'error';
  reason?: string;
  price?: Partial<PricePoint>;
};

export type BackfillSummary = {
  status: 'ok' | 'error' | 'quota_exhausted' | 'proxy_unreachable';
  message?: string;
  quota?: { ticker: string; httpStatus: number; contentType?: string; rawPreview?: string };
  updatedTickers?: string[];
  skipped?: number;
  stoppedByBudget?: boolean;
  mode?: BackfillMode;
};

export const testSheetLatestPrice = async (sheetUrl: string, ticker: string): Promise<SheetTestResult> => {
  const provider = new GoogleSheetsPriceProvider(sheetUrl);
  const rows = await provider.getSheetRows();
  if (rows.disabledReason) {
    return { status: 'disabled', reason: rows.disabledReason };
  }
  const latest = await provider.getLatestPrice(ticker);
  if (!latest) {
    return { status: 'not_found' };
  }
  return { status: 'ok', price: latest };
};




export type MarketCloseResult = {
  close: number;
  date: string;
  currency?: Currency;
  source: 'cache' | 'eodhd';
};

export type MarketCloseAroundResult = {
  status: 'exact' | 'fallback' | 'not_found' | 'no_data' | 'error' | 'invalid_payload' | 'aborted';
  dateUsed?: string;
  close?: number;
  currency?: Currency;
  source?: 'cache' | 'eodhd';
  rawCount?: number;
  message?: string;
};

export const getMarketCloseAroundDate = async (
  portfolioId: string,
  ticker: string,
  targetDate: string,
  lookbackDays = 10,
  options?: { signal?: AbortSignal; forceEodhd?: boolean }
): Promise<MarketCloseAroundResult> => {
  if (!ticker || !targetDate) return { status: 'error', message: 'invalid-input' };
  const dateObj = new Date(targetDate);
  if (Number.isNaN(dateObj.getTime())) return { status: 'error', message: 'invalid-date' };

  const settings = await db.settings.where('portfolioId').equals(portfolioId).first();
  if (!settings) return { status: 'error', message: 'missing-settings' };

  const instrument = await db.instruments
    .where('portfolioId')
    .equals(portfolioId)
    .toArray()
    .then(list => list.find(i => i.symbol === ticker || i.ticker === ticker || i.preferredListing?.symbol === ticker || i.listings?.some(l => l.symbol === ticker)));

  const cfg = resolvePriceSyncConfig(ticker, settings);

  const target = format(dateObj, 'yyyy-MM-dd');
  const clampedLookback = Math.min(lookbackDays, EODHD_BACKFILL_MAX_DAYS);
  const from = format(subDays(dateObj, Math.max(1, clampedLookback)), 'yyyy-MM-dd');

  if (!options?.forceEodhd) {
    const exact = instrument?.id
      ? await db.prices
        .where('[instrumentId+date]')
        .equals([String(instrument.id), target])
        .and(p => p.portfolioId === portfolioId)
        .first()
      : await db.prices
        .where('[ticker+date]')
        .equals([ticker, target])
        .and(p => p.portfolioId === portfolioId)
        .first();
    if (exact && Number.isFinite(exact.close)) {
      return { status: 'exact', dateUsed: exact.date, close: exact.close, currency: exact.currency, source: 'cache' };
    }

    const cachedRange = instrument?.id
      ? await db.prices
        .where('[instrumentId+date]')
        .between([String(instrument.id), from], [String(instrument.id), target], true, true)
        .and(p => p.portfolioId === portfolioId)
        .toArray()
      : await db.prices
        .where('[ticker+date]')
        .between([ticker, from], [ticker, target], true, true)
        .and(p => p.portfolioId === portfolioId)
        .toArray();
    if (cachedRange.length > 0) {
      const best = cachedRange.reduce((acc, row) => (!acc || row.date > acc.date) ? row : acc, null as PricePoint | null);
      if (best && Number.isFinite(best.close)) {
        return { status: 'fallback', dateUsed: best.date, close: best.close, currency: best.currency, source: 'cache' };
      }
    }
  }

  if (cfg.needsMapping) return { status: 'not_found', message: 'needs-mapping' };
  const allowEodhd = cfg.provider === 'EODHD' || options?.forceEodhd;
  if (!allowEodhd) return { status: 'not_found', message: 'provider_not_eodhd' };

  const symbol = getResolvedSymbol(ticker, settings, 'EODHD', instrument?.type);
  if (!symbol) return { status: 'not_found', message: 'missing-symbol' };

  try {
    const result = await fetchEodhdJson(
      `/api/eod/${encodeURIComponent(symbol)}`,
      { from, to: target, fmt: 'json' },
      settings.eodhdApiKey,
      { signal: options?.signal }
    );
    const diag = result.diag;
    const url = result.url;
    if (!diag.ok && result.proxyMissing) {
      return { status: 'error', message: PROXY_ERROR_MESSAGE };
    }
    if (diag.httpStatus === 404) return { status: 'not_found', rawCount: 0 };
    if (!diag.ok) {
      let message = `status_${diag.httpStatus}`;
      if (diag.json && typeof diag.json === 'object' && 'error' in (diag.json as Record<string, unknown>)) {
        message = String((diag.json as Record<string, unknown>).error);
      }
      return { status: 'error', rawCount: 0, message };
    }
    if (!Array.isArray(diag.json)) {
      if (import.meta.env?.DEV) {
        console.warn('[EODHD] invalid_payload', {
          ticker,
          symbol,
          url,
          httpStatus: diag.httpStatus,
          contentType: diag.contentType,
          rawPreview: diag.rawPreview
        });
      }
      return { status: 'invalid_payload', message: 'invalid_payload' };
    }
    const data = diag.json;
    const rawCount = data.length;
    if (rawCount === 0) return { status: 'no_data', rawCount };

    let best: { date: string; close: number } | null = null;
    for (const row of data) {
      const rowDate = String((row as any).date || '');
      const closeRaw = (row as any).adjusted_close ?? (row as any).close;
      const close = toNum(closeRaw);
      if (!rowDate || close === null) continue;
      if (rowDate <= target) {
        if (!best || rowDate > best.date) best = { date: rowDate, close };
      }
    }
    if (!best) return { status: 'no_data', rawCount };

    const currency = instrument?.preferredListing?.currency || instrument?.currency;
    const pointsToSave = data
      .map((row: unknown) => {
        const obj = row as Record<string, unknown>;
        const rowDate = typeof obj?.date === 'string' ? obj.date : String(obj?.date || '');
        const closeRaw = obj?.adjusted_close ?? obj?.close;
        const close = toNum(closeRaw);
        if (!rowDate || close === null) return null;
        return {
          ticker,
          instrumentId: instrument?.id ? String(instrument.id) : undefined,
          date: rowDate,
          close,
          currency: currency || (undefined as any),
          portfolioId
        } as PricePoint;
      })
      .filter((row): row is PricePoint => Boolean(row));
    if (pointsToSave.length > 0) {
      await db.prices.bulkPut(pointsToSave);
    }
    const status: MarketCloseAroundResult['status'] = best.date === target ? 'exact' : 'fallback';
    return { status, dateUsed: best.date, close: best.close, currency, source: 'eodhd', rawCount };
  } catch (err: any) {
    if (err && err.name === 'AbortError') {
      return { status: 'aborted', message: 'aborted' };
    }
    if (err?.message === 'EODHD_LIMIT_REACHED') {
      return { status: 'error', message: 'Limite EODHD sessione raggiunto (20 richieste).' };
    }
    return { status: 'error', message: PROXY_ERROR_MESSAGE };
  }
};

export const getMarketCloseForDate = async (
  portfolioId: string,
  ticker: string,
  dateYYYYMMDD: string
): Promise<MarketCloseResult | null> => {
  if (!ticker || !dateYYYYMMDD) return null;
  const dateObj = new Date(dateYYYYMMDD);
  if (Number.isNaN(dateObj.getTime())) return null;

  const settings = await db.settings.where('portfolioId').equals(portfolioId).first();
  if (!settings) return null;

  const instrument = await db.instruments
    .where('portfolioId')
    .equals(portfolioId)
    .toArray()
    .then(list => list.find(i => i.symbol === ticker || i.ticker === ticker || i.preferredListing?.symbol === ticker || i.listings?.some(l => l.symbol === ticker)));

  const cfg = resolvePriceSyncConfig(ticker, settings);
  if (cfg.needsMapping || cfg.provider !== 'EODHD') return null;

  const cached = instrument?.id
    ? await db.prices
      .where('[instrumentId+date]')
      .equals([String(instrument.id), dateYYYYMMDD])
      .and(p => p.portfolioId === portfolioId)
      .first()
    : await db.prices
      .where('[ticker+date]')
      .equals([ticker, dateYYYYMMDD])
      .and(p => p.portfolioId === portfolioId)
      .first();
  if (cached && Number.isFinite(cached.close)) {
    return { close: cached.close, date: cached.date, currency: cached.currency, source: 'cache' };
  }

  const symbol = getResolvedSymbol(ticker, settings, cfg.provider, instrument?.type);
  if (!symbol) return null;

  const from = format(subDays(dateObj, 7), 'yyyy-MM-dd');
  const to = format(addDays(dateObj, 1), 'yyyy-MM-dd');
  try {
    const result = await fetchEodhdJson(
      `/api/eod/${encodeURIComponent(symbol)}`,
      { from, to, fmt: 'json' },
      settings.eodhdApiKey
    );
    const diag = result.diag;
    if (!diag.ok) return null;
    if (!Array.isArray(diag.json)) return null;
    const data = diag.json;

      let best: { date: string; close: number } | null = null;
      let next: { date: string; close: number } | null = null;
      for (const row of data) {
        const rowDate = String((row as any).date || '');
        const closeRaw = (row as any).adjusted_close ?? (row as any).close;
        const close = toNum(closeRaw);
        if (!rowDate || close === null) continue;
        if (rowDate <= dateYYYYMMDD) {
          if (!best || rowDate > best.date) best = { date: rowDate, close };
        } else if (!next || rowDate < next.date) {
          next = { date: rowDate, close };
      }
    }
    const chosen = best || next;
    if (!chosen) return null;

    const currency = instrument?.preferredListing?.currency || instrument?.currency;
    return { close: chosen.close, date: chosen.date, currency, source: 'eodhd' };
  } catch {
    return null;
  }
};



