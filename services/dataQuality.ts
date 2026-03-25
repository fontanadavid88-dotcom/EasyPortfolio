import { AssetClass, AssetType, Currency, Instrument, PricePoint } from '../types';
import { FxRateRow, resolveFxRateFromSeries } from './fxService';
import { diffDaysYmd } from './dateUtils';
import { FX_STALE_DAYS, PRICE_GAP_DAYS, PRICE_STALE_DAYS } from './constants';

export type SeriesIssueType =
  | 'duplicate'
  | 'gap'
  | 'outlier'
  | 'nonMonotone'
  | 'invalid'
  | 'currencyMismatch';

export type IssueSeverity = 'warning' | 'error';

export type SeriesIssue = {
  type: SeriesIssueType;
  message: string;
  date?: string;
  severity?: IssueSeverity;
};

export type SeriesStats = {
  startDate?: string;
  endDate?: string;
  count: number;
  currency?: Currency | string;
  duplicates: number;
  gaps: number;
  outliers: number;
  invalid: number;
  nonMonotone: number;
};

const isValidDateString = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

const computeDailyReturns = (points: PricePoint[]) => {
  const returns: { date: string; value: number }[] = [];
  let prevValid: PricePoint | null = null;
  points.forEach(p => {
    if (!p.date || !isValidDateString(p.date)) return;
    if (!Number.isFinite(p.close) || p.close <= 0) return;
    if (prevValid && Number.isFinite(prevValid.close) && prevValid.close > 0) {
      returns.push({ date: p.date, value: (p.close / prevValid.close) - 1 });
    }
    prevValid = p;
  });
  return returns;
};

const getOutlierThresholds = (
  assetClass?: AssetClass,
  assetType?: AssetType,
  fallbackWarning = 0.2
): { warning: number; error: number } => {
  if (assetClass === AssetClass.CRYPTO || assetType === AssetType.Crypto) {
    return { warning: 2, error: 10 };
  }
  if (assetClass === AssetClass.BOND || assetClass === AssetClass.ETF_BOND || assetType === AssetType.Bond) {
    return { warning: 0.05, error: 0.15 };
  }
  if (assetClass === AssetClass.STOCK || assetClass === AssetClass.ETF_STOCK || assetType === AssetType.Stock || assetType === AssetType.ETF) {
    return { warning: 0.3, error: 0.8 };
  }
  const fallbackError = Math.max(fallbackWarning * 4, 0.8);
  return { warning: fallbackWarning, error: fallbackError };
};

export const analyzePriceSeries = (
  points: PricePoint[],
  options?: {
    gapDays?: number;
    outlierThreshold?: number;
    assetClass?: AssetClass;
    assetType?: AssetType;
  }
): { stats: SeriesStats; issues: SeriesIssue[] } => {
  const isCrypto = options?.assetClass === AssetClass.CRYPTO || options?.assetType === AssetType.Crypto;
  const gapDays = options?.gapDays ?? (isCrypto ? 1 : PRICE_GAP_DAYS);
  const outlierThreshold = options?.outlierThreshold ?? 0.2;
  const thresholds = getOutlierThresholds(options?.assetClass, options?.assetType, outlierThreshold);
  const sorted = [...points].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const issues: SeriesIssue[] = [];
  const dateSet = new Set<string>();
  let duplicates = 0;
  let gaps = 0;
  let outliers = 0;
  let invalid = 0;
  let nonMonotone = 0;
  let prevDate: string | null = null;
  const currencySet = new Set<string>();

  sorted.forEach(p => {
    if (!p.date || !isValidDateString(p.date)) {
      invalid++;
      issues.push({ type: 'invalid', message: 'Data non valida', date: p.date, severity: 'error' });
      return;
    }
    if (dateSet.has(p.date)) {
      duplicates++;
      issues.push({ type: 'duplicate', message: 'Data duplicata', date: p.date, severity: 'warning' });
    }
    dateSet.add(p.date);
    if (p.currency) {
      currencySet.add(String(p.currency));
    }

    if (prevDate) {
      if (p.date < prevDate) {
        nonMonotone++;
        issues.push({ type: 'nonMonotone', message: 'Date non monotone', date: p.date, severity: 'warning' });
      }
      const gap = diffDaysYmd(p.date, prevDate);
      if (gap > gapDays) {
        gaps++;
        issues.push({ type: 'gap', message: `Gap di ${gap} giorni`, date: p.date, severity: 'warning' });
      }
    }
    if (!Number.isFinite(p.close) || p.close <= 0) {
      invalid++;
      issues.push({ type: 'invalid', message: 'Close non valido', date: p.date, severity: 'error' });
    }
    prevDate = p.date;
  });

  const returns = computeDailyReturns(sorted);
  returns.forEach(r => {
    const absRet = Math.abs(r.value);
    if (absRet > thresholds.warning) {
      outliers++;
      const severity: IssueSeverity = absRet > thresholds.error ? 'error' : 'warning';
      const pct = Math.round(r.value * 100);
      issues.push({ type: 'outlier', message: `Outlier ${pct}%`, date: r.date, severity });
    }
  });

  if (currencySet.size > 1) {
    issues.push({ type: 'currencyMismatch', message: 'Currency mismatch nella serie', severity: 'warning' });
  }

  const stats: SeriesStats = {
    startDate: sorted[0]?.date,
    endDate: sorted[sorted.length - 1]?.date,
    count: sorted.length,
    currency: sorted[0]?.currency,
    duplicates,
    gaps,
    outliers,
    invalid,
    nonMonotone
  };

  return { stats, issues };
};

