import { eachDayOfInterval, format } from 'date-fns';
import { BacktestScenarioInput, BacktestResult, BacktestScenarioData } from './backtestTypes';
import { Currency, PricePoint } from '../types';
import { fillMissingPrices } from './priceBackfill';
import { computeTWRRFromNav, calculateAnalytics } from './financeUtils';
import { FxRateRow } from './fxService';
import { isYmd, parseYmdLocal } from './dateUtils';

type FxRateByDate = Map<string, number | null>;

const toDateSafe = (value: string): Date => (isYmd(value) ? parseYmdLocal(value) : new Date(value));

const buildDateIndex = (startDate: string, endDate: string) => {
  const start = toDateSafe(startDate);
  const end = toDateSafe(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];
  return eachDayOfInterval({ start, end }).map(d => format(d, 'yyyy-MM-dd'));
};

const buildFxRateSeries = (
  dateIndex: string[],
  from: Currency,
  to: Currency,
  fxRates: FxRateRow[]
): FxRateByDate => {
  const map: FxRateByDate = new Map();
  if (from === to) {
    dateIndex.forEach(date => map.set(date, 1));
    return map;
  }
  const rows = fxRates
    .filter(row =>
      (row.baseCurrency === from && row.quoteCurrency === to)
      || (row.baseCurrency === to && row.quoteCurrency === from)
    )
    .sort((a, b) => a.date.localeCompare(b.date));

  let lastDirect: FxRateRow | null = null;
  let lastInverse: FxRateRow | null = null;
  let idx = 0;

  dateIndex.forEach(date => {
    while (idx < rows.length && rows[idx].date <= date) {
      const row = rows[idx];
      if (row.baseCurrency === from && row.quoteCurrency === to) lastDirect = row;
      if (row.baseCurrency === to && row.quoteCurrency === from) lastInverse = row;
      idx += 1;
    }
    if (lastDirect) {
      map.set(date, lastDirect.rate);
    } else if (lastInverse) {
      map.set(date, lastInverse.rate > 0 ? (1 / lastInverse.rate) : null);
    } else {
      map.set(date, null);
    }
  });

  return map;
};

const buildPriceSeriesByDate = (
  dateIndex: string[],
  prices: PricePoint[],
  ticker: string
) => {
  const fillResult = fillMissingPrices(prices, dateIndex, { tickers: [ticker] });
  return fillResult.filledByTicker.get(ticker) || new Map();
};

