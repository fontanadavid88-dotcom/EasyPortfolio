import { BacktestResult } from './backtestTypes';

export type BacktestComparisonSeriesPoint = {
  date: string;
  aIndex?: number;
  bIndex?: number;
  delta?: number;
};

export type BacktestComparisonSeries = {
  series: BacktestComparisonSeriesPoint[];
  rangeStart?: string;
  rangeEnd?: string;
  warning?: string;
};

const buildNavMap = (result: BacktestResult) => {
  const map = new Map<string, number>();
  result.navSeries.forEach(point => {
    if (!point?.date) return;
    map.set(point.date, point.nav);
  });
  return map;
};

export const buildComparisonSeries = (resultA: BacktestResult, resultB: BacktestResult): BacktestComparisonSeries => {
  const mapA = buildNavMap(resultA);
  const mapB = buildNavMap(resultB);

  const datesA = Array.from(mapA.keys());
  const datesB = new Set(mapB.keys());
  const commonDates = datesA.filter(date => datesB.has(date)).sort((a, b) => a.localeCompare(b));

  if (commonDates.length === 0) {
    return { series: [], warning: 'Nessun intervallo comune tra i due scenari.' };
  }

  const rangeStart = commonDates[0];
  const rangeEnd = commonDates[commonDates.length - 1];
  const baseA = mapA.get(rangeStart) || 0;
  const baseB = mapB.get(rangeStart) || 0;

  if (!baseA || !baseB) {
    return { series: [], rangeStart, rangeEnd, warning: 'Base NAV non disponibile per il confronto.' };
  }

  const series = commonDates.map(date => {
    const navA = mapA.get(date) || 0;
    const navB = mapB.get(date) || 0;
    const aIndex = baseA > 0 ? (navA / baseA) * 100 : undefined;
    const bIndex = baseB > 0 ? (navB / baseB) * 100 : undefined;
    const delta = aIndex !== undefined && bIndex !== undefined ? bIndex - aIndex : undefined;
    return {
      date,
      aIndex,
      bIndex,
      delta
    };
  });

  return { series, rangeStart, rangeEnd };
};
