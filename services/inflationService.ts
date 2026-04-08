import { Currency, InflationAnnualPoint, InflationPoint, PerformancePoint } from '../types';
import { diffDaysYmd, isYmd } from './dateUtils';

export type InflationIndexSeries = Map<string, number>;

export type InflationRangeMetrics = {
  hasCoverage: boolean;
  startDate?: string;
  endDate?: string;
  inflationStartIndex?: number;
  inflationEndIndex?: number;
  inflationGrowth: number;
  inflationReturnPct: number;
  nominalGrowth: number;
  nominalReturnPct: number;
  realGrowth: number;
  realReturnPct: number;
  realCagrPct: number;
  missingDates: string[];
};

export type RealPerformancePoint = PerformancePoint & {
  nominalValue: number;
  nominalCumulativeTWRRIndex?: number;
  realValue: number;
  realCumulativeTWRRIndex?: number;
  inflationIndex?: number;
  inflationGrowthFromStart?: number;
};

export type InflationCoverage = {
  currency: Currency;
  count: number;
  firstDate?: string;
  lastDate?: string;
};

export type AnnualInflationCoverage = {
  currency: Currency;
  count: number;
  firstYear?: number;
  lastYear?: number;
};

export type AnnualInflationRangeMetrics = InflationRangeMetrics & {
  source: 'annual';
  usedYears: number[];
  missingYears: number[];
  prorated: boolean;
};

export type InflationMode = 'monthly' | 'annual' | 'none';

export type ResolvedInflationInput = {
  mode: InflationMode;
  coverageLabel: string;
  warning?: string;
  canRenderRealChart: boolean;
  inflationIndexByDate: InflationIndexSeries;
  monthlyMetrics: InflationRangeMetrics;
  annualMetrics?: AnnualInflationRangeMetrics;
  realHistory: RealPerformancePoint[];
};

export type InflationMonthlyMergeResult = {
  rows: InflationPoint[];
  insertedCount: number;
  updatedCount: number;
};

export type InflationMonthlyDedupeResult = {
  rows: InflationPoint[];
  duplicateCount: number;
};

export type RealNavBalanceMetrics = {
  realCurrentValue: number;
  realBalance: number;
  realBalancePct: number;
  nominalBalancePct: number;
};

export const computeRealNavBalanceMetrics = ({
  currentValue,
  investedCapital,
  inflationGrowth
}: {
  currentValue: number;
  investedCapital: number;
  inflationGrowth: number;
}): RealNavBalanceMetrics => {
  const safeCurrentValue = Number.isFinite(currentValue) ? currentValue : 0;
  const safeInvestedCapital = Number.isFinite(investedCapital) ? investedCapital : 0;
  const safeInflationGrowth = Number.isFinite(inflationGrowth) && inflationGrowth > 0
    ? inflationGrowth
    : 1;
  const realCurrentValue = safeCurrentValue / safeInflationGrowth;
  const realBalance = realCurrentValue - safeInvestedCapital;
  const realBalancePct = safeInvestedCapital > 0 ? (realBalance / safeInvestedCapital) * 100 : 0;
  const nominalBalancePct = safeInvestedCapital > 0
    ? ((safeCurrentValue - safeInvestedCapital) / safeInvestedCapital) * 100
    : 0;

  return {
    realCurrentValue,
    realBalance,
    realBalancePct,
    nominalBalancePct
  };
};

const validPoint = (point: InflationPoint): boolean => {
  return isYmd(point.date)
    && Object.values(Currency).includes(point.currency)
    && Number.isFinite(point.index)
    && point.index > 0;
};

const validAnnualPoint = (point: InflationAnnualPoint): boolean => {
  return Object.values(Currency).includes(point.currency)
    && Number.isInteger(point.year)
    && point.year >= 1900
    && point.year <= 2200
    && Number.isFinite(point.ratePct)
    && point.ratePct >= -50
    && point.ratePct <= 100;
};

const getPerformanceIndex = (point: PerformancePoint): number => {
  return point.value > 0 ? point.value : 0;
};