export const runBacktest = (
  scenario: BacktestScenarioInput,
  data: BacktestScenarioData
): BacktestResult => {
  const warnings: string[] = [];
  const errors: string[] = [];
  const effectiveStart = data.quality.effectiveStartDate || scenario.startDate;
  const effectiveEnd = data.quality.effectiveEndDate || scenario.endDate;
  const dateIndex = buildDateIndex(effectiveStart, effectiveEnd);

  if (effectiveEnd < scenario.endDate) {
    warnings.push(`Backtest eseguito fino al ${effectiveEnd} (ultima data disponibile).`);
  }

  if (!dateIndex.length) {
    return {
      effectiveStartDate: effectiveStart,
      effectiveEndDate: effectiveEnd,
      navSeries: [],
      annualReturns: [],
      summary: {
        initialCapital: scenario.initialCapital,
        totalContributions: scenario.initialCapital,
        finalValue: 0,
        totalReturnPct: 0
      },
      warnings: ['Range date non valido.'],
      errors: ['Date non valide o range vuoto.']
    };
  }

  if (!scenario.assets.length) {
    return {
      effectiveStartDate: effectiveStart,
      effectiveEndDate: effectiveEnd,
      navSeries: [],
      annualReturns: [],
      summary: {
        initialCapital: scenario.initialCapital,
        totalContributions: scenario.initialCapital,
        finalValue: 0,
        totalReturnPct: 0
      },
      warnings: ['Nessuno strumento selezionato.'],
      errors: ['Nessuno strumento selezionato.']
    };
  }

  if (!data.quality.canRun) {
    return {
      effectiveStartDate: effectiveStart,
      effectiveEndDate: effectiveEnd,
      navSeries: [],
      annualReturns: [],
      summary: {
        initialCapital: scenario.initialCapital,
        totalContributions: scenario.initialCapital,
        finalValue: 0,
        totalReturnPct: 0
      },
      warnings: data.quality.blockingIssues,
      errors: data.quality.blockingIssues
    };
  }

  const baseCurrency = scenario.baseCurrency;
  const priceSeriesByTicker = new Map<string, Map<string, PricePoint>>();
  const fxSeriesCache = new Map<string, FxRateByDate>();

  scenario.assets.forEach(asset => {
    const series = buildPriceSeriesByDate(dateIndex, data.prices, asset.ticker);
    priceSeriesByTicker.set(asset.ticker, series as Map<string, PricePoint>);
  });

  const getFxSeries = (from: Currency) => {
    const key = `${from}/${baseCurrency}`;
    if (fxSeriesCache.has(key)) return fxSeriesCache.get(key)!;
    const map = buildFxRateSeries(dateIndex, from, baseCurrency, data.fxRates as FxRateRow[]);
    fxSeriesCache.set(key, map);
    return map;
  };

  const priceBaseByTicker = new Map<string, Map<string, number>>();
  const missingPriceAssets = new Set<string>();
  const missingFxAssets = new Set<string>();

  scenario.assets.forEach(asset => {
    const series = priceSeriesByTicker.get(asset.ticker);
    const priceByDate = new Map<string, number>();

    dateIndex.forEach(date => {
      const filled = series?.get(date);
      const price = filled?.close;
      if (!price || price <= 0) {
        missingPriceAssets.add(asset.ticker);
        return;
      }
      const assetCurrency = (filled?.currency || asset.currency || baseCurrency) as Currency;

      if (assetCurrency === baseCurrency) {
        priceByDate.set(date, price);
        return;
      }

      const fxSeries = getFxSeries(assetCurrency);
      const fxRate = fxSeries.get(date);
      if (!fxRate || !Number.isFinite(fxRate)) {
        missingFxAssets.add(asset.ticker);
        return;
      }
      priceByDate.set(date, price * fxRate);
    });

    priceBaseByTicker.set(asset.ticker, priceByDate);
  });

  if (missingPriceAssets.size > 0) {
    errors.push(`Prezzi mancanti per: ${Array.from(missingPriceAssets).join(', ')}`);
  }
  if (missingFxAssets.size > 0) {
    errors.push(`FX mancante per: ${Array.from(missingFxAssets).join(', ')}`);
  }
  if (errors.length) {
    return {
      effectiveStartDate: effectiveStart,
      effectiveEndDate: effectiveEnd,
      navSeries: [],
      annualReturns: [],
      summary: {
        initialCapital: scenario.initialCapital,
        totalContributions: scenario.initialCapital,
        finalValue: 0,
        totalReturnPct: 0
      },
      warnings: errors,
      errors
    };
  }

  const weights = scenario.assets.map(asset => ({
    ticker: asset.ticker,
    weight: Math.max(0, asset.allocationPct) / 100
  }));

  const holdings = new Map<string, number>();
  let contributionCumulative = scenario.initialCapital;
  const externalFlows: { date: string; amount: number }[] = [];

  const startDate = dateIndex[0];
  weights.forEach(asset => {
    const price = priceBaseByTicker.get(asset.ticker)?.get(startDate) || 0;
    if (!price || price <= 0) return;
    const units = (scenario.initialCapital * asset.weight) / price;
    holdings.set(asset.ticker, units);
  });
  if (scenario.initialCapital > 0) {
    externalFlows.push({ date: startDate, amount: scenario.initialCapital });
  }

  const startMonthDay = startDate.slice(5);
  const startYear = Number(startDate.slice(0, 4));

  const navSeries = dateIndex.map(date => {
    const currentYear = Number(date.slice(0, 4));
    const isAnniversary = date.slice(5) === startMonthDay && currentYear > startYear;

    if (isAnniversary && scenario.annualContribution > 0) {
      weights.forEach(asset => {
        const price = priceBaseByTicker.get(asset.ticker)?.get(date) || 0;
        if (!price || price <= 0) return;
        const addUnits = (scenario.annualContribution * asset.weight) / price;
        holdings.set(asset.ticker, (holdings.get(asset.ticker) || 0) + addUnits);
      });
      contributionCumulative += scenario.annualContribution;
      externalFlows.push({ date, amount: scenario.annualContribution });
    }

    if (isAnniversary && scenario.rebalanceFrequency === 'annual') {
      let totalValue = 0;
      weights.forEach(asset => {
        const price = priceBaseByTicker.get(asset.ticker)?.get(date) || 0;
        totalValue += (holdings.get(asset.ticker) || 0) * price;
      });
      if (totalValue > 0) {
        weights.forEach(asset => {
          const price = priceBaseByTicker.get(asset.ticker)?.get(date) || 0;
          if (!price || price <= 0) return;
          const targetUnits = (totalValue * asset.weight) / price;
          holdings.set(asset.ticker, targetUnits);
        });
      }
    }

    let nav = 0;
    weights.forEach(asset => {
      const price = priceBaseByTicker.get(asset.ticker)?.get(date) || 0;
      nav += (holdings.get(asset.ticker) || 0) * price;
    });

    return {
      date,
      nav,
      contributionCumulative
    };
  });

  const perfHistory = navSeries.map(point => ({
    date: point.date,
    value: point.nav,
    invested: point.contributionCumulative || 0,
    monthlyReturnPct: 0,
    cumulativeReturnPct: 0
  }));

  const twrrHistory = computeTWRRFromNav(perfHistory, externalFlows);
  const analytics = calculateAnalytics(twrrHistory, 'daily');

  const drawdownByDate = new Map(analytics.drawdownSeries.map(d => [d.date, d.depth]));
  const navSeriesWithDd = navSeries.map(point => ({
    ...point,
    drawdown: drawdownByDate.get(point.date)
  }));

  const annualReturns = analytics.annualReturns.map(r => ({ year: String(r.year), value: r.returnPct }));
  const bestYear = annualReturns.length ? Math.max(...annualReturns.map(r => r.value)) : undefined;
  const worstYear = annualReturns.length ? Math.min(...annualReturns.map(r => r.value)) : undefined;

  const finalValue = navSeriesWithDd[navSeriesWithDd.length - 1]?.nav || 0;
  const totalContributions = contributionCumulative;
  const totalReturnPct = totalContributions > 0 ? ((finalValue / totalContributions) - 1) * 100 : 0;

  if (analytics.maxDrawdown === 0 && navSeriesWithDd.length > 1) {
    warnings.push('Drawdown non disponibile (serie insufficiente).');
  }

  return {
    effectiveStartDate: effectiveStart,
    effectiveEndDate: effectiveEnd,
    navSeries: navSeriesWithDd,
    annualReturns,
    summary: {
      initialCapital: scenario.initialCapital,
      totalContributions,
      finalValue,
      totalReturnPct,
      cagr: analytics.annualizedReturn,
      volatility: analytics.stdDev,
      maxDrawdown: analytics.maxDrawdown,
      sharpe: analytics.sharpeRatio,
      bestYear,
      worstYear
    },
    warnings
  };
};
