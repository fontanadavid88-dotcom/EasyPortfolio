import { BacktestScenarioInput, BacktestScenarioData, BacktestDataQualitySummary, BacktestAssetQualityStatus } from './backtestTypes';
import { Currency, PricePoint } from '../types';
import { queryPricesForTickersRange, queryFxForPairsRange } from './dbQueries';

const buildEmptyQuality = (assetsCount = 0): BacktestDataQualitySummary => ({
  total: assetsCount,
  ok: 0,
  partial: 0,
  missing: 0,
  fxMissing: 0,
  messages: [],
  blockingIssues: [],
  byTicker: {},
  canRun: false
});

export const buildBacktestScenarioDataKey = (scenario: BacktestScenarioInput): string => {
  const tickers = scenario.assets.map(a => a.ticker).sort().join(',');
  return `${scenario.startDate}|${scenario.endDate}|${scenario.baseCurrency}|${tickers}`;
};

const toDateString = (value?: string): string => (value || '').slice(0, 10);

const getFxPairKey = (from: Currency, to: Currency) => `${from}/${to}`;

export const loadBacktestScenarioData = async (
  scenario: BacktestScenarioInput,
  portfolioId: string
): Promise<BacktestScenarioData> => {
  const key = buildBacktestScenarioDataKey(scenario);
  const startDate = toDateString(scenario.startDate);
  const endDate = toDateString(scenario.endDate);
  const baseCurrency = scenario.baseCurrency;
  const tickers = Array.from(new Set(scenario.assets.map(a => a.ticker).filter(Boolean)));

  if (!tickers.length || !startDate || !endDate) {
    return { key, prices: [], fxRates: [], quality: buildEmptyQuality(tickers.length) };
  }

  const prices = await queryPricesForTickersRange({
    portfolioId,
    tickers,
    startDate,
    endDate,
    lookbackDays: 365
  });

  const fxPairs = Array.from(
    new Set(
      scenario.assets
        .map(asset => asset.currency)
        .filter((curr): curr is Currency => Boolean(curr))
        .filter(curr => curr !== baseCurrency)
        .map(curr => getFxPairKey(curr, baseCurrency))
    )
  );

  const fxRates = fxPairs.length
    ? await queryFxForPairsRange({
      pairs: fxPairs,
      startDate,
      endDate,
      lookbackDays: 365
    })
    : [];

  const quality: BacktestDataQualitySummary = buildEmptyQuality(tickers.length);
  const byTicker: Record<string, { ticker: string; status: BacktestAssetQualityStatus; message?: string; priceStart?: string; priceEnd?: string; priceCount?: number; currency?: Currency }> = {};

  let partialCount = 0;
  let missingCount = 0;
  let okCount = 0;
  let fxMissingCount = 0;
  let commonAvailableStart: string | undefined;
  let commonAvailableEnd: string | undefined;

  tickers.forEach(ticker => {
    const asset = scenario.assets.find(a => a.ticker === ticker);
    const rows = prices.filter(p => p.ticker === ticker);
    const count = rows.length;
    const minDate = rows.reduce((min, p) => (!min || p.date < min ? p.date : min), '');
    const maxDate = rows.reduce((max, p) => (!max || p.date > max ? p.date : max), '');

    let status: BacktestAssetQualityStatus = 'OK';
    let message: string | undefined;

    if (count === 0 || !minDate || !maxDate || maxDate < startDate || minDate > endDate) {
      status = 'MISSING';
      message = 'Storico assente';
      missingCount += 1;
    } else {
      const assetAvailableStart = minDate <= startDate ? startDate : minDate;
      const assetAvailableEnd = maxDate >= endDate ? endDate : maxDate;
      commonAvailableStart = !commonAvailableStart || assetAvailableStart > commonAvailableStart ? assetAvailableStart : commonAvailableStart;
      commonAvailableEnd = !commonAvailableEnd || assetAvailableEnd < commonAvailableEnd ? assetAvailableEnd : commonAvailableEnd;

      if (minDate > startDate || maxDate < endDate) {
        status = 'PARTIAL';
        message = `Storico parziale (${minDate || 'N/D'} → ${maxDate || 'N/D'})`;
        partialCount += 1;
      } else {
        okCount += 1;
      }
    }

    const assetCurrency = asset?.currency;
    if (assetCurrency && assetCurrency !== baseCurrency) {
      const directPair = fxRates.filter(row =>
        (row.baseCurrency === assetCurrency && row.quoteCurrency === baseCurrency)
        || (row.baseCurrency === baseCurrency && row.quoteCurrency === assetCurrency)
      );
      const minFxDate = directPair.reduce((min, r) => (!min || r.date < min ? r.date : min), '');
      if (!directPair.length || !minFxDate) {
        status = 'FX_MISSING';
        message = `FX mancante ${assetCurrency}→${baseCurrency}`;
        fxMissingCount += 1;
      } else {
        const fxAvailableStart = minFxDate <= startDate ? startDate : minFxDate;
        if (minFxDate > startDate) {
          status = 'FX_MISSING';
          message = `FX disponibile solo dal ${minFxDate}`;
          fxMissingCount += 1;
        }
        commonAvailableStart = !commonAvailableStart || fxAvailableStart > commonAvailableStart ? fxAvailableStart : commonAvailableStart;
      }
    }

    byTicker[ticker] = {
      ticker,
      status,
      message,
      priceStart: minDate || undefined,
      priceEnd: maxDate || undefined,
      priceCount: count,
      currency: asset?.currency
    };
  });

  quality.total = tickers.length;
  quality.ok = okCount;
  quality.partial = partialCount;
  quality.missing = missingCount;
  quality.fxMissing = fxMissingCount;
  quality.byTicker = byTicker;
  quality.requestedStartDate = startDate;
  quality.requestedEndDate = endDate;
  quality.availableStartDate = commonAvailableStart;
  quality.availableEndDate = commonAvailableEnd;

  const effectiveStartDate = commonAvailableStart && commonAvailableStart > startDate ? commonAvailableStart : startDate;
  const effectiveEndDate = commonAvailableEnd && commonAvailableEnd < endDate ? commonAvailableEnd : endDate;

  quality.effectiveStartDate = effectiveStartDate;
  quality.effectiveEndDate = effectiveEndDate;

  if (quality.total > 0) {
    quality.messages.push(`${quality.ok}/${quality.total} strumenti con storico valido`);
  }
  if (partialCount > 0) {
    quality.messages.push(`${partialCount} strumento${partialCount > 1 ? 'i' : ''} con storico parziale`);
  }
  if (missingCount > 0) {
    quality.messages.push(`${missingCount} strumento${missingCount > 1 ? 'i' : ''} senza storico nel range`);
  }
  if (fxMissingCount > 0) {
    quality.messages.push(`FX mancante per ${fxMissingCount} strumento${fxMissingCount > 1 ? 'i' : ''}`);
  }

  if (missingCount > 0) quality.blockingIssues.push('Storico prezzi mancante per alcuni strumenti.');
  if (fxMissingCount > 0) quality.blockingIssues.push('FX mancante per alcuni strumenti.');
  if (!commonAvailableStart || !commonAvailableEnd || commonAvailableStart > commonAvailableEnd) {
    quality.blockingIssues.push('Nessuna finestra utile comune tra gli strumenti.');
  }
  if (commonAvailableStart && commonAvailableStart > startDate) {
    quality.blockingIssues.push(`Copertura iniziale insufficiente (dati disponibili dal ${commonAvailableStart}).`);
  }

  const hasCommonWindow = Boolean(commonAvailableStart)
    && Boolean(commonAvailableEnd)
    && effectiveStartDate <= effectiveEndDate;
  const hasStartCoverage = commonAvailableStart ? commonAvailableStart <= startDate : false;

  quality.canRun = quality.blockingIssues.length === 0
    && hasCommonWindow
    && hasStartCoverage;

  if (!quality.canRun) {
    quality.status = missingCount > 0 ? 'missing' : 'partial-blocking';
  } else if (effectiveEndDate < endDate) {
    quality.status = 'partial-runnable';
  } else {
    quality.status = 'full';
  }

  if (!quality.canRun) {
    quality.blockingReason = quality.blockingIssues[0] || 'Dati insufficienti per il backtest.';
  } else if (effectiveEndDate < endDate) {
    quality.warningMessage = `Storico disponibile fino al ${effectiveEndDate}`;
  }

  if (import.meta.env?.DEV) {
    console.log('[BACKTEST][QUALITY]', {
      requestedStartDate: startDate,
      requestedEndDate: endDate,
      availableStartDate: quality.availableStartDate,
      availableEndDate: quality.availableEndDate,
      effectiveStartDate: quality.effectiveStartDate,
      effectiveEndDate: quality.effectiveEndDate
    });
  }

  return {
    key,
    prices: prices as PricePoint[],
    fxRates,
    quality
  };
};
