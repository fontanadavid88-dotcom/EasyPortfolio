import { AppSettings, Currency, Instrument } from '../types';
import { syncPrices, getTickersForBackfill, backfillPricesForPortfolio, SyncPricesSummary, BackfillSummary, fetchLatestEodhdPrice, buildPointsForSave, resolvePriceSyncConfig, describeLatestPriceFetchError, isLatestPriceFetchError } from './priceService';
import { backfillFxRatesForPortfolio, getFxPairsForPortfolio, FxBackfillSummary } from './fxService';
import { syncFxRates, SyncFxResult } from './appsScriptService';
import { setLastGapFillAt, setLastLatestSyncAt } from './syncStatusService';
import { db } from '../db';
import { getCanonicalTicker } from './financeUtils';
import { resolveEodhdSymbol } from './symbolUtils';
import { upsertPriceRowsByNaturalKey } from './dataWriteService';

export type SyncProgressHandler = (message: string) => void;

export type LatestSyncOutcome = {
  priceResult: SyncPricesSummary;
  fx?: SyncFxResult & { disabled?: boolean };
  ok: boolean;
  latestSyncAt?: string;
  updatedSheetTickers: string[];
  updatedFallbackTickers: string[];
  missingTickers: string[];
};

export type GapFillOutcome = {
  priceResult: BackfillSummary;
  fxResult?: FxBackfillSummary | null;
  ok: boolean;
  gapFillAt?: string;
};

const summarizeFailedTickers = (failedTickers: { ticker: string; reason: string }[], limit = 3) => {
  if (!failedTickers.length) return '';
  const head = failedTickers
    .slice(0, limit)
    .map(item => `${item.ticker}: ${item.reason}`)
    .join('; ');
  return failedTickers.length > limit ? `${head} (+${failedTickers.length - limit} altri)` : head;
};

const resolveLatestSyncStatus = (
  baseStatus: SyncPricesSummary['status'],
  updatedCount: number,
  failedCount: number
): SyncPricesSummary['status'] => {
  if (updatedCount > 0) return failedCount > 0 ? 'partial' : 'ok';
  if (baseStatus === 'quota_exhausted') return 'quota_exhausted';
  if (baseStatus === 'proxy_unreachable') return 'proxy_unreachable';
  return 'failed';
};

const buildLatestSyncMessage = (
  status: SyncPricesSummary['status'],
  failedTickers: { ticker: string; reason: string }[],
  baseMessage?: string
) => {
  const failureSummary = summarizeFailedTickers(failedTickers);
  if (status === 'ok') return undefined;
  if (status === 'partial') {
    return failureSummary ? `Aggiornamento parziale. ${failureSummary}` : (baseMessage || 'Aggiornamento parziale.');
  }
  if (status === 'quota_exhausted' || status === 'proxy_unreachable') {
    return baseMessage || failureSummary || 'Latest sync non completato.';
  }
  return failureSummary
    ? `Nessun ticker aggiornato. ${failureSummary}`
    : (baseMessage || 'Nessun ticker aggiornato.');
};