const getHistoryRange = (history: PerformancePoint[], rangeStartDate?: string, rangeEndDate?: string) => {
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  return {
    sorted,
    startDate: rangeStartDate || sorted[0]?.date,
    endDate: rangeEndDate || sorted[sorted.length - 1]?.date
  };
};

const getYearBounds = (year: number) => ({
  start: `${year}-01-01`,
  end: `${year}-12-31`
});

const getRequiredYears = (startDate: string, endDate: string): number[] => {
  if (!isYmd(startDate) || !isYmd(endDate) || endDate < startDate) return [];
  const startYear = Number(startDate.slice(0, 4));
  const endYear = Number(endDate.slice(0, 4));
  const years: number[] = [];
  for (let year = startYear; year <= endYear; year += 1) years.push(year);
  return years;
};

const getYearCoverageFraction = (year: number, startDate: string, endDate: string): number => {
  const bounds = getYearBounds(year);
  const overlapStart = startDate > bounds.start ? startDate : bounds.start;
  const overlapEnd = endDate < bounds.end ? endDate : bounds.end;
  if (overlapEnd < overlapStart) return 0;
  const coveredDays = diffDaysYmd(overlapEnd, overlapStart) + 1;
  const totalDays = diffDaysYmd(bounds.end, bounds.start) + 1;
  return totalDays > 0 ? Math.max(0, Math.min(1, coveredDays / totalDays)) : 0;
};

const hasMonthlyCoverageForRange = (history: PerformancePoint[], inflationIndexByDate: InflationIndexSeries): boolean => {
  if (history.length < 2) return false;
  const first = history[0];
  const last = history[history.length - 1];
  return Boolean(
    first
    && last
    && Number.isFinite(inflationIndexByDate.get(first.date))
    && Number.isFinite(inflationIndexByDate.get(last.date))
  );
};

export const normalizeInflationPoints = (points: InflationPoint[]): InflationPoint[] => {
  const deduped = new Map<string, InflationPoint>();
  points.forEach(point => {
    if (!validPoint(point)) return;
    const normalized: InflationPoint = {
      ...point,
      date: point.date.trim(),
      index: Number(point.index),
      currency: point.currency
    };
    deduped.set(`${normalized.currency}|${normalized.date}`, normalized);
  });
  return Array.from(deduped.values()).sort((a, b) => {
    const currencyOrder = a.currency.localeCompare(b.currency);
    return currencyOrder !== 0 ? currencyOrder : a.date.localeCompare(b.date);
  });
};

export const normalizeAnnualInflationPoints = (points: InflationAnnualPoint[]): InflationAnnualPoint[] => {
  const deduped = new Map<string, InflationAnnualPoint>();
  points.forEach(point => {
    const normalized: InflationAnnualPoint = {
      ...point,
      currency: point.currency,
      year: Number(point.year),
      ratePct: Number(point.ratePct)
    };
    if (!validAnnualPoint(normalized)) return;
    deduped.set(`${normalized.portfolioId || ''}|${normalized.currency}|${normalized.year}`, normalized);
  });
  return Array.from(deduped.values()).sort((a, b) => {
    const currencyOrder = a.currency.localeCompare(b.currency);
    if (currencyOrder !== 0) return currencyOrder;
    return a.year - b.year;
  });
};

export const dedupeInflationCsvRows = (rows: InflationPoint[]): InflationMonthlyDedupeResult => {
  const map = new Map<string, InflationPoint>();
  let duplicateCount = 0;
  rows.forEach(row => {
    const key = `${row.portfolioId || ''}|${row.currency}|${row.date}`;
    if (map.has(key)) duplicateCount += 1;
    map.set(key, row);
  });
  return {
    rows: Array.from(map.values()).sort((a, b) => {
      const portfolioOrder = String(a.portfolioId || '').localeCompare(String(b.portfolioId || ''));
      if (portfolioOrder !== 0) return portfolioOrder;
      const currencyOrder = a.currency.localeCompare(b.currency);
      return currencyOrder !== 0 ? currencyOrder : a.date.localeCompare(b.date);
    }),
    duplicateCount
  };
};

