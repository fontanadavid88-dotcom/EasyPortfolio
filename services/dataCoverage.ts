import { Currency, Instrument, PricePoint } from '../types';
import { FxRateRow } from './fxService';
import { getCanonicalTicker } from './financeUtils';

export type CoverageTickerDetail = {
  ticker: string;
  canonical: string;
  currency?: Currency;
  priceDate?: string;
  fxPair?: string;
  fxDate?: string;
  fxSourcePair?: string;
  fxInverseUsed?: boolean;
  effectiveDate?: string;
  needsFx: boolean;
};

export type CoverageSummary = {
  price: {
    latest?: string;
    common?: string;
    total: number;
    missingTickers: string[];
    byTicker: Record<string, string>;
  };
  fx: {
    latest?: string;
    common?: string;
    needed: boolean;
    requiredPairs: string[];
    missingPairs: string[];
    byPair: Record<string, { date?: string; sourcePair?: string; inverseUsed?: boolean }>;
  };
  effective: {
    latest?: string;
    limiting?: { type: 'price' | 'fx'; key: string; date: string };
    byTicker: Record<string, CoverageTickerDetail>;
  };
  fxUsed: {
    status: 'ok' | 'not-needed' | 'missing' | 'unknown';
    date?: string;
    reason?: string;
  };
};

const toYmd = (value?: string): string => (value || '').slice(0, 10);

const maxDate = (a?: string, b?: string) => {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
};

const minDate = (a?: string, b?: string) => {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
};

const buildInstrumentIndex = (instruments: Instrument[]) => {
  const map = new Map<string, Instrument>();
  instruments.forEach(inst => {
    if (inst.ticker) map.set(inst.ticker, inst);
    if (inst.symbol) map.set(inst.symbol, inst);
    if (inst.preferredListing?.symbol) map.set(inst.preferredListing.symbol, inst);
    (inst.listings || []).forEach(listing => {
      if (listing.symbol) map.set(listing.symbol, inst);
    });
  });
  return map;
};

export const buildLatestPriceMap = (prices: PricePoint[]): Map<string, string> => {
  const map = new Map<string, string>();
  prices.forEach(row => {
    if (!row?.ticker || !row?.date) return;
    const date = toYmd(row.date);
    const prev = map.get(row.ticker);
    if (!prev || date > prev) map.set(row.ticker, date);
  });
  return map;
};

export const buildLatestFxMap = (fxRates: FxRateRow[]): Map<string, string> => {
  const map = new Map<string, string>();
  fxRates.forEach(row => {
    if (!row?.baseCurrency || !row?.quoteCurrency || !row?.date) return;
    const pair = `${row.baseCurrency}/${row.quoteCurrency}`;
    const date = toYmd(row.date);
    const prev = map.get(pair);
    if (!prev || date > prev) map.set(pair, date);
  });
  return map;
};

const resolveFxDate = (pair: string, latestByPair: Map<string, string>) => {
  const direct = latestByPair.get(pair);
  if (direct) return { date: direct, sourcePair: pair, inverseUsed: false };
  const [base, quote] = pair.split('/');
  if (!base || !quote) return { date: undefined, sourcePair: undefined, inverseUsed: false };
  const inverse = `${quote}/${base}`;
  const inverseDate = latestByPair.get(inverse);
  if (inverseDate) return { date: inverseDate, sourcePair: inverse, inverseUsed: true };
  return { date: undefined, sourcePair: undefined, inverseUsed: false };
};

export const computeFxCoverageForPairs = (pairs: string[], latestFx: FxRateRow[]) => {
  const latestByPair = buildLatestFxMap(latestFx || []);
  const byPair: CoverageSummary['fx']['byPair'] = {};
  const missingPairs: string[] = [];
  let latest: string | undefined;
  let common: string | undefined;

  pairs.forEach(pair => {
    const resolved = resolveFxDate(pair, latestByPair);
    if (resolved.date) {
      latest = maxDate(latest, resolved.date);
      common = minDate(common, resolved.date);
    } else {
      missingPairs.push(pair);
    }
    byPair[pair] = { date: resolved.date, sourcePair: resolved.sourcePair, inverseUsed: resolved.inverseUsed };
  });

  return {
    latest,
    common,
    needed: pairs.length > 0,
    requiredPairs: pairs,
    missingPairs,
    byPair
  };
};