export const runLatestSync = async (params: {
  portfolioId: string;
  settings: AppSettings;
  baseCurrency?: Currency;
  holdingsTickers?: string[];
  onProgress?: SyncProgressHandler;
  maxFallbackTickers?: number;
}): Promise<LatestSyncOutcome> => {
  const { portfolioId, settings, maxFallbackTickers = 5 } = params;
  const priceResult = await syncPrices(settings.eodhdApiKey, { portfolioId, mode: 'LATEST' });
  let fx: LatestSyncOutcome['fx'];
  const appsScriptEnabled = Boolean(settings.appsScriptUrl?.trim() && settings.appsScriptApiKey?.trim());
  if (appsScriptEnabled) {
    const fxResult = await syncFxRates(settings, 'apps_script');
    fx = fxResult;
  } else {
    fx = { ok: true, disabled: true };
  }
  const updatedSheetTickers = priceResult.updatedTickers || [];
  const updatedFallbackTickers: string[] = [];
  const missingTickers = new Set<string>();
  const fallbackFailures = new Map<string, string>();

  const instruments = await db.instruments.where('portfolioId').equals(portfolioId).toArray();
  const instrumentByTicker = new Map<string, Instrument>();
  instruments.forEach(inst => {
    const ticker = getCanonicalTicker(inst);
    if (ticker) instrumentByTicker.set(ticker, inst);
  });
  const failedTickers = priceResult.failedTickers
    .map(f => f.ticker)
    .filter(t => t && instrumentByTicker.has(t));
  const candidates = failedTickers.filter(ticker => {
    const cfg = resolvePriceSyncConfig(ticker, settings);
    if (cfg.excluded || cfg.needsMapping || cfg.provider === 'MANUAL') return false;
    return true;
  });
  candidates.forEach(t => missingTickers.add(t));

  const apiKey = settings.eodhdApiKey?.trim();
  if (apiKey && candidates.length > 0) {
    const limited = candidates.slice(0, maxFallbackTickers);
    for (const ticker of limited) {
      const inst = instrumentByTicker.get(ticker);
      const cfg = resolvePriceSyncConfig(ticker, settings);
      const rawSymbol = cfg.eodhdSymbol?.trim() || ticker;
      const resolvedSymbol = resolveEodhdSymbol(rawSymbol, inst?.type);
      try {
        const latest = await fetchLatestEodhdPrice(resolvedSymbol, apiKey);
        if (!latest || latest.close === undefined || latest.close === null) continue;
        const priceCurrency = inst?.preferredListing?.currency || inst?.currency;
        const points = buildPointsForSave([{
          ticker,
          date: latest.date || new Date().toISOString().slice(0, 10),
          close: latest.close,
          currency: priceCurrency || (latest.currency as any)
        }], {
          ticker,
          instrumentId: inst?.id ? String(inst.id) : undefined,
          currency: priceCurrency,
          portfolioId
        });
        await upsertPriceRowsByNaturalKey(points);
        updatedFallbackTickers.push(ticker);
        missingTickers.delete(ticker);
      } catch (error) {
        const reason = describeLatestPriceFetchError(error);
        fallbackFailures.set(ticker, reason);
        if (import.meta.env?.DEV) {
          console.warn('[SYNC][LatestFallback]', {
            ticker,
            symbol: resolvedSymbol,
            provider: 'EODHD',
            httpStatus: isLatestPriceFetchError(error) ? error.httpStatus : undefined,
            payloadPreview: isLatestPriceFetchError(error) ? error.payloadPreview : undefined,
            reason
          });
        }
      }
    }
  }

  const recovered = new Set(updatedFallbackTickers);
  const mergedFailedTickers = priceResult.failedTickers
    .filter(item => !recovered.has(item.ticker))
    .map(item => ({ ...item, reason: fallbackFailures.get(item.ticker) || item.reason }));
  const mergedFailureSet = new Set(mergedFailedTickers.map(item => item.ticker));
  fallbackFailures.forEach((reason, ticker) => {
    if (mergedFailureSet.has(ticker) || recovered.has(ticker)) return;
    mergedFailedTickers.push({ ticker, reason });
  });
  const mergedUpdatedTickers = Array.from(new Set([...updatedSheetTickers, ...updatedFallbackTickers]));
  const finalStatus = resolveLatestSyncStatus(priceResult.status, mergedUpdatedTickers.length, mergedFailedTickers.length);
  const mergedPriceResult: SyncPricesSummary = {
    ...priceResult,
    status: finalStatus,
    updatedTickers: mergedUpdatedTickers,
    failedTickers: mergedFailedTickers,
    message: buildLatestSyncMessage(finalStatus, mergedFailedTickers, priceResult.message)
  };

  const updatedTotal = mergedUpdatedTickers.length;
  const ok = updatedTotal > 0;
  if (ok) {
    const nowIso = new Date().toISOString();
    setLastLatestSyncAt(portfolioId, nowIso);
    return {
      priceResult: mergedPriceResult,
      fx,
      ok,
      latestSyncAt: nowIso,
      updatedSheetTickers,
      updatedFallbackTickers,
      missingTickers: Array.from(missingTickers.values())
    };
  }
  return {
    priceResult: mergedPriceResult,
    fx,
    ok,
    updatedSheetTickers,
    updatedFallbackTickers,
    missingTickers: Array.from(missingTickers.values())
  };
};

export const runGapFill = async (params: {
  portfolioId: string;
  settings: AppSettings;
  baseCurrency?: Currency;
  holdingsTickers?: string[];
  onProgress?: SyncProgressHandler;
}): Promise<GapFillOutcome> => {
  const { portfolioId, settings, baseCurrency, holdingsTickers, onProgress } = params;
  const tickers = holdingsTickers?.length
    ? holdingsTickers
    : await getTickersForBackfill(portfolioId, settings.priceBackfillScope || 'current');
  const minDate = settings.minHistoryDate || '2020-01-01';
  const priceResult = await backfillPricesForPortfolio(
    portfolioId,
    tickers,
    minDate,
    (p) => {
      if (!onProgress) return;
      if (p.phase === 'done') {
        onProgress('Backfill prezzi completato.');
      } else {
        onProgress(`${p.phase === 'backfill' ? 'Gap-fill' : 'Forward'} ${p.index}/${p.total} ${p.ticker}${p.error ? ` - ${p.error}` : ''}`);
      }
    },
    settings.eodhdApiKey,
    { mode: 'AUTO_GAPS', maxApiCallsPerRun: 10, maxLookbackDays: 30, staleThresholdDays: 7, sleepMs: 400 }
  );

  const base = baseCurrency || settings.baseCurrency || Currency.CHF;
  const pairs = await getFxPairsForPortfolio(portfolioId, base);
  let fxResult: FxBackfillSummary | null = null;
  if (pairs.length) {
    fxResult = await backfillFxRatesForPortfolio(
      portfolioId,
      pairs,
      (p) => {
        if (!onProgress) return;
        if (p.phase === 'done') {
          onProgress('Backfill FX completato.');
        } else {
          onProgress(`Backfill FX ${p.index}/${p.total} ${p.pair}${p.error ? ` - ${p.error}` : ''}`);
        }
      },
      settings.eodhdApiKey,
      { mode: 'AUTO_GAPS', maxApiCallsPerRun: 5, maxLookbackDays: 30, staleThresholdDays: 7, sleepMs: 400 }
    );
  }

  const fxOk = !pairs.length || fxResult?.status === 'ok';
  const ok = priceResult.status === 'ok'
    && fxOk
    && !(priceResult.internalGapFailures && priceResult.internalGapFailures > 0);
  if (ok) {
    const nowIso = new Date().toISOString();
    setLastGapFillAt(portfolioId, nowIso);
    return { priceResult, fxResult, ok, gapFillAt: nowIso };
  }
  return { priceResult, fxResult, ok };
};