export const mergeInflationRowsWithExisting = (
  rows: InflationPoint[],
  existingRows: InflationPoint[]
): InflationMonthlyMergeResult => {
  const existingByKey = new Map<string, InflationPoint>();
  existingRows.forEach(row => {
    existingByKey.set(`${row.portfolioId || ''}|${row.currency}|${row.date}`, row);
  });

  let insertedCount = 0;
  let updatedCount = 0;
  const merged = rows.map(row => {
    const existing = existingByKey.get(`${row.portfolioId || ''}|${row.currency}|${row.date}`);
    if (existing?.id) {
      updatedCount += 1;
      return { ...row, id: existing.id };
    }
    insertedCount += 1;
    return row;
  });

  return { rows: merged, insertedCount, updatedCount };
};

export const buildInflationIndexSeries = (
  points: InflationPoint[],
  currency: Currency,
  dateIndex: string[]
): InflationIndexSeries => {
  const normalized = normalizeInflationPoints(points)
    .filter(point => point.currency === currency)
    .sort((a, b) => a.date.localeCompare(b.date));
  const dates = [...dateIndex].filter(isYmd).sort();
  const series: InflationIndexSeries = new Map();
  if (!normalized.length || !dates.length) return series;

  let pointIdx = 0;
  let lastIndex: number | undefined;
  dates.forEach(date => {
    while (pointIdx < normalized.length && normalized[pointIdx].date <= date) {
      lastIndex = normalized[pointIdx].index;
      pointIdx += 1;
    }
    if (lastIndex !== undefined) {
      series.set(date, lastIndex);
    }
  });
  return series;
};

export const computeAnnualInflationRangeMetrics = ({
  history,
  annualPoints,
  currency,
  rangeStartDate,
  rangeEndDate
}: {
  history: PerformancePoint[];
  annualPoints: InflationAnnualPoint[];
  currency: Currency;
  rangeStartDate?: string;
  rangeEndDate?: string;
}): AnnualInflationRangeMetrics => {
  const { sorted, startDate, endDate } = getHistoryRange(history, rangeStartDate, rangeEndDate);
  const requiredYears = startDate && endDate ? getRequiredYears(startDate, endDate) : [];
  const rows = normalizeAnnualInflationPoints(annualPoints).filter(point => point.currency === currency);
  const byYear = new Map(rows.map(point => [point.year, point]));
  const missingYears = requiredYears.filter(year => !byYear.has(year));
  const firstPoint = sorted.find(point => getPerformanceIndex(point) > 0) || sorted[0];
  const lastPoint = sorted[sorted.length - 1];

  if (!startDate || !endDate || sorted.length < 2 || requiredYears.length === 0 || missingYears.length > 0 || !firstPoint || !lastPoint) {
    return {
      source: 'annual',
      hasCoverage: false,
      startDate,
      endDate,
      inflationGrowth: 1,
      inflationReturnPct: 0,
      nominalGrowth: 1,
      nominalReturnPct: 0,
      realGrowth: 1,
      realReturnPct: 0,
      realCagrPct: 0,
      missingDates: [],
      usedYears: requiredYears.filter(year => byYear.has(year)),
      missingYears,
      prorated: false
    };
  }

  let inflationGrowth = 1;
  let prorated = false;
  requiredYears.forEach(year => {
    const row = byYear.get(year);
    if (!row) return;
    const fraction = getYearCoverageFraction(year, startDate, endDate);
    if (fraction < 0.999) prorated = true;
    inflationGrowth *= 1 + ((row.ratePct / 100) * fraction);
  });

  const startPerformanceIndex = getPerformanceIndex(firstPoint);
  const endPerformanceIndex = getPerformanceIndex(lastPoint);
  const nominalGrowth = startPerformanceIndex > 0 && endPerformanceIndex > 0
    ? endPerformanceIndex / startPerformanceIndex
    : 1;
  const realGrowth = inflationGrowth > 0 ? nominalGrowth / inflationGrowth : 1;
  const days = Math.max(1, diffDaysYmd(endDate, startDate));

  return {
    source: 'annual',
    hasCoverage: true,
    startDate,
    endDate,
    inflationGrowth,
    inflationReturnPct: (inflationGrowth - 1) * 100,
    nominalGrowth,
    nominalReturnPct: (nominalGrowth - 1) * 100,
    realGrowth,
    realReturnPct: (realGrowth - 1) * 100,
    realCagrPct: (Math.pow(realGrowth, 365.25 / days) - 1) * 100,
    missingDates: [],
    usedYears: requiredYears,
    missingYears: [],
    prorated
  };
};

