import { Currency, Instrument, PortfolioPosition, PricePoint } from '../types';
import { FxRateRow } from './fxService';
import { analyzeRebalanceQuality, RebalanceQualityIssue } from './dataQuality';
import { diffDaysYmd } from './dateUtils';
import { FX_STALE_DAYS, PRICE_STALE_DAYS } from './constants';

export type SyncStatus = {
  latestPricesAt: string | null;
  latestPricesOk: boolean;
  priceCoverage: { ok: number; total: number };
  missingTickers: string[];
  latestFxAt: string | null;
  latestFxOk: boolean;
  missingPairs: string[];
  quality: {
    ok: boolean;
    missingPrices: number;
    missingFx: number;
    currencyMismatch: number;
    stale: number;
    issues: RebalanceQualityIssue[];
  };
};

const syncKey = (portfolioId: string, key: string) => `easyportfolio:${portfolioId}:${key}`;

export const getLastLatestSyncAt = (portfolioId: string): string | null => {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(syncKey(portfolioId, 'lastLatestSyncAt'));
};

export const setLastLatestSyncAt = (portfolioId: string, iso: string) => {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(syncKey(portfolioId, 'lastLatestSyncAt'), iso);
};

export const getLastGapFillAt = (portfolioId: string): string | null => {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(syncKey(portfolioId, 'lastGapFillAt'));
};

export const setLastGapFillAt = (portfolioId: string, iso: string) => {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(syncKey(portfolioId, 'lastGapFillAt'), iso);
};

export const getHoldingsTickers = (
  holdings?: Map<string, number> | PortfolioPosition[]
): string[] => {
  if (!holdings) return [];
  if (holdings instanceof Map) {
    return Array.from(holdings.entries())
      .filter(([, qty]) => qty > 0.000001)
      .map(([ticker]) => ticker);
  }
  return holdings.filter(p => p.quantity > 0.000001).map(p => p.ticker);
};

export const getFxPairsForHoldings = (
  holdings: Map<string, number>,
  instruments: Instrument[],
  baseCurrency: Currency
): string[] => {
  const instByTicker = new Map<string, Instrument>();
  instruments.forEach(inst => {
    const key = inst.symbol || inst.ticker;
    if (key) instByTicker.set(key, inst);
    if (inst.ticker) instByTicker.set(inst.ticker, inst);
  });
  const pairs = new Set<string>();
  holdings.forEach((qty, ticker) => {
    if (qty <= 0.000001) return;
    const inst = instByTicker.get(ticker);
    const currency = inst?.preferredListing?.currency || inst?.currency;
    if (!currency || currency === baseCurrency) return;
    pairs.add(`${currency}/${baseCurrency}`);
  });
  return Array.from(pairs.values());
};

export const computeSyncStatus = (params: {
  baseCurrency: Currency;
  holdings: Map<string, number>;
  instruments: Instrument[];
  latestPrices: PricePoint[];
  latestFx: FxRateRow[];
  prices?: PricePoint[];
  fxRates?: FxRateRow[];
  valuationDate?: string;
  today?: string;
}): SyncStatus => {
  const {
    baseCurrency,
    holdings,
    instruments,
    latestPrices,
    latestFx,
    prices = [],
    fxRates = [],
    valuationDate,
    today = new Date().toISOString().slice(0, 10)
  } = params;

  const holdingsTickers = getHoldingsTickers(holdings);
  const latestPriceByTicker = new Map(latestPrices.map(p => [p.ticker, p]));
  const missingTickers = holdingsTickers.filter(t => !latestPriceByTicker.has(t));
  const latestPricesAt = latestPrices.reduce<string | null>((acc, p) => (!acc || p.date > acc ? p.date : acc), null);
  const priceCoverage = { ok: holdingsTickers.length - missingTickers.length, total: holdingsTickers.length };
  const priceStale = latestPricesAt ? diffDaysYmd(today, latestPricesAt) > PRICE_STALE_DAYS : true;
  const latestPricesOk = priceCoverage.total === 0 || (missingTickers.length === 0 && !priceStale);

  const requiredPairs = getFxPairsForHoldings(holdings, instruments, baseCurrency);
  const latestFxByPair = new Map(latestFx.map(row => [`${row.baseCurrency}/${row.quoteCurrency}`, row]));
  const missingPairs = requiredPairs.filter(p => !latestFxByPair.has(p));
  const latestFxAt = latestFx.reduce<string | null>((acc, row) => (!acc || row.date > acc ? row.date : acc), null);
  const fxStale = latestFxAt ? diffDaysYmd(today, latestFxAt) > FX_STALE_DAYS : requiredPairs.length > 0;
  const latestFxOk = requiredPairs.length === 0 || (missingPairs.length === 0 && !fxStale);

  let qualityIssues: RebalanceQualityIssue[] = [];
  const effectiveValuationDate = valuationDate || latestPricesAt || today;
  if (holdingsTickers.length > 0 && instruments.length > 0) {
    const quality = analyzeRebalanceQuality(holdings, instruments, prices, fxRates, effectiveValuationDate, baseCurrency);
    qualityIssues = quality.issues || [];
  }
  const missingPrices = qualityIssues.filter(i => i.type === 'priceMissing').length;
  const missingFx = qualityIssues.filter(i => i.type === 'fxMissing').length;
  const currencyMismatch = qualityIssues.filter(i => i.type === 'currencyMismatch').length;
  const stale = qualityIssues.filter(i => i.type === 'priceStale' || i.type === 'fxStale').length;
  const qualityOk = qualityIssues.length === 0;

  return {
    latestPricesAt,
    latestPricesOk,
    priceCoverage,
    missingTickers,
    latestFxAt,
    latestFxOk,
    missingPairs,
    quality: {
      ok: qualityOk,
      missingPrices,
      missingFx,
      currencyMismatch,
      stale,
      issues: qualityIssues
    }
  };
};