export type FxRatePoint = {
  baseCurrency: Currency;
  quoteCurrency: Currency;
  date: string;
  rate: number;
};

export const analyzeFxSeries = (
  points: FxRatePoint[],
  gapDays = PRICE_GAP_DAYS,
  outlierThreshold = 0.2
): { stats: SeriesStats; issues: SeriesIssue[] } => {
  const mapped: PricePoint[] = points.map(p => ({
    ticker: `${p.baseCurrency}/${p.quoteCurrency}`,
    date: p.date,
    close: p.rate,
    currency: p.baseCurrency
  }));
  return analyzePriceSeries(mapped, { gapDays, outlierThreshold });
};

export type RebalanceQualityIssueType =
  | 'priceMissing'
  | 'priceStale'
  | 'fxMissing'
  | 'fxStale'
  | 'currencyMismatch';

export type RebalanceAssetStatus = 'OK' | 'STALE' | 'MISMATCH' | 'UNVALUED';

export type RebalanceQualityIssue = {
  ticker: string;
  type: RebalanceQualityIssueType;
  message: string;
  blocking: boolean;
  valuationDate?: string;
  priceTicker?: string;
  priceDate?: string;
  priceCurrency?: Currency;
  instrumentCurrency?: Currency;
  fxBase?: Currency;
  fxQuote?: Currency;
  fxDate?: string;
};

export type RebalanceQualitySummary = {
  issues: RebalanceQualityIssue[];
  issuesByTicker: Record<string, RebalanceQualityIssue[]>;
  statusByTicker: Record<string, RebalanceAssetStatus>;
};

export type IssueHelp = {
  title: string;
  description: string;
  ctaLabel: string;
  href: string;
};

const buildDataInspectorHref = (params: Record<string, string | undefined>) => {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (!value) return;
    search.set(key, value);
  });
  const query = search.toString();
  return `#/data${query ? `?${query}` : ''}`;
};

export const getIssueHelp = (issue: RebalanceQualityIssue): IssueHelp => {
  const date = issue.valuationDate || issue.priceDate || issue.fxDate || '';
  if (issue.type === 'fxMissing') {
    const base = issue.fxBase || Currency.USD;
    const quote = issue.fxQuote || Currency.CHF;
    return {
      title: 'FX mancante',
      description: `Manca il cambio ${base}->${quote} per ${date || 'la data richiesta'}. Importa i tassi FX.`,
      ctaLabel: 'Apri Data Inspector (FX)',
      href: buildDataInspectorHref({ tab: 'fx', base, quote, date })
    };
  }
  if (issue.type === 'fxStale') {
    const base = issue.fxBase || Currency.USD;
    const quote = issue.fxQuote || Currency.CHF;
    return {
      title: 'FX stale',
      description: `Ultimo FX ${base}->${quote} al ${issue.fxDate || 'N/D'}. Aggiorna i tassi.`,
      ctaLabel: 'Apri Data Inspector (FX)',
      href: buildDataInspectorHref({ tab: 'fx', base, quote, date })
    };
  }
  if (issue.type === 'priceMissing') {
    const priceTicker = issue.priceTicker || issue.ticker;
    return {
      title: 'Prezzo mancante',
      description: `Manca un prezzo per ${priceTicker} alla valuation date ${date || 'N/D'}. Importa i prezzi.`,
      ctaLabel: 'Apri Data Inspector (Prezzi)',
      href: buildDataInspectorHref({ tab: 'prices', ticker: priceTicker, date })
    };
  }
  if (issue.type === 'priceStale') {
    const priceTicker = issue.priceTicker || issue.ticker;
    return {
      title: 'Prezzo stale',
      description: `Ultimo prezzo al ${issue.priceDate || 'N/D'} (valuation ${date || 'N/D'}). Aggiorna i prezzi.`,
      ctaLabel: 'Apri Data Inspector (Prezzi)',
      href: buildDataInspectorHref({ tab: 'prices', ticker: priceTicker, date })
    };
  }
  const priceTicker = issue.priceTicker || issue.ticker;
  return {
    title: 'Valuta incoerente',
    description: `Prezzo in ${issue.priceCurrency || 'N/D'} ma strumento in ${issue.instrumentCurrency || 'N/D'}. Reimporta lo storico con la valuta corretta.`,
    ctaLabel: 'Apri Data Inspector (Prezzi)',
    href: buildDataInspectorHref({ tab: 'prices', ticker: priceTicker, date })
  };
};

