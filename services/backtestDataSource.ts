import { BacktestScenarioInput, BacktestScenarioData, BacktestDataQualitySummary, BacktestAssetQualityStatus, BacktestSourceSeriesPoint, BacktestAssetInput, BacktestAssetQuality } from './backtestTypes';
import { Currency } from '../types';
import { queryPricesForTickersRange, queryFxForPairsRange } from './dbQueries';
import { getBacktestImportPricesByImportIds } from './backtestImportRepository';

const buildEmptyQuality = (assetsCount = 0): BacktestDataQualitySummary => ({
  total: assetsCount,
  ok: 0,
  partial: 0,
  missing: 0,
  fxMissing: 0,
  messages: [],
  blockingIssues: [],
  byAssetId: {},
  canRun: false
});

export const buildBacktestScenarioDataKey = (scenario: BacktestScenarioInput): string => {
  const assetKey = scenario.assets
    .map(a => `${a.source}:${a.ticker}:${a.importId ?? ''}`)
    .sort()
    .join(',');
  return `${scenario.startDate}|${scenario.endDate}|${scenario.baseCurrency}|${assetKey}`;
};

const toDateString = (value?: string): string => (value || '').slice(0, 10);

const getFxPairKey = (from: Currency, to: Currency) => `${from}/${to}`;

const normalizeAssetSeries = (rows: Array<{ date: string; close: number; currency?: Currency }>, asset: BacktestAssetInput): BacktestSourceSeriesPoint[] => {
  const map = new Map<string, BacktestSourceSeriesPoint>();
  rows.forEach(row => {
    const date = toDateString(row.date);
    const close = Number(row.close);
    if (!date || !Number.isFinite(close) || close <= 0) return;
    map.set(date, {
      assetId: asset.id,
      date,
      close,
      currency: (row.currency || asset.currency) as Currency,
      source: asset.source,
      ticker: asset.ticker,
      importId: asset.importId
    });
  });
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
};

const getSeriesBounds = (rows: BacktestSourceSeriesPoint[]) => {
  let minDate = '';
  let maxDate = '';
  rows.forEach(row => {
    if (!minDate || row.date < minDate) minDate = row.date;
    if (!maxDate || row.date > maxDate) maxDate = row.date;
  });
  return { minDate, maxDate, count: rows.length };
};

const getFxBounds = (from: Currency, to: Currency, fxRates: Array<{ baseCurrency: Currency; quoteCurrency: Currency; date: string }>) => {
  let minDate = '';
  let maxDate = '';
  fxRates.forEach(row => {
    if (!row?.date) return;
    const date = toDateString(row.date);
    const matches = (row.baseCurrency === from && row.quoteCurrency === to)
      || (row.baseCurrency === to && row.quoteCurrency === from);
    if (!matches || !date) return;
    if (!minDate || date < minDate) minDate = date;
    if (!maxDate || date > maxDate) maxDate = date;
  });
  return { minDate, maxDate };
};