export const buildApproximateRealMetricsFromAnnualInflation = computeAnnualInflationRangeMetrics;

export const computeInflationRangeMetrics = (
  history: PerformancePoint[],
  inflationIndexByDate: InflationIndexSeries
): InflationRangeMetrics => {
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const covered = sorted.filter(point => Number.isFinite(inflationIndexByDate.get(point.date)));
  const missingDates = sorted
    .filter(point => !Number.isFinite(inflationIndexByDate.get(point.date)))
    .map(point => point.date);

  if (covered.length < 2) {
    return {
      hasCoverage: false,
      inflationGrowth: 1,
      inflationReturnPct: 0,
      nominalGrowth: 1,
      nominalReturnPct: 0,
      realGrowth: 1,
      realReturnPct: 0,
      realCagrPct: 0,
      missingDates
    };
  }

  const start = covered.find(point => getPerformanceIndex(point) > 0 && (inflationIndexByDate.get(point.date) || 0) > 0) || covered[0];
  const end = covered[covered.length - 1];
  const inflationStartIndex = inflationIndexByDate.get(start.date);
  const inflationEndIndex = inflationIndexByDate.get(end.date);
  const startPerformanceIndex = getPerformanceIndex(start);
  const endPerformanceIndex = getPerformanceIndex(end);

  if (!inflationStartIndex || !inflationEndIndex || !startPerformanceIndex || !endPerformanceIndex) {
    return {
      hasCoverage: false,
      startDate: start.date,
      endDate: end.date,
      inflationStartIndex,
      inflationEndIndex,
      inflationGrowth: 1,
      inflationReturnPct: 0,
      nominalGrowth: 1,
      nominalReturnPct: 0,
      realGrowth: 1,
      realReturnPct: 0,
      realCagrPct: 0,
      missingDates
    };
  }

  const inflationGrowth = inflationEndIndex / inflationStartIndex;
  const nominalGrowth = endPerformanceIndex / startPerformanceIndex;
  const realGrowth = inflationGrowth > 0 ? nominalGrowth / inflationGrowth : 1;
  const days = Math.max(1, diffDaysYmd(end.date, start.date));
  const realCagrPct = (Math.pow(realGrowth, 365.25 / days) - 1) * 100;

  return {
    hasCoverage: true,
    startDate: start.date,
    endDate: end.date,
    inflationStartIndex,
    inflationEndIndex,
    inflationGrowth,
    inflationReturnPct: (inflationGrowth - 1) * 100,
    nominalGrowth,
    nominalReturnPct: (nominalGrowth - 1) * 100,
    realGrowth,
    realReturnPct: (realGrowth - 1) * 100,
    realCagrPct,
    missingDates
  };
};

export const resolveInflationModeForRange = ({
  history,
  monthlyPoints,
  annualPoints,
  currency
}: {
  history: PerformancePoint[];
  monthlyPoints: InflationPoint[];
  annualPoints: InflationAnnualPoint[];
  currency: Currency;
}): Pick<ResolvedInflationInput, 'mode' | 'coverageLabel' | 'warning' | 'canRenderRealChart'> => {
  return resolveInflationInputForRange({ history, monthlyPoints, annualPoints, currency });
};

