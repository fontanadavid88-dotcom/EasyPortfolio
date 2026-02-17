import { db, getCurrentPortfolioId } from '../db';
import { syncPrices, SyncPricesSummary, backfillPricesForPortfolio, getTickersForBackfill, BackfillOptions } from './priceService';
import { syncFxRates } from './appsScriptService';

export type AutoGapScope = 'current' | 'allPortfolios';

export type AutoSyncResult = {
  prices?: SyncPricesSummary;
  fx?: { ok: boolean; count?: number; error?: string };
  gaps?: { ok: boolean; updatedTickers: string[]; skipped: number; stoppedByBudget?: boolean; error?: string };
};

type AutoSyncMeta = {
  lastRun?: string;
  pricesUpdated?: number;
  fxCount?: number;
  gapsUpdated?: number;
  gapsSkipped?: number;
  stoppedByBudget?: boolean;
  gapError?: string;
};

const AUTO_GAP_ENABLED_KEY = (portfolioId: string) => `auto_gap_fill_enabled_${portfolioId}`;
const AUTO_GAP_SCOPE_KEY = 'auto_gap_fill_scope';
const AUTO_SYNC_LAST_KEY = (portfolioId: string) => `auto_sync_last_${portfolioId}`;
const AUTO_SYNC_LAST_RESULT_KEY = (portfolioId: string) => `auto_sync_last_result_${portfolioId}`;

const readJson = <T,>(key: string, fallback: T): T => {
  if (typeof localStorage === 'undefined') return fallback;
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const writeJson = (key: string, value: unknown) => {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(key, JSON.stringify(value));
};

export const getAutoGapFillEnabled = (portfolioId: string): boolean => {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem(AUTO_GAP_ENABLED_KEY(portfolioId)) === '1';
};

export const setAutoGapFillEnabled = (portfolioId: string, enabled: boolean) => {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(AUTO_GAP_ENABLED_KEY(portfolioId), enabled ? '1' : '0');
};

export const getAutoGapFillScope = (): AutoGapScope => {
  if (typeof localStorage === 'undefined') return 'current';
  const value = localStorage.getItem(AUTO_GAP_SCOPE_KEY);
  return value === 'allPortfolios' ? 'allPortfolios' : 'current';
};

export const setAutoGapFillScope = (scope: AutoGapScope) => {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(AUTO_GAP_SCOPE_KEY, scope);
};

export const getAutoSyncMeta = (portfolioId: string): AutoSyncMeta => {
  return readJson<AutoSyncMeta>(AUTO_SYNC_LAST_RESULT_KEY(portfolioId), {});
};

export const setAutoSyncMeta = (portfolioId: string, meta: AutoSyncMeta) => {
  writeJson(AUTO_SYNC_LAST_RESULT_KEY(portfolioId), meta);
};

const shouldRunForPortfolio = (portfolioId: string, runAtMostEveryHours: number) => {
  if (typeof localStorage === 'undefined') return true;
  if (!runAtMostEveryHours || runAtMostEveryHours <= 0) return true;
  const lastRaw = localStorage.getItem(AUTO_SYNC_LAST_KEY(portfolioId));
  if (!lastRaw) return true;
  const last = new Date(lastRaw).getTime();
  if (!Number.isFinite(last)) return true;
  const diffHours = (Date.now() - last) / 36e5;
  return diffHours >= runAtMostEveryHours;
};

const setLastRun = (portfolioId: string, iso: string) => {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(AUTO_SYNC_LAST_KEY(portfolioId), iso);
};

let autoSyncStarted = false;

export async function autoSyncOnAppOpen(opts?: {
  portfolioScope?: AutoGapScope;
  runAtMostEveryHours?: number;
}): Promise<AutoSyncResult> {
  if (autoSyncStarted) return {};
  autoSyncStarted = true;

  const scope = opts?.portfolioScope || getAutoGapFillScope();
  const runAtMostEveryHours = opts?.runAtMostEveryHours ?? 6;
  const portfolioIds = scope === 'allPortfolios'
    ? (await db.portfolios.toArray()).map(p => p.portfolioId)
    : [getCurrentPortfolioId()];

  const result: AutoSyncResult = {};
  for (const portfolioId of portfolioIds) {
    if (!shouldRunForPortfolio(portfolioId, runAtMostEveryHours)) continue;

    const settings = await db.settings.where('portfolioId').equals(portfolioId).first();
    if (!settings) continue;

    const nowIso = new Date().toISOString();
    setLastRun(portfolioId, nowIso);

    let fxRes: AutoSyncResult['fx'] | undefined;
    if (settings.appsScriptUrl?.trim() && settings.appsScriptApiKey?.trim()) {
      try {
        const fx = await syncFxRates(settings, 'apps_script');
        fxRes = fx.ok ? { ok: true, count: fx.count } : { ok: false, error: fx.error || 'FX non disponibili' };
      } catch (e: any) {
        fxRes = { ok: false, error: e?.message || 'FX non disponibili' };
      }
    } else {
      fxRes = { ok: false, error: 'Apps Script disabilitato' };
    }

    const prices = await syncPrices(settings.eodhdApiKey, { portfolioId, mode: 'LATEST' });

    let gapsRes: AutoSyncResult['gaps'] | undefined;
    if (getAutoGapFillEnabled(portfolioId)) {
      const tickers = await getTickersForBackfill(portfolioId, settings.priceBackfillScope || 'current');
      const options: BackfillOptions = {
        mode: 'AUTO_GAPS',
        maxApiCallsPerRun: 10,
        maxLookbackDays: 30,
        staleThresholdDays: 7,
        sleepMs: 400
      };
      const gaps = await backfillPricesForPortfolio(
        portfolioId,
        tickers,
        settings.minHistoryDate || '2020-01-01',
        undefined,
        settings.eodhdApiKey,
        options
      );
      gapsRes = {
        ok: gaps.status === 'ok',
        updatedTickers: gaps.updatedTickers || [],
        skipped: gaps.skipped || 0,
        stoppedByBudget: gaps.stoppedByBudget,
        error: gaps.message
      };
    }

    setAutoSyncMeta(portfolioId, {
      lastRun: nowIso,
      pricesUpdated: prices.updatedTickers.length,
      fxCount: fxRes?.ok ? fxRes.count : undefined,
      gapsUpdated: gapsRes?.updatedTickers.length,
      gapsSkipped: gapsRes?.skipped,
      stoppedByBudget: gapsRes?.stoppedByBudget,
      gapError: gapsRes?.error
    });

    if (import.meta.env?.DEV) {
      console.log('[auto-sync]', { portfolioId, prices, fx: fxRes, gaps: gapsRes });
    }

    if (portfolioId === getCurrentPortfolioId()) {
      result.prices = prices;
      result.fx = fxRes;
      result.gaps = gapsRes;
    }
  }

  return result;
}
