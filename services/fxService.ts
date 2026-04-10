import { db } from '../db';
import { Currency, Instrument } from '../types';
import Dexie from 'dexie';
import { checkProxyHealth } from './apiHealthService';
import { fetchJsonWithDiagnostics, FetchJsonDiagnostics, toNum } from './diagnostics';
import { addDaysYmd, diffDaysYmd, subDaysYmd } from './dateUtils';
import { FX_STALE_DAYS } from './constants';
import { upsertFxRowsByNaturalKey } from './dataWriteService';

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

export type FxBackfillMode = 'MANUAL_FULL' | 'AUTO_GAPS';

export type FxBackfillOptions = {
  mode?: FxBackfillMode;
  maxApiCallsPerRun?: number;
  maxLookbackDays?: number;
  staleThresholdDays?: number;
  sleepMs?: number;
  maxDailyCalls?: number;
  allowDirectFallback?: boolean;
};

export type FxBackfillSummary = {
  status: 'ok' | 'error' | 'quota_exhausted' | 'proxy_unreachable';
  message?: string;
  quota?: { pair: string; httpStatus: number; contentType?: string; rawPreview?: string };
  updatedPairs: string[];
  skipped: number;
  stoppedByBudget?: boolean;
  mode: FxBackfillMode;
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
  const rows: FxRateRow[] = [];
  for (const line of lines.slice(1)) { // skip header
    const [dateRaw, rateRaw] = line.split(',').map(s => s.trim());
    const date = String(dateRaw || '').trim();
    const rate = toNum(rateRaw);
    if (!date || rate === null || rate <= 0) continue;
    rows.push({ baseCurrency: base, quoteCurrency: quote, date, rate, source });
  }
  if (!rows.length) return 0;
  const deduped = dedupeFxRows(rows);
  await upsertFxRowsByNaturalKey(deduped);
  return deduped.length;
};

const PROXY_HELP_MESSAGE = 'Proxy /api non raggiungibile. Avvia `npm run dev:vercel` oppure verifica il deploy del proxy /api.';
const EODHD_DIRECT_BASE = 'https://eodhd.com';
const EODHD_PROXY_ENDPOINT = '/api/eodhd-proxy';

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
  // NOTE: direct fallback uses api_token in query string. This is acceptable for now.
  if (apiKey) url.searchParams.set('api_token', apiKey);
  return url.toString();
};

