import { eachMonthOfInterval, endOfMonth, format } from 'date-fns';
import { BacktestScenarioInput, BacktestResult, BacktestScenarioData } from './backtestTypes';
import { Currency, PricePoint } from '../types';
import { fillMissingPrices } from './priceBackfill';
import { computeTWRRFromNav, calculateAnalytics } from './financeUtils';
import { FxRateRow } from './fxService';
import { isYmd, parseYmdLocal } from './dateUtils';

type FxRateByDate = Map<string, number | null>;

const toDateSafe = (value: string): Date => (isYmd(value) ? parseYmdLocal(value) : new Date(value));

const buildMonthlyDateIndex = (startDate: string, endDate: string) => {
  const start = toDateSafe(startDate);
  const end = toDateSafe(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];

  const months = eachMonthOfInterval({ start, end });
  const result: string[] = [];

  const pushUnique = (value: string) => {
    if (!result.includes(value)) result.push(value);
  };

  pushUnique(startDate);

  months.forEach(month => {
    const monthEnd = format(endOfMonth(month), 'yyyy-MM-dd');
    if (monthEnd > startDate && monthEnd < endDate) {
      pushUnique(monthEnd);
    }
  });

  pushUnique(endDate);

  return result;
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

const buildPriceSeriesByAsset = (
  dateIndex: string[],
  prices: PricePoint[],
  assetIds: string[]
) => {
  const fillResult = fillMissingPrices(prices, dateIndex, { tickers: assetIds });
  return fillResult.filledByTicker;
};

export const runBacktest = (
  scenario: BacktestScenarioInput,
  data: BacktestScenarioData
): BacktestResult => {
  const warnings: string[] = [];
  const errors: string[] = [];
  const effectiveStart = data.quality.effectiveStartDate || scenario.startDate;
  const effectiveEnd = data.quality.effectiveEndDate || scenario.endDate;
  const dateIndex = buildMonthlyDateIndex(effectiveStart, effectiveEnd);

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
  const seriesByAssetId = new Map<string, PricePoint[]>();
  scenario.assets.forEach(asset => {
    seriesByAssetId.set(asset.id, []);
  });

  data.series.forEach(point => {
    const arr = seriesByAssetId.get(point.assetId) || [];
    arr.push({
      ticker: point.assetId,
      date: point.date,
      close: point.close,
      currency: point.currency as Currency
    });
    seriesByAssetId.set(point.assetId, arr);
  });

  const pricePoints: PricePoint[] = [];
  seriesByAssetId.forEach((rows) => {
    rows.forEach(row => pricePoints.push(row));
  });

  const assetIds = scenario.assets.map(asset => asset.id);
  const priceSeriesByAsset = buildPriceSeriesByAsset(dateIndex, pricePoints, assetIds);
  const fxSeriesCache = new Map<string, FxRateByDate>();

  const getFxSeries = (from: Currency) => {
    const key = `${from}/${baseCurrency}`;
    if (fxSeriesCache.has(key)) return fxSeriesCache.get(key)!;
    const map = buildFxRateSeries(dateIndex, from, baseCurrency, data.fxRates as FxRateRow[]);
    fxSeriesCache.set(key, map);
    return map;
  };

  const priceBaseByAsset = new Map<string, Map<string, number>>();
  const missingPriceAssets = new Set<string>();
  const missingFxAssets = new Set<string>();

  scenario.assets.forEach(asset => {
    const series = priceSeriesByAsset.get(asset.id);
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

    priceBaseByAsset.set(asset.id, priceByDate);
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
    assetId: asset.id,
    ticker: asset.ticker,
    weight: Math.max(0, asset.allocationPct) / 100
  }));

  const holdings = new Map<string, number>();
  let contributionCumulative = scenario.initialCapital;
  const externalFlows: { date: string; amount: number }[] = [];

  const startDate = dateIndex[0];
  weights.forEach(asset => {
    const price = priceBaseByAsset.get(asset.assetId)?.get(startDate) || 0;
    if (!price || price <= 0) return;
    const units = (scenario.initialCapital * asset.weight) / price;
    holdings.set(asset.assetId, units);
  });
  if (scenario.initialCapital > 0) {
    externalFlows.push({ date: startDate, amount: scenario.initialCapital });
  }

  const startMonthKey = startDate.slice(5, 7);
  const startYear = Number(startDate.slice(0, 4));
  const startMonth = Number(startMonthKey);
  let lastRebalanceYear = startYear;

  const contributionAmount = Number.isFinite(scenario.periodicContributionAmount)
    ? scenario.periodicContributionAmount
    : 0;
  const contributionFrequency = scenario.contributionFrequency || 'none';
  const contributionPeriodMonths = (() => {
    switch (contributionFrequency) {
      case 'monthly':
        return 1;
      case 'quarterly':
        return 3;
      case 'semiannual':
        return 6;
      case 'annual':
        return 12;
      default:
        return 0;
    }
  })();
  const contributedMonths = new Set<string>();

  const navSeries = dateIndex.map(date => {
    const currentYear = Number(date.slice(0, 4));
    const currentMonthKey = date.slice(5, 7);
    const currentMonth = Number(currentMonthKey);
    const isAnniversaryMonth = currentYear > startYear && currentMonthKey === startMonthKey;

    if (contributionAmount > 0 && contributionPeriodMonths > 0) {
      const monthKey = date.slice(0, 7);
      const monthsDiff = (currentYear - startYear) * 12 + (currentMonth - startMonth);
      const isAligned = monthsDiff >= 0 && monthsDiff % contributionPeriodMonths === 0;
      const isAnnualFirstMonth = contributionFrequency === 'annual' && monthsDiff === 0;

      if (isAligned && !isAnnualFirstMonth && !contributedMonths.has(monthKey)) {
        weights.forEach(asset => {
          const price = priceBaseByAsset.get(asset.assetId)?.get(date) || 0;
          if (!price || price <= 0) return;
          const addUnits = (contributionAmount * asset.weight) / price;
          holdings.set(asset.assetId, (holdings.get(asset.assetId) || 0) + addUnits);
        });
        contributionCumulative += contributionAmount;
        externalFlows.push({ date, amount: contributionAmount });
        contributedMonths.add(monthKey);
      }
    }

    if (isAnniversaryMonth && scenario.rebalanceFrequency === 'annual' && currentYear !== lastRebalanceYear) {
      let totalValue = 0;
      weights.forEach(asset => {
        const price = priceBaseByAsset.get(asset.assetId)?.get(date) || 0;
        totalValue += (holdings.get(asset.assetId) || 0) * price;
      });
      if (totalValue > 0) {
        weights.forEach(asset => {
          const price = priceBaseByAsset.get(asset.assetId)?.get(date) || 0;
          if (!price || price <= 0) return;
          const targetUnits = (totalValue * asset.weight) / price;
          holdings.set(asset.assetId, targetUnits);
        });
      }
      lastRebalanceYear = currentYear;
    }

    let nav = 0;
    weights.forEach(asset => {
      const price = priceBaseByAsset.get(asset.assetId)?.get(date) || 0;
      nav += (holdings.get(asset.assetId) || 0) * price;
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
  const analytics = calculateAnalytics(twrrHistory, 'monthly');

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