export const loadBacktestScenarioData = async (
  scenario: BacktestScenarioInput,
  portfolioId: string
): Promise<BacktestScenarioData> => {
  const key = buildBacktestScenarioDataKey(scenario);
  const startDate = toDateString(scenario.startDate);
  const endDate = toDateString(scenario.endDate);
  const baseCurrency = scenario.baseCurrency;

  if (!scenario.assets.length || !startDate || !endDate) {
    return { key, series: [], fxRates: [], quality: buildEmptyQuality(scenario.assets.length) };
  }

  const appAssets = scenario.assets.filter(a => a.source === 'APP_DB');
  const csvAssets = scenario.assets.filter(a => a.source === 'CSV_IMPORT');

  const tickers = Array.from(new Set(appAssets.map(a => a.ticker).filter(Boolean)));
  const importIds = Array.from(new Set(csvAssets.map(a => a.importId).filter((id): id is number => Boolean(id))));

  const [prices, csvPrices] = await Promise.all([
    tickers.length
      ? queryPricesForTickersRange({
        portfolioId,
        tickers,
        startDate,
        endDate,
        lookbackDays: 365
      })
      : Promise.resolve([]),
    importIds.length
      ? getBacktestImportPricesByImportIds({
        importIds,
        startDate,
        endDate,
        lookbackDays: 365
      })
      : Promise.resolve([])
  ]);

  const fxPairs = new Set<string>();
  scenario.assets.forEach(asset => {
    const curr = asset.currency as Currency | undefined;
    if (!curr || curr === baseCurrency) return;
    fxPairs.add(getFxPairKey(curr, baseCurrency));
    fxPairs.add(getFxPairKey(baseCurrency, curr));
  });

  const fxRates = fxPairs.size
    ? (await queryFxForPairsRange({
      pairs: Array.from(fxPairs),
      startDate,
      endDate,
      lookbackDays: 365
    })).map(row => ({ ...row, date: toDateString(row.date) })).filter(r => r.date)
    : [];

  const seriesByAssetId = new Map<string, BacktestSourceSeriesPoint[]>();

  appAssets.forEach(asset => {
    const rows = prices.filter(p => p.ticker === asset.ticker)
      .map(row => ({ date: row.date, close: row.close, currency: row.currency }));
    const normalized = normalizeAssetSeries(rows, asset);
    seriesByAssetId.set(asset.id, normalized);
  });

  csvAssets.forEach(asset => {
    const rows = csvPrices.filter(p => p.importId === asset.importId)
      .map(row => ({ date: row.date, close: row.close, currency: asset.currency as Currency }));
    const normalized = normalizeAssetSeries(rows, asset);
    seriesByAssetId.set(asset.id, normalized);
  });

  const quality: BacktestDataQualitySummary = buildEmptyQuality(scenario.assets.length);
  const byAssetId: Record<string, BacktestAssetQuality> = {};

  let commonAvailableStart: string | undefined;
  let commonAvailableEnd: string | undefined;

  scenario.assets.forEach(asset => {
    const series = seriesByAssetId.get(asset.id) || [];
    const { minDate, maxDate, count } = getSeriesBounds(series);
    const assetCurrency = asset.currency as Currency | undefined;
    const needsFx = assetCurrency && assetCurrency !== baseCurrency;

    const priceMissing = count === 0 || !minDate || !maxDate || maxDate < startDate || minDate > endDate;
    const pricePartial = !priceMissing && (minDate > startDate || maxDate < endDate);

    let fxMissing = false;
    let fxPartial = false;
    let fxMessage: string | undefined;
    let fxMin: string | undefined;
    let fxMax: string | undefined;

    if (needsFx) {
      const bounds = getFxBounds(assetCurrency as Currency, baseCurrency, fxRates);
      fxMin = bounds.minDate || undefined;
      fxMax = bounds.maxDate || undefined;
      if (!fxMin || !fxMax) {
        fxMissing = true;
        fxMessage = `FX mancante ${assetCurrency} -> ${baseCurrency}`;
      } else if (fxMin > startDate) {
        fxMissing = true;
        fxMessage = `FX disponibile solo dal ${fxMin}`;
      } else if (fxMax < endDate) {
        fxPartial = true;
      }
    }

    let status: BacktestAssetQualityStatus = 'OK';
    let message: string | undefined;

    if (priceMissing) {
      status = 'MISSING';
      message = 'Storico assente';
    } else if (fxMissing) {
      status = 'FX_MISSING';
      message = fxMessage;
    } else if (pricePartial || fxPartial) {
      status = 'PARTIAL';
      const parts: string[] = [];
      if (pricePartial) {
        parts.push(`Storico parziale (${minDate || 'N/D'} -> ${maxDate || 'N/D'})`);
      }
      if (fxPartial && fxMax) {
        parts.push(`FX disponibile fino al ${fxMax}`);
      }
      message = parts.join(' · ');
    }

    if (status === 'OK') quality.ok += 1;
    if (status === 'PARTIAL') quality.partial += 1;
    if (status === 'MISSING') quality.missing += 1;
    if (status === 'FX_MISSING') quality.fxMissing += 1;

    let assetAvailableStart = minDate || undefined;
    let assetAvailableEnd = maxDate || undefined;

    if (needsFx && fxMin) {
      assetAvailableStart = assetAvailableStart && assetAvailableStart > fxMin ? assetAvailableStart : fxMin;
    }
    if (needsFx && fxMax) {
      assetAvailableEnd = assetAvailableEnd && assetAvailableEnd < fxMax ? assetAvailableEnd : fxMax;
    }

    if (assetAvailableStart && assetAvailableEnd) {
      commonAvailableStart = !commonAvailableStart || assetAvailableStart > commonAvailableStart
        ? assetAvailableStart
        : commonAvailableStart;
      commonAvailableEnd = !commonAvailableEnd || assetAvailableEnd < commonAvailableEnd
        ? assetAvailableEnd
        : commonAvailableEnd;
    }

    byAssetId[asset.id] = {
      assetId: asset.id,
      ticker: asset.ticker,
      source: asset.source,
      status,
      message,
      priceStart: minDate || undefined,
      priceEnd: maxDate || undefined,
      priceCount: count,
      currency: assetCurrency
    };
  });

  quality.total = scenario.assets.length;
  quality.byAssetId = byAssetId;
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
  if (quality.partial > 0) {
    quality.messages.push(`${quality.partial} strumento${quality.partial > 1 ? 'i' : ''} con storico parziale`);
  }
  if (quality.missing > 0) {
    quality.messages.push(`${quality.missing} strumento${quality.missing > 1 ? 'i' : ''} senza storico nel range`);
  }
  if (quality.fxMissing > 0) {
    quality.messages.push(`FX mancante per ${quality.fxMissing} strumento${quality.fxMissing > 1 ? 'i' : ''}`);
  }

  if (quality.missing > 0) quality.blockingIssues.push('Storico prezzi mancante per alcuni strumenti.');
  if (quality.fxMissing > 0) quality.blockingIssues.push('FX mancante per alcuni strumenti.');
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
    quality.status = quality.missing > 0 ? 'missing' : 'partial-blocking';
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

  const series: BacktestSourceSeriesPoint[] = [];
  seriesByAssetId.forEach(rows => {
    series.push(...rows);
  });

  return {
    key,
    series,
    fxRates,
    quality
  };
};