export const analyzeRebalanceQuality = (
  holdings: Map<string, number>,
  instruments: Instrument[],
  prices: PricePoint[],
  fxRates: FxRatePoint[],
  valuationDate: string,
  baseCurrency: Currency,
  staleDays = PRICE_STALE_DAYS
): RebalanceQualitySummary => {
  const issues: RebalanceQualityIssue[] = [];
  const fxStaleDays = FX_STALE_DAYS;
  const instByTicker = new Map<string, Instrument>();
  instruments.forEach(instr => {
    const key = instr.symbol || instr.ticker;
    if (key) instByTicker.set(key, instr);
    if (instr.ticker) instByTicker.set(instr.ticker, instr);
  });
  const fxSeries: FxRateRow[] = fxRates;
  const statusByTicker: Record<string, RebalanceAssetStatus> = {};

  const resolvePriceTicker = (ticker: string, instrument?: Instrument) => {
    if (instrument?.preferredListing?.symbol) return instrument.preferredListing.symbol;
    if (instrument?.symbol) return instrument.symbol;
    if (instrument?.ticker) return instrument.ticker;
    return ticker;
  };

  const findPricePoint = (ticker: string): PricePoint | null => {
    let latest: PricePoint | null = null;
    prices.forEach(p => {
      if (p.ticker !== ticker) return;
      if (p.date > valuationDate) return;
      if (!latest || p.date > latest.date) latest = p;
    });
    return latest;
  };

  holdings.forEach((qty, ticker) => {
    if (qty <= 0.000001) return;
    const instr = instByTicker.get(ticker);
    const priceTicker = resolvePriceTicker(ticker, instr);
    const pricePoint = findPricePoint(priceTicker);
    let hasPriceMissing = false;
    let hasFxMissing = false;
    let hasMismatch = false;
    let hasStale = false;

    if (!pricePoint) {
      hasPriceMissing = true;
      issues.push({
        ticker,
        type: 'priceMissing',
        message: 'Prezzo mancante alla valuation date',
        blocking: true,
        valuationDate,
        priceTicker
      });
      statusByTicker[ticker] = 'UNVALUED';
      return;
    }
    const priceCurrency = pricePoint.currency || instr?.currency;
    if (instr?.currency && priceCurrency && instr.currency !== priceCurrency) {
      hasMismatch = true;
      issues.push({
        ticker,
        type: 'currencyMismatch',
        message: `Currency mismatch: prezzo ${priceCurrency} vs strumento ${instr.currency}`,
        blocking: false,
        valuationDate,
        priceTicker,
        priceCurrency,
        instrumentCurrency: instr.currency
      });
    }
    const priceAge = diffDaysYmd(valuationDate, pricePoint.date);
    if (priceAge > staleDays) {
      hasStale = true;
      issues.push({
        ticker,
        type: 'priceStale',
        message: `Prezzo stale (${priceAge} giorni)`,
        blocking: false,
        valuationDate,
        priceTicker,
        priceDate: pricePoint.date,
        priceCurrency
      });
    }
    if (priceCurrency && priceCurrency !== baseCurrency) {
      const fxLookup = resolveFxRateFromSeries(fxSeries, priceCurrency, baseCurrency, valuationDate);
      if (!fxLookup) {
        hasFxMissing = true;
        issues.push({
          ticker,
          type: 'fxMissing',
          message: `FX mancante ${priceCurrency}->${baseCurrency} al ${valuationDate}`,
          blocking: true,
          valuationDate,
          priceTicker,
          fxBase: priceCurrency,
          fxQuote: baseCurrency
        });
      } else {
        const fxAge = diffDaysYmd(valuationDate, fxLookup.date);
        if (fxAge > fxStaleDays) {
          hasStale = true;
          issues.push({
            ticker,
            type: 'fxStale',
            message: `FX stale (${fxAge} giorni)`,
            blocking: false,
            valuationDate,
            priceTicker,
            fxBase: priceCurrency,
            fxQuote: baseCurrency,
            fxDate: fxLookup.date
          });
        }
      }
    }

    if (hasPriceMissing || hasFxMissing) {
      statusByTicker[ticker] = 'UNVALUED';
    } else if (hasMismatch) {
      statusByTicker[ticker] = 'MISMATCH';
    } else if (hasStale) {
      statusByTicker[ticker] = 'STALE';
    } else {
      statusByTicker[ticker] = 'OK';
    }
  });

  const issuesByTicker: Record<string, RebalanceQualityIssue[]> = {};
  issues.forEach(issue => {
    const list = issuesByTicker[issue.ticker] || [];
    list.push(issue);
    issuesByTicker[issue.ticker] = list;
  });

  return { issues, issuesByTicker, statusByTicker };
};
