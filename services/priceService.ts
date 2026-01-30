import { db, getCurrentPortfolioId } from '../db';
import { AppSettings, AssetType, Currency, Instrument, PricePoint, PriceProviderType, PriceTickerConfig, TransactionType } from '../types';
import { format, subDays, addDays, differenceInCalendarDays } from 'date-fns';
import Dexie from 'dexie';
import { isValidEodhdSymbol, resolveEodhdSymbol } from './symbolUtils';

const EODHD_PROXY_ENDPOINT = '/api/eodhd-proxy';
const PROXY_ERROR_MESSAGE = 'Impossibile raggiungere proxy API';
const DEFAULT_PROVIDER: PriceProviderType = 'EODHD';
const EODHD_SYNC_DELAY_MS = 250;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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

export const toNum = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let normalized = trimmed.replace(/\s+/g, '');
  if (normalized.includes(',') && !normalized.includes('.')) {
    normalized = normalized.replace(',', '.');
  } else {
    normalized = normalized.replace(/,/g, '');
  }
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

export type FetchJsonDiagnostics = {
  httpStatus: number;
  ok: boolean;
  contentType?: string;
  rawPreview: string;
  parseError?: string;
  json?: unknown;
};

export const fetchJsonWithDiagnostics = async (
  url: string,
  options?: RequestInit
): Promise<FetchJsonDiagnostics> => {
  const res = await fetch(url, options);
  const raw = await res.text();
  const rawPreview = raw.slice(0, 500);
  let json: unknown = undefined;
  let parseError: string | undefined;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }
  return {
    httpStatus: res.status,
    ok: res.ok,
    contentType: res.headers.get('content-type') || undefined,
    rawPreview,
    parseError,
    json
  };
};

interface PriceProvider {
  getLatestPrice(ticker: string): Promise<Partial<PricePoint> | null>;
  getHistory(ticker: string, from: string, to: string): Promise<PricePoint[]>;
}

export interface CoverageRow {
  ticker: string;
  isin?: string | null;
  name?: string | null;
  instrumentId?: string | number;
  from: string;
  to: string;
  status: 'OK' | 'INCOMPLETO' | 'PARZIALE';
}

export type SyncPricesSummary = {
  status: 'ok' | 'partial' | 'failed';
  updatedTickers: string[];
  failedTickers: { ticker: string; reason: string }[];
  sheet: { enabled: boolean; reason?: string };
};

const resolveInstrumentForTicker = (instruments: Instrument[], ticker: string): Instrument | undefined => {
  return instruments.find(i => i.preferredListing?.symbol === ticker)
    || instruments.find(i => i.ticker === ticker)
    || instruments.find(i => i.listings?.some(l => l.symbol === ticker));
};