export const isProxyMissingResponse = (diag: FetchJsonDiagnostics): boolean => {
  if (diag.httpStatus !== 404) return false;
  const ct = (diag.contentType || '').toLowerCase();
  if (ct.includes('text/html')) return true;
  const preview = (diag.rawPreview || '').trim().toLowerCase();
  return preview.startsWith('<!doctype html') || preview.startsWith('<html') || preview.includes('cannot get') || preview.includes('not found');
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

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const buildFxSymbol = (base: Currency, quote: Currency) => `${base}${quote}.FOREX`;

export const mapFxHistoryRows = (
  base: Currency,
  quote: Currency,
  data: unknown[],
  invert = false
): FxRateRow[] => {
  return data
    .map((row: any) => {
      const date = String(row?.date || '').trim();
      const raw = row?.adjusted_close ?? row?.close ?? row?.rate ?? row?.value ?? row?.price;
      const rate = toNum(raw);
      if (!date || rate === null || rate <= 0) return null;
      return {
        baseCurrency: base,
        quoteCurrency: quote,
        date,
        rate: invert ? 1 / rate : rate,
        source: 'eodhd'
      } as FxRateRow;
    })
    .filter((row): row is FxRateRow => Boolean(row));
};

export const fetchEodhdFxRange = async (
  base: Currency,
  quote: Currency,
  from: string,
  to: string,
  apiKey: string,
  mode: 'proxy' | 'direct'
): Promise<{ ok: boolean; rows: FxRateRow[]; diag: FetchJsonDiagnostics; usedSymbol: string; inverted?: boolean }> => {
  const symbol = buildFxSymbol(base, quote);
  const path = `/api/eod/${encodeURIComponent(symbol)}`;
  const params = { from, to, fmt: 'json' };
  const url = mode === 'direct'
    ? buildEodhdDirectUrl(path, params, apiKey)
    : buildEodhdProxyUrl(path, params);
  const headers = mode === 'proxy' && apiKey ? { 'x-eodhd-key': apiKey } : undefined;
  const diag = await fetchJsonWithDiagnostics(url, headers ? { headers } : undefined);
  if (diag.ok && Array.isArray(diag.json)) {
    return { ok: true, rows: mapFxHistoryRows(base, quote, diag.json), diag, usedSymbol: symbol };
  }
  if (!diag.ok && diag.httpStatus === 404) {
    const invSymbol = buildFxSymbol(quote, base);
    const invPath = `/api/eod/${encodeURIComponent(invSymbol)}`;
    const invUrl = mode === 'direct'
      ? buildEodhdDirectUrl(invPath, params, apiKey)
      : buildEodhdProxyUrl(invPath, params);
    const invDiag = await fetchJsonWithDiagnostics(invUrl, headers ? { headers } : undefined);
    if (invDiag.ok && Array.isArray(invDiag.json)) {
      return { ok: true, rows: mapFxHistoryRows(base, quote, invDiag.json, true), diag: invDiag, usedSymbol: invSymbol, inverted: true };
    }
    return { ok: false, rows: [], diag: invDiag, usedSymbol: invSymbol };
  }
  return { ok: false, rows: [], diag, usedSymbol: symbol };
};

export const dedupeFxRows = (rows: FxRateRow[]) => {
  const map = new Map<string, FxRateRow>();
  rows.forEach(row => {
    map.set(`${row.baseCurrency}/${row.quoteCurrency}|${row.date}`, row);
  });
  return Array.from(map.values());
};

export const getFxPairsForPortfolio = async (
  portfolioId: string,
  baseCurrencyOverride?: Currency
): Promise<string[]> => {
  const settings = await db.settings.where('portfolioId').equals(portfolioId).first();
  const baseCurrency = baseCurrencyOverride || settings?.baseCurrency || Currency.CHF;
  const instruments = await db.instruments.where('portfolioId').equals(portfolioId).toArray();
  const pairs = new Set<string>();
  instruments.forEach((inst: Instrument) => {
    const currency = inst.preferredListing?.currency || inst.currency;
    if (!currency || currency === baseCurrency) return;
    pairs.add(`${currency}/${baseCurrency}`);
  });
  return Array.from(pairs);
};

export const backfillFxRatesForPortfolio = async (
  portfolioId: string,
  pairs: string[],
  onProgress?: (info: { pair: string; index: number; total: number; phase: 'backfill' | 'done'; error?: string }) => void,
  apiKeyOverride?: string,
  options?: FxBackfillOptions
): Promise<FxBackfillSummary> => {
  const mode: FxBackfillMode = options?.mode || 'MANUAL_FULL';
  const summary: FxBackfillSummary = { status: 'ok', updatedPairs: [], skipped: 0, stoppedByBudget: false, mode };
  const settings = await db.settings.where('portfolioId').equals(portfolioId).first();
  if (!settings) {
    return { ...summary, status: 'error', message: 'Impostazioni mancanti' };
  }
  const eodhdKey = apiKeyOverride?.trim() || settings.eodhdApiKey?.trim() || '';
  const allowDirectFallback = options?.allowDirectFallback ?? (typeof window === 'undefined');
  const health = await checkProxyHealth({ eodhdApiKey: eodhdKey });
  if (!health.ok && health.mode !== 'direct-local-key') {
    return { ...summary, status: 'proxy_unreachable', message: health.message || PROXY_HELP_MESSAGE };
  }
  if (health.mode === 'direct-local-key' && !allowDirectFallback) {
    return { ...summary, status: 'proxy_unreachable', message: 'Proxy /api non raggiungibile. Fallback diretto disabilitato.' };
  }
  if (!health.hasEodhdKey && !health.usingLocalKey) {
    return { ...summary, status: 'error', message: 'Chiave EODHD mancante. Inseriscila in Settings o in `.env.local`.' };
  }

  const modeChoice: 'proxy' | 'direct' = health.mode === 'direct-local-key' ? 'direct' : 'proxy';
  const maxApiCallsPerRun = options?.maxApiCallsPerRun ?? (mode === 'AUTO_GAPS' ? 5 : 10);
  const maxLookbackDays = options?.maxLookbackDays ?? (mode === 'AUTO_GAPS' ? 30 : 365);
  const staleThresholdDays = options?.staleThresholdDays ?? FX_STALE_DAYS;
  const sleepMs = options?.sleepMs ?? 400;
  const maxDailyCalls = options?.maxDailyCalls;
  const today = new Date().toISOString().slice(0, 10);
  const minAllowedFrom = subDaysYmd(today, maxLookbackDays);

  let usedThisRun = 0;
  let dailyUsed = readDailyBudget(today).used;

  const validPairs = pairs.filter(pair => pair.includes('/'));
  if (!validPairs.length) {
    return { ...summary, skipped: 0, status: 'ok', message: 'Nessuna coppia FX da aggiornare.' };
  }

  if (import.meta.env?.DEV) {
    console.log('[FX][Backfill]', {
      mode: modeChoice,
      requestedMode: mode,
      pairs: validPairs.length,
      allowDirectFallback,
      maxApiCallsPerRun,
      maxLookbackDays,
      staleThresholdDays,
      maxDailyCalls
    });
  }

  for (let i = 0; i < validPairs.length; i++) {
    const pair = validPairs[i];
    const [base, quote] = pair.split('/') as [Currency, Currency];
    if (!base || !quote || base === quote) {
      summary.skipped += 1;
      continue;
    }
    const existing = await db.fxRates
      .where('[baseCurrency+quoteCurrency+date]')
      .between([base, quote, minAllowedFrom], [base, quote, today])
      .sortBy('date');
    const minInDb = existing[0]?.date;
    const maxInDb = existing[existing.length - 1]?.date;

    let ranges: { from: string; to: string }[] = [];
    let reason: 'internal-gap' | 'tail-stale' | 'skip-up-to-date' | 'manual' = 'manual';
    if (mode === 'AUTO_GAPS') {
      const gapRanges: { from: string; to: string }[] = [];
      for (let idx = 0; idx < existing.length - 1; idx++) {
        const curr = existing[idx];
        const next = existing[idx + 1];
        if (!curr?.date || !next?.date) continue;
        const gapDays = diffDaysYmd(next.date, curr.date) - 1;
        if (gapDays >= staleThresholdDays) {
          let from = addDaysYmd(curr.date, 1);
          let to = subDaysYmd(next.date, 1);
          if (from < minAllowedFrom) from = minAllowedFrom;
          if (to > today) to = today;
          if (from <= to) gapRanges.push({ from, to });
        }
      }

      if (gapRanges.length > 0) {
        gapRanges.sort((a, b) => a.to.localeCompare(b.to));
        ranges = [gapRanges[gapRanges.length - 1]];
        reason = 'internal-gap';
      } else {
        const lastDate = maxInDb;
        if (!lastDate || diffDaysYmd(today, lastDate) > staleThresholdDays) {
          const fromCandidate = lastDate ? addDaysYmd(lastDate, 1) : minAllowedFrom;
          const from = fromCandidate < minAllowedFrom ? minAllowedFrom : fromCandidate;
          if (from <= today) ranges = [{ from, to: today }];
          reason = 'tail-stale';
        } else {
          summary.skipped += 1;
          reason = 'skip-up-to-date';
          if (import.meta.env?.DEV) {
            console.log('[FX][Backfill]', { pair, reason, lastDate: maxInDb, today });
          }
          continue;
        }
      }
    } else {
      reason = 'manual';
      if (!minInDb && !maxInDb) {
        ranges = [{ from: minAllowedFrom, to: today }];
      } else {
        if (!minInDb || minInDb > minAllowedFrom) {
          const to = minInDb ? subDaysYmd(minInDb, 1) : today;
          ranges.push({ from: minAllowedFrom, to });
        }
        if (!maxInDb || maxInDb < today) {
          const fromCandidate = maxInDb ? addDaysYmd(maxInDb, 1) : minAllowedFrom;
          const from = fromCandidate < minAllowedFrom ? minAllowedFrom : fromCandidate;
          ranges.push({ from, to: today });
        }
      }
    }

    ranges = ranges.filter(r => r.from <= r.to);
    if (!ranges.length) {
      summary.skipped += 1;
      continue;
    }

    for (const range of ranges) {
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
      if (onProgress) onProgress({ pair, index: i + 1, total: validPairs.length, phase: 'backfill' });
      const result = await fetchEodhdFxRange(base, quote, range.from, range.to, eodhdKey, modeChoice);
      const diag = result.diag;
      if (import.meta.env?.DEV) {
        console.log('[FX][Backfill]', {
          pair,
          range,
          reason,
          mode: modeChoice,
          ok: result.ok,
          httpStatus: diag.httpStatus,
          usedSymbol: result.usedSymbol,
          inverted: result.inverted
        });
      }
      if (!diag.ok && diag.httpStatus === 402) {
        return {
          ...summary,
          status: 'quota_exhausted',
          message: 'Quota EODHD esaurita (402). Backfill FX interrotto.',
          quota: { pair, httpStatus: diag.httpStatus, contentType: diag.contentType, rawPreview: diag.rawPreview }
        };
      }
      let rowsToSave: FxRateRow[] = [];
      if (!diag.ok && modeChoice === 'proxy' && isProxyMissingResponse(diag) && eodhdKey && allowDirectFallback) {
        if (import.meta.env?.DEV) {
          console.log('[FX][Backfill]', { pair, range, fallback: 'direct' });
        }
        const directResult = await fetchEodhdFxRange(base, quote, range.from, range.to, eodhdKey, 'direct');
        if (directResult.ok) {
          rowsToSave = directResult.rows;
        } else if (directResult.diag.httpStatus === 402) {
          return {
            ...summary,
            status: 'quota_exhausted',
            message: 'Quota EODHD esaurita (402). Backfill FX interrotto.',
            quota: { pair, httpStatus: directResult.diag.httpStatus, contentType: directResult.diag.contentType, rawPreview: directResult.diag.rawPreview }
          };
        } else {
          summary.status = 'error';
          summary.message = directResult.diag.ok ? 'Risposta non valida' : `HTTP ${directResult.diag.httpStatus}`;
        }
      } else if (result.ok) {
        rowsToSave = result.rows;
      } else if (!diag.ok && modeChoice === 'proxy' && isProxyMissingResponse(diag)) {
        return { ...summary, status: 'proxy_unreachable', message: PROXY_HELP_MESSAGE };
      } else {
        summary.status = 'error';
        summary.message = diag.ok ? 'Risposta non valida' : `HTTP ${diag.httpStatus}`;
      }

      if (rowsToSave.length > 0) {
        const deduped = dedupeFxRows(rowsToSave);
        await upsertFxRowsByNaturalKey(deduped);
        if (!summary.updatedPairs.includes(pair)) summary.updatedPairs.push(pair);
        if (reason === 'internal-gap' && summary.status === 'ok') {
          const note = `riempito gap ${pair} ${range.from} → ${range.to}`;
          summary.message = summary.message ? `${summary.message}; ${note}` : `Backfill FX: ${note}`;
        }
      } else if (summary.status === 'ok') {
        summary.skipped += 1;
      }
      await sleep(sleepMs);
    }
    if (summary.stoppedByBudget) break;
  }

  if (onProgress) onProgress({ pair: '', index: validPairs.length, total: validPairs.length, phase: 'done' });
  return summary;
};