export const computePortfolioCoverage = (params: {
  holdings: Map<string, number>;
  instruments: Instrument[];
  baseCurrency: Currency;
  latestPrices: PricePoint[];
  latestFx: FxRateRow[];
}): CoverageSummary => {
  const { holdings, instruments, baseCurrency, latestPrices, latestFx } = params;
  const instrumentByTicker = buildInstrumentIndex(instruments || []);
  const latestPriceMap = buildLatestPriceMap(latestPrices || []);
  const latestFxMap = buildLatestFxMap(latestFx || []);

  const byTicker: Record<string, CoverageTickerDetail> = {};
  const priceByTicker: Record<string, string> = {};
  const missingTickers: string[] = [];
  const requiredPairs = new Set<string>();

  let priceLatest: string | undefined;
  let priceCommon: string | undefined;
  let effectiveLatest: string | undefined;
  let limiting: CoverageSummary['effective']['limiting'] | undefined;

  holdings.forEach((qty, ticker) => {
    if (!ticker || qty <= 0.000001) return;
    const inst = instrumentByTicker.get(ticker);
    const canonical = inst ? (getCanonicalTicker(inst) || inst.ticker || ticker) : ticker;
    const priceDate = latestPriceMap.get(canonical) || latestPriceMap.get(ticker);
    const currency = inst?.preferredListing?.currency || inst?.currency;
    const needsFx = Boolean(currency && currency !== baseCurrency);
    const fxPair = needsFx && currency ? `${currency}/${baseCurrency}` : undefined;
    const fxResolved = fxPair ? resolveFxDate(fxPair, latestFxMap) : { date: undefined, sourcePair: undefined, inverseUsed: false };
    if (fxPair) requiredPairs.add(fxPair);

    if (!priceDate) missingTickers.push(canonical);
    if (priceDate) {
      priceByTicker[canonical] = priceDate;
      priceLatest = maxDate(priceLatest, priceDate);
      priceCommon = minDate(priceCommon, priceDate);
    }

    let effectiveDate: string | undefined;
    if (priceDate && (!needsFx || fxResolved.date)) {
      effectiveDate = needsFx ? minDate(priceDate, fxResolved.date) : priceDate;
      if (effectiveDate) {
        effectiveLatest = minDate(effectiveLatest, effectiveDate);
        if (!limiting || effectiveDate < limiting.date) {
          limiting = {
            type: needsFx && fxResolved.date && fxResolved.date < priceDate ? 'fx' : 'price',
            key: needsFx && fxResolved.date && fxResolved.date < priceDate ? (fxPair || canonical) : canonical,
            date: effectiveDate
          };
        }
      }
    }

    byTicker[canonical] = {
      ticker,
      canonical,
      currency,
      priceDate,
      fxPair,
      fxDate: fxResolved.date,
      fxSourcePair: fxResolved.sourcePair,
      fxInverseUsed: fxResolved.inverseUsed,
      effectiveDate,
      needsFx
    };
  });

  const fxCoverage = computeFxCoverageForPairs(Array.from(requiredPairs.values()), latestFx || []);

  const fxUsed = (() => {
    if (!fxCoverage.needed) return { status: 'not-needed' as const, reason: 'FX non richiesto' };
    if (fxCoverage.missingPairs.length > 0) {
      return {
        status: 'missing' as const,
        reason: `FX mancante (${fxCoverage.missingPairs.slice(0, 2).join(', ')}${fxCoverage.missingPairs.length > 2 ? '...' : ''})`
      };
    }
    if (effectiveLatest) return { status: 'ok' as const, date: effectiveLatest };
    return { status: 'unknown' as const, reason: 'FX usato non determinabile' };
  })();

  return {
    price: {
      latest: priceLatest,
      common: priceCommon,
      total: Array.from(holdings.keys()).filter(k => (holdings.get(k) || 0) > 0.000001).length,
      missingTickers,
      byTicker: priceByTicker
    },
    fx: fxCoverage,
    effective: {
      latest: effectiveLatest,
      limiting,
      byTicker
    },
    fxUsed
  };
};