export const resolveInflationInputForRange = ({
  history,
  monthlyPoints,
  annualPoints,
  currency
}: {
  history: PerformancePoint[];
  monthlyPoints: InflationPoint[];
  annualPoints: InflationAnnualPoint[];
  currency: Currency;
}): ResolvedInflationInput => {
  const sortedHistory = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const dateIndex = sortedHistory.map(point => point.date);
  const monthlySeries = buildInflationIndexSeries(monthlyPoints, currency, dateIndex);
  const monthlyMetrics = computeInflationRangeMetrics(sortedHistory, monthlySeries);
  const monthlyCanRender = hasMonthlyCoverageForRange(sortedHistory, monthlySeries) && monthlyMetrics.hasCoverage;
  const realHistory = monthlyCanRender ? deflateHistoryByInflation(sortedHistory, monthlySeries) : [];

  if (monthlyCanRender) {
    return {
      mode: 'monthly',
      coverageLabel: 'Fonte inflazione: mensile',
      canRenderRealChart: true,
      inflationIndexByDate: monthlySeries,
      monthlyMetrics,
      realHistory
    };
  }

  const annualMetrics = computeAnnualInflationRangeMetrics({
    history: sortedHistory,
    annualPoints,
    currency
  });

  if (annualMetrics.hasCoverage) {
    return {
      mode: 'annual',
      coverageLabel: 'Fonte inflazione: annuale (stima)',
      warning: annualMetrics.prorated
        ? 'KPI reale stimato su base inflazione annuale con prorata lineare.'
        : 'KPI reale stimato su base inflazione annuale.',
      canRenderRealChart: false,
      inflationIndexByDate: monthlySeries,
      monthlyMetrics,
      annualMetrics,
      realHistory: []
    };
  }

  return {
    mode: 'none',
    coverageLabel: 'Fonte inflazione: assente',
    warning: annualMetrics.missingYears.length
      ? `Inflazione annuale incompleta: mancano ${annualMetrics.missingYears.join(', ')}.`
      : 'Dati inflazione non disponibili per il range.',
    canRenderRealChart: false,
    inflationIndexByDate: monthlySeries,
    monthlyMetrics,
    annualMetrics,
    realHistory: []
  };
};

export const deflateHistoryByInflation = (
  history: PerformancePoint[],
  inflationIndexByDate: InflationIndexSeries
): RealPerformancePoint[] => {
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const basePoint = sorted.find(point => Number.isFinite(inflationIndexByDate.get(point.date)) && (inflationIndexByDate.get(point.date) || 0) > 0);
  const baseInflationIndex = basePoint ? inflationIndexByDate.get(basePoint.date) : undefined;
  const baseTwrrIndex = basePoint?.cumulativeTWRRIndex && basePoint.cumulativeTWRRIndex > 0
    ? basePoint.cumulativeTWRRIndex
    : undefined;

  return sorted.map(point => {
    const inflationIndex = inflationIndexByDate.get(point.date);
    const inflationGrowthFromStart = baseInflationIndex && inflationIndex
      ? inflationIndex / baseInflationIndex
      : undefined;
    const realValue = inflationGrowthFromStart && inflationGrowthFromStart > 0
      ? point.value / inflationGrowthFromStart
      : point.value;
    const realCumulativeTWRRIndex = inflationGrowthFromStart && inflationGrowthFromStart > 0 && baseTwrrIndex && point.cumulativeTWRRIndex
      ? (point.cumulativeTWRRIndex / baseTwrrIndex) / inflationGrowthFromStart
      : point.cumulativeTWRRIndex;

    return {
      ...point,
      value: realValue,
      cumulativeTWRRIndex: realCumulativeTWRRIndex,
      cumulativeReturnPct: realCumulativeTWRRIndex ? (realCumulativeTWRRIndex - 1) * 100 : point.cumulativeReturnPct,
      nominalValue: point.value,
      nominalCumulativeTWRRIndex: point.cumulativeTWRRIndex,
      realValue,
      realCumulativeTWRRIndex,
      inflationIndex,
      inflationGrowthFromStart
    };
  });
};

export const getInflationCoverage = (
  points: InflationPoint[],
  currency: Currency
): InflationCoverage => {
  const rows = normalizeInflationPoints(points).filter(point => point.currency === currency);
  return {
    currency,
    count: rows.length,
    firstDate: rows[0]?.date,
    lastDate: rows[rows.length - 1]?.date
  };
};

export const getAnnualInflationCoverage = (
  points: InflationAnnualPoint[],
  currency: Currency
): AnnualInflationCoverage => {
  const rows = normalizeAnnualInflationPoints(points).filter(point => point.currency === currency);
  return {
    currency,
    count: rows.length,
    firstYear: rows[0]?.year,
    lastYear: rows[rows.length - 1]?.year
  };
};