const getCanonicalTickerFromInstrument = (instrument: Instrument): string => {
  return instrument.preferredListing?.symbol || instrument.ticker;
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

export const buildCoverageRows = (
  tickers: string[],
  ranges: Record<string, { firstDate?: string; lastDate?: string }>,
  instruments: Instrument[],
  minHistoryDate: string,
  today: string
): CoverageRow[] => {
  return tickers.map((rawTicker) => {
    const ticker = rawTicker && rawTicker.trim() ? rawTicker : '--';
    const range = ranges[rawTicker] || {};
    const from = range.firstDate || 'N/D';
    const to = range.lastDate || 'N/D';
    const okStart = range.firstDate
      ? differenceInCalendarDays(new Date(range.firstDate), new Date(minHistoryDate)) <= 7
      : false;
    const okEnd = range.lastDate
      ? differenceInCalendarDays(new Date(today), new Date(range.lastDate)) <= 7
      : false;
    const status: CoverageRow['status'] = okStart && okEnd ? 'OK' : okStart || okEnd ? 'PARZIALE' : 'INCOMPLETO';
    const instrument = rawTicker ? resolveInstrumentForTicker(instruments, rawTicker) : undefined;

    return {
      ticker,
      isin: instrument?.isin ?? null,
      name: instrument?.name ?? null,
      instrumentId: instrument?.id,
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
      const headers = buildEodhdHeaders(this.apiKey);
      const url = buildEodhdProxyUrl(`/api/real-time/${encodeURIComponent(ticker)}`, { fmt: 'json' });
      const diag = await fetchJsonWithDiagnostics(url, headers ? { headers } : undefined);
      if (!diag.ok) {
        if (diag.httpStatus >= 500) throw new Error(PROXY_ERROR_MESSAGE);
        throw new Error(`EODHD ${diag.httpStatus}`);
      }
      if (!diag.json || typeof diag.json !== 'object') {
        throw new Error('invalid_payload');
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
      if (e instanceof TypeError) throw new Error(PROXY_ERROR_MESSAGE);
      console.error('EODHD Latest Error', e);
      return null;
    }
  }

  async getHistory(ticker: string, from: string, to: string): Promise<PricePoint[]> {
    try {
      const url = buildEodhdProxyUrl(`/api/eod/${encodeURIComponent(ticker)}`, { from, to, fmt: 'json' });
      const headers = buildEodhdHeaders(this.apiKey);
      const diag = await fetchJsonWithDiagnostics(url, headers ? { headers } : undefined);
      if (!diag.ok) {
        if (diag.httpStatus === 404) {
          console.warn('[EODHD] 404', { ticker, symbol: ticker, url });
        }
        if (diag.httpStatus >= 500) throw new Error(PROXY_ERROR_MESSAGE);
        throw new Error(`EODHD ${diag.httpStatus}`);
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
        throw new Error(`invalid_payload http=${diag.httpStatus} ct=${diag.contentType || 'n/a'}`);
      }

      return mapEodhdHistoryRows(ticker, diag.json);
    } catch (e: any) {
      if (e?.message === PROXY_ERROR_MESSAGE) throw e;
      if (e instanceof TypeError) throw new Error(PROXY_ERROR_MESSAGE);
      if (String(e?.message || '').includes('invalid_payload')) throw e;
      console.error('EODHD History Error', e);
      return [];
    }
  }
}

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
export const syncPrices = async (apiKeyOverride?: string): Promise<SyncPricesSummary> => {
  const summary: SyncPricesSummary = {
    status: 'ok',
    updatedTickers: [],
    failedTickers: [],
    sheet: { enabled: true }
  };
  const portfolioId = getCurrentPortfolioId();
  const settings = await db.settings.where('portfolioId').equals(portfolioId).first();
  if (!settings) {
    summary.status = 'failed';
    summary.failedTickers.push({ ticker: '*', reason: 'Impostazioni mancanti' });
    summary.sheet = { enabled: false, reason: 'Impostazioni mancanti' };
    return summary;
  }

  const instruments = await db.instruments.where('portfolioId').equals(portfolioId).toArray();
  const eodhdKey = apiKeyOverride?.trim() || settings.eodhdApiKey;
  const eodhd = new EodhdPriceProvider(eodhdKey);
  const sheet = new GoogleSheetsPriceProvider(settings.googleSheetUrl);
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
  const allTx = await db.transactions.where('portfolioId').equals(portfolioId).sortBy('date');
  const earliestDateNeeded = allTx.length > 0
    ? format(subDays(allTx[0].date, 7), 'yyyy-MM-dd')
    : format(subDays(new Date(), 365), 'yyyy-MM-dd');
  const failedSet = new Set<string>();

  for (const instr of instruments) {
    if (instr.type === 'Cash') continue;
    const priceTicker = getCanonicalTickerFromInstrument(instr);
      const priceCurrency = instr.preferredListing?.currency || instr.currency;
      const tickerConfig = resolvePriceSyncConfig(priceTicker, settings);
      if (tickerConfig.excluded || tickerConfig.provider === 'MANUAL' || tickerConfig.needsMapping) continue;
      const resolvedSymbol = getResolvedSymbol(priceTicker, settings, tickerConfig.provider, instr.type);
      if (tickerConfig.provider === 'EODHD' && !resolvedSymbol) {
        if (!failedSet.has(priceTicker)) {
          summary.failedTickers.push({ ticker: priceTicker, reason: 'Symbol EODHD non valido' });
          failedSet.add(priceTicker);
        }
        continue;
      }

    const existing = await db.prices
      .where('[ticker+date]')
      .between([priceTicker, Dexie.minKey], [priceTicker, Dexie.maxKey])
      .and(p => p.portfolioId === portfolioId)
      .sortBy('date');

    const minPriceDate = existing[0]?.date;
    const maxPriceDate = existing[existing.length - 1]?.date;

    let startDate = earliestDateNeeded;
    if (minPriceDate && minPriceDate > earliestDateNeeded) {
      startDate = earliestDateNeeded;
    } else if (maxPriceDate) {
      startDate = format(new Date(maxPriceDate), 'yyyy-MM-dd');
    }

    if (startDate === today) continue;

    let newPoints: PricePoint[] = [];
    let eodhdError = '';
    let didEodhdRequest = false;

      if (tickerConfig.provider === 'EODHD') {
        try {
          didEodhdRequest = true;
          if (!resolvedSymbol) throw new Error('Symbol EODHD non valido');
          newPoints = await eodhd.getHistory(resolvedSymbol, startDate, today);
        } catch (e: any) {
          eodhdError = e?.message || 'Errore EODHD';
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
      if (tickerConfig.provider === 'SHEETS' || (!eodhdError && summary.sheet.enabled)) {
        const latest = await sheet.getLatestPrice(tickerConfig.sheetSymbol);
        if (latest && latest.close) {
          newPoints.push({
            ticker: priceTicker,
            date: latest.date || today,
            close: latest.close,
            currency: priceCurrency || (latest.currency as any) || Currency.USD
          });
        }
      }
    }

    if (newPoints.length > 0) {
      const pointsToSave = newPoints.map(p => ({
        ...p,
        ticker: priceTicker,
        currency: priceCurrency || p.currency || Currency.USD
      }));
      await db.prices.bulkPut(pointsToSave.map(p => ({ ...p, portfolioId })));
      summary.updatedTickers.push(priceTicker);
    } else if (!failedSet.has(priceTicker)) {
      if (tickerConfig.provider === 'SHEETS' && !summary.sheet.enabled) {
        summary.failedTickers.push({ ticker: priceTicker, reason: `Sheets: ${summary.sheet.reason || 'non disponibile'}` });
      } else {
        const reason = eodhdError || (tickerConfig.provider === 'SHEETS' ? 'Sheets: prezzo non trovato' : 'Nessun dato disponibile');
        summary.failedTickers.push({ ticker: priceTicker, reason });
      }
      failedSet.add(priceTicker);
    }
    if (didEodhdRequest) {
      await sleep(EODHD_SYNC_DELAY_MS);
    }
  }

  if (summary.failedTickers.length > 0) {
    summary.status = summary.updatedTickers.length > 0 ? 'partial' : 'failed';
  }
  if (!summary.sheet.enabled && summary.status === 'ok') {
    summary.status = 'partial';
  }

  return summary;
};

// Helpers per backfill
export const getTickersForBackfill = async (portfolioId: string, scope: 'current' | 'all'): Promise<string[]> => {
  const tx = await db.transactions.where('portfolioId').equals(portfolioId).toArray();
  const instruments = await db.instruments.where('portfolioId').equals(portfolioId).toArray();
  const canonicalByTicker = new Map(instruments.map(i => [i.ticker, getCanonicalTickerFromInstrument(i)]));
  const mapCanonical = (ticker: string) => canonicalByTicker.get(ticker) || ticker;
  if (scope === 'all') {
    const all = Array.from(new Set(tx.map(t => t.instrumentTicker).filter(Boolean))) as string[];
    return Array.from(new Set(all.map(mapCanonical)));
  }

  const qtyMap = new Map<string, number>();
  tx.forEach(t => {
    if (!t.instrumentTicker) return;
    const cur = qtyMap.get(t.instrumentTicker) || 0;
    if (t.type === TransactionType.Buy) qtyMap.set(t.instrumentTicker, cur + (t.quantity || 0));
    if (t.type === TransactionType.Sell) qtyMap.set(t.instrumentTicker, cur - (t.quantity || 0));
  });
  const current = Array.from(qtyMap.entries())
    .filter(([, qty]) => qty > 1e-8)
    .map(([ticker]) => ticker);
  if (current.length === 0) {
    const all = Array.from(new Set(tx.map(t => t.instrumentTicker).filter(Boolean))) as string[];
    return Array.from(new Set(all.map(mapCanonical)));
  }
  return Array.from(new Set(current.map(mapCanonical)));
};

export const getPriceCoverage = async (portfolioId: string, tickers: string[], minHistoryDate: string) => {
  const instruments = await db.instruments.where('portfolioId').equals(portfolioId).toArray();
  const ranges: Record<string, { firstDate?: string; lastDate?: string }> = {};
  let earliestCoveredDate: string | undefined;
  let latestCoveredDate: string | undefined;

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
  const perTicker = buildCoverageRows(tickers, ranges, instruments, minHistoryDate, today);
  const okCount = perTicker.filter(p => p.status === 'OK').length;
  return { earliestCoveredDate, latestCoveredDate, perTicker, okCount };
};

export const backfillPricesForPortfolio = async (
  portfolioId: string,
  tickers: string[],
  minHistoryDate: string,
  onProgress?: (info: { ticker: string; index: number; total: number; phase: 'backfill' | 'forward' | 'done'; error?: string }) => void,
  apiKeyOverride?: string
) => {
  const settings = await db.settings.where('portfolioId').equals(portfolioId).first();
  if (!settings) {
    const msg = 'Impostazioni mancanti';
    if (onProgress) onProgress({ ticker: '', index: 0, total: tickers.length, phase: 'done', error: msg });
    throw new Error(msg);
  }

  const eodhdKey = apiKeyOverride?.trim() || settings.eodhdApiKey;
  const eodhd = new EodhdPriceProvider(eodhdKey);
  const today = format(new Date(), 'yyyy-MM-dd');
  const instruments = await db.instruments.where('portfolioId').equals(portfolioId).toArray();
    const priceCurrencyByTicker = new Map<string, Currency>();
    instruments.forEach(inst => {
      const ticker = getCanonicalTickerFromInstrument(inst);
      if (!ticker) return;
      priceCurrencyByTicker.set(ticker, inst.preferredListing?.currency || inst.currency);
    });
    const filtered = tickers.filter(t => {
      const cfg = resolvePriceSyncConfig(t, settings);
      return cfg.provider === 'EODHD' && Boolean(getResolvedSymbol(t, settings, cfg.provider, instruments.find(i => i.ticker === t || i.preferredListing?.symbol === t)?.type));
    });

    for (let i = 0; i < filtered.length; i++) {
      const ticker = filtered[i];
      const cfg = resolvePriceSyncConfig(ticker, settings);
      const resolvedSymbol = getResolvedSymbol(ticker, settings, cfg.provider, instruments.find(i => i.ticker === ticker || i.preferredListing?.symbol === ticker)?.type);
      const priceCurrency = priceCurrencyByTicker.get(ticker);
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
        ranges.push({ from: minHistoryDate, to: minInDb ? format(subDays(new Date(minInDb), 1), 'yyyy-MM-dd') : today });
      }
      if (!maxInDb || maxInDb < today) {
        ranges.push({ from: maxInDb ? format(addDays(new Date(maxInDb), 1), 'yyyy-MM-dd') : minHistoryDate, to: today });
      }

        for (const r of ranges) {
          if (onProgress) onProgress({ ticker, index: i + 1, total: filtered.length, phase: 'forward' });
          if (!resolvedSymbol) throw new Error('Symbol EODHD non valido');
          const pts = await eodhd.getHistory(resolvedSymbol, r.from, r.to);
          if (pts.length > 0) {
            const toSave = pts.map(p => ({ ...p, ticker, currency: priceCurrency || p.currency || Currency.USD, portfolioId }));
            await db.prices.bulkPut(toSave);
          }
        await new Promise(res => setTimeout(res, 400)); // rate-limit soft
      }
    } catch (e: any) {
      const message = e?.message || String(e);
      if (onProgress) onProgress({ ticker, index: i + 1, total: filtered.length, phase: 'backfill', error: message });
      if (message === PROXY_ERROR_MESSAGE) throw e;
    }
  }
  if (onProgress) onProgress({ ticker: '', index: filtered.length, total: filtered.length, phase: 'done' });
};

export type SheetTestResult = {
  status: 'ok' | 'not_found' | 'disabled' | 'error';
  reason?: string;
  price?: Partial<PricePoint>;
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
    .then(list => list.find(i => i.ticker === ticker || i.preferredListing?.symbol === ticker || i.listings?.some(l => l.symbol === ticker)));

  const cfg = resolvePriceSyncConfig(ticker, settings);
  if (cfg.needsMapping || cfg.provider !== 'EODHD') return { status: 'not_found', message: 'needs-mapping' };

  const symbol = getResolvedSymbol(ticker, settings, cfg.provider, instrument?.type);
  if (!symbol) return { status: 'not_found', message: 'missing-symbol' };

  const target = format(dateObj, 'yyyy-MM-dd');
  const from = format(subDays(dateObj, Math.max(1, lookbackDays)), 'yyyy-MM-dd');

  if (!options?.forceEodhd) {
    const exact = await db.prices
      .where('[ticker+date]')
      .equals([ticker, target])
      .and(p => p.portfolioId === portfolioId)
      .first();
    if (exact && Number.isFinite(exact.close)) {
      return { status: 'exact', dateUsed: exact.date, close: exact.close, currency: exact.currency, source: 'cache' };
    }

    const cachedRange = await db.prices
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

  try {
    const url = buildEodhdProxyUrl(`/api/eod/${encodeURIComponent(symbol)}`, { from, to: target, fmt: 'json' });
    const headers = buildEodhdHeaders(settings.eodhdApiKey);
    const diag = await fetchJsonWithDiagnostics(url, headers ? { headers, signal: options?.signal } : { signal: options?.signal });
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
          date: rowDate,
          close,
          currency: currency || Currency.USD,
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
    .then(list => list.find(i => i.ticker === ticker || i.preferredListing?.symbol === ticker || i.listings?.some(l => l.symbol === ticker)));

  const cfg = resolvePriceSyncConfig(ticker, settings);
  if (cfg.needsMapping || cfg.provider !== 'EODHD') return null;

  const cached = await db.prices
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
    const url = buildEodhdProxyUrl(`/api/eod/${encodeURIComponent(symbol)}`, { from, to, fmt: 'json' });
    const headers = buildEodhdHeaders(settings.eodhdApiKey);
    const res = await fetch(url, headers ? { headers } : undefined);
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data)) return null;

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
