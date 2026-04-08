import { describe, expect, it } from 'vitest';
import { Currency, InflationAnnualPoint, InflationPoint, PerformancePoint } from '../types';
import {
  buildInflationIndexSeries,
  computeAnnualInflationRangeMetrics,
  computeInflationRangeMetrics,
  computeRealNavBalanceMetrics,
  dedupeInflationCsvRows,
  deflateHistoryByInflation,
  mergeInflationRowsWithExisting,
  normalizeAnnualInflationPoints,
  getInflationCoverage,
  normalizeInflationPoints,
  resolveInflationInputForRange
} from './inflationService';

const points: InflationPoint[] = [
  { currency: Currency.CHF, date: '2024-01-31', index: 100, source: 'csv' },
  { currency: Currency.CHF, date: '2024-02-29', index: 102, source: 'csv' },
  { currency: Currency.CHF, date: '2024-02-29', index: 103, source: 'manual' },
  { currency: Currency.CHF, date: 'bad-date', index: 110, source: 'csv' },
  { currency: Currency.USD, date: '2024-01-31', index: 200, source: 'csv' },
  { currency: Currency.CHF, date: '2024-03-31', index: 0, source: 'csv' }
];

const history: PerformancePoint[] = [
  { date: '2024-01-31', value: 100, invested: 100, monthlyReturnPct: 0, cumulativeReturnPct: 0, cumulativeTWRRIndex: 1 },
  { date: '2024-02-15', value: 110, invested: 100, monthlyReturnPct: 10, cumulativeReturnPct: 10, cumulativeTWRRIndex: 1.1 },
  { date: '2024-02-29', value: 120, invested: 100, monthlyReturnPct: 9.1, cumulativeReturnPct: 20, cumulativeTWRRIndex: 1.2 }
];

const annualPoints: InflationAnnualPoint[] = [
  { portfolioId: 'p1', currency: Currency.CHF, year: 2024, ratePct: 2, source: 'manual' },
  { portfolioId: 'p1', currency: Currency.CHF, year: 2024, ratePct: 2.5, source: 'manual' },
  { portfolioId: 'p1', currency: Currency.CHF, year: 2025, ratePct: 1, source: 'manual' },
  { portfolioId: 'p1', currency: Currency.CHF, year: 1800, ratePct: 1, source: 'manual' },
  { portfolioId: 'p1', currency: Currency.CHF, year: 2026, ratePct: 101, source: 'manual' },
  { portfolioId: 'p1', currency: Currency.USD, year: 2024, ratePct: 3, source: 'manual' }
];

describe('inflationService', () => {
  it('normalizes and deduplicates valid CPI points', () => {
    const normalized = normalizeInflationPoints(points);
    expect(normalized.map(point => `${point.currency}|${point.date}|${point.index}`)).toEqual([
      'CHF|2024-01-31|100',
      'CHF|2024-02-29|103',
      'USD|2024-01-31|200'
    ]);
  });

  it('builds a carry-forward monthly CPI index for daily chart dates', () => {
    const series = buildInflationIndexSeries(points, Currency.CHF, ['2024-01-15', '2024-01-31', '2024-02-15', '2024-02-29']);
    expect(series.get('2024-01-15')).toBeUndefined();
    expect(series.get('2024-01-31')).toBe(100);
    expect(series.get('2024-02-15')).toBe(100);
    expect(series.get('2024-02-29')).toBe(103);
  });

  it('computes real growth from index ratios instead of subtracting percentages', () => {
    const series = buildInflationIndexSeries(points, Currency.CHF, history.map(point => point.date));
    const metrics = computeInflationRangeMetrics(history, series);
    expect(metrics.hasCoverage).toBe(true);
    expect(metrics.inflationGrowth).toBeCloseTo(1.03);
    expect(metrics.nominalGrowth).toBeCloseTo(1.2);
    expect(metrics.realGrowth).toBeCloseTo(1.2 / 1.03);
    expect(metrics.realReturnPct).toBeCloseTo(((1.2 / 1.03) - 1) * 100);
  });

  it('keeps monthly real return below nominal return when CPI inflation is positive', () => {
    const monthlyHistory: PerformancePoint[] = [
      { date: '2024-01-31', value: 100, invested: 100, monthlyReturnPct: 0, cumulativeReturnPct: 0, cumulativeTWRRIndex: 1 },
      { date: '2024-12-31', value: 133.8, invested: 100, monthlyReturnPct: 0, cumulativeReturnPct: 33.8, cumulativeTWRRIndex: 1.5 }
    ];
    const series = buildInflationIndexSeries([
      { currency: Currency.CHF, date: '2024-01-31', index: 100 },
      { currency: Currency.CHF, date: '2024-12-31', index: 105 }
    ], Currency.CHF, monthlyHistory.map(point => point.date));
    const metrics = computeInflationRangeMetrics(monthlyHistory, series);

    expect(metrics.inflationGrowth).toBeCloseTo(1.05);
    expect(metrics.nominalGrowth).toBeCloseTo(1.338);
    expect(metrics.realGrowth).toBeCloseTo(1.338 / 1.05);
    expect(metrics.realReturnPct).toBeCloseTo(((1.338 / 1.05) - 1) * 100);
    expect(metrics.realReturnPct).toBeLessThanOrEqual(metrics.nominalReturnPct);
    expect(metrics.realReturnPct).toBeLessThan(33.8);
  });

  it('computes real Value NAV balance against invested capital instead of NAV start/end growth', () => {
    const metrics = computeRealNavBalanceMetrics({
      currentValue: 133.8,
      investedCapital: 100,
      inflationGrowth: 1.05
    });

    expect(metrics.nominalBalancePct).toBeCloseTo(33.8);
    expect(metrics.realCurrentValue).toBeCloseTo(133.8 / 1.05);
    expect(metrics.realBalancePct).toBeCloseTo((((133.8 / 1.05) - 100) / 100) * 100);
    expect(metrics.realBalancePct).toBeLessThan(metrics.nominalBalancePct);
    expect(metrics.realBalancePct).toBeLessThan(33.8);
  });

  it('deflates NAV and TWRR history without mutating nominal fields in the source', () => {
    const series = buildInflationIndexSeries(points, Currency.CHF, history.map(point => point.date));
    const real = deflateHistoryByInflation(history, series);
    expect(history[2].value).toBe(120);
    expect(real[0].realValue).toBeCloseTo(100);
    expect(real[2].realValue).toBeCloseTo(120 / 1.03);
    expect(real[2].value).toBeCloseTo(real[2].realValue);
    expect(real[2].nominalValue).toBe(120);
    expect(real[2].realCumulativeTWRRIndex).toBeCloseTo(1.2 / 1.03);
  });

  it('keeps real TWRR below nominal TWRR when CPI inflation is positive', () => {
    const twrrHistory: PerformancePoint[] = [
      { date: '2024-01-31', value: 100, invested: 100, monthlyReturnPct: 0, cumulativeReturnPct: 0, cumulativeTWRRIndex: 1 },
      { date: '2024-12-31', value: 133.8, invested: 100, monthlyReturnPct: 0, cumulativeReturnPct: 33.8, cumulativeTWRRIndex: 1.5199 }
    ];
    const series = buildInflationIndexSeries([
      { currency: Currency.CHF, date: '2024-01-31', index: 100 },
      { currency: Currency.CHF, date: '2024-12-31', index: 105 }
    ], Currency.CHF, twrrHistory.map(point => point.date));
    const real = deflateHistoryByInflation(twrrHistory, series);
    const nominalTwrrPct = ((twrrHistory[1].cumulativeTWRRIndex || 1) - 1) * 100;
    const realTwrrPct = ((real[1].realCumulativeTWRRIndex || 1) - 1) * 100;

    expect(nominalTwrrPct).toBeCloseTo(51.99);
    expect(realTwrrPct).toBeCloseTo(((1.5199 / 1.05) - 1) * 100);
    expect(realTwrrPct).toBeLessThan(nominalTwrrPct);
  });

  it('handles missing coverage without crashing', () => {
    const series = buildInflationIndexSeries([], Currency.CHF, history.map(point => point.date));
    const metrics = computeInflationRangeMetrics(history, series);
    const real = deflateHistoryByInflation(history, series);
    expect(metrics.hasCoverage).toBe(false);
    expect(metrics.realReturnPct).toBe(0);
    expect(real[0].realValue).toBe(100);
  });

  it('reports coverage by currency', () => {
    const coverage = getInflationCoverage(points, Currency.CHF);
    expect(coverage.count).toBe(2);
    expect(coverage.firstDate).toBe('2024-01-31');
    expect(coverage.lastDate).toBe('2024-02-29');
  });

  it('normalizes annual points and deduplicates by portfolio/currency/year', () => {
    const normalized = normalizeAnnualInflationPoints(annualPoints);
    expect(normalized.map(point => `${point.portfolioId}|${point.currency}|${point.year}|${point.ratePct}`)).toEqual([
      'p1|CHF|2024|2.5',
      'p1|CHF|2025|1',
      'p1|USD|2024|3'
    ]);
  });

  it('computes cumulative annual inflation over full years', () => {
    const fullYearHistory: PerformancePoint[] = [
      { date: '2024-01-01', value: 100, invested: 100, monthlyReturnPct: 0, cumulativeReturnPct: 0, cumulativeTWRRIndex: 1 },
      { date: '2025-12-31', value: 130, invested: 100, monthlyReturnPct: 0, cumulativeReturnPct: 30, cumulativeTWRRIndex: 1.3 }
    ];
    const metrics = computeAnnualInflationRangeMetrics({
      history: fullYearHistory,
      annualPoints,
      currency: Currency.CHF
    });
    expect(metrics.hasCoverage).toBe(true);
    expect(metrics.inflationGrowth).toBeCloseTo(1.025 * 1.01);
    expect(metrics.realGrowth).toBeCloseTo(1.3 / (1.025 * 1.01));
    expect(metrics.prorated).toBe(false);
  });

  it('keeps annual fallback real return below nominal return when annual inflation is positive', () => {
    const annualHistory: PerformancePoint[] = [
      { date: '2024-01-01', value: 100, invested: 100, monthlyReturnPct: 0, cumulativeReturnPct: 0, cumulativeTWRRIndex: 1 },
      { date: '2025-12-31', value: 133.8, invested: 100, monthlyReturnPct: 0, cumulativeReturnPct: 33.8, cumulativeTWRRIndex: 1.5 }
    ];
    const metrics = computeAnnualInflationRangeMetrics({
      history: annualHistory,
      annualPoints: [
        { portfolioId: 'p1', currency: Currency.CHF, year: 2024, ratePct: 2, source: 'manual' },
        { portfolioId: 'p1', currency: Currency.CHF, year: 2025, ratePct: 1, source: 'manual' }
      ],
      currency: Currency.CHF
    });

    expect(metrics.hasCoverage).toBe(true);
    expect(metrics.inflationGrowth).toBeCloseTo(1.02 * 1.01);
    expect(metrics.nominalGrowth).toBeCloseTo(1.338);
    expect(metrics.realGrowth).toBeCloseTo(1.338 / (1.02 * 1.01));
    expect(metrics.realReturnPct).toBeCloseTo(((1.338 / (1.02 * 1.01)) - 1) * 100);
    expect(metrics.realReturnPct).toBeLessThanOrEqual(metrics.nominalReturnPct);
    expect(metrics.realReturnPct).toBeLessThan(33.8);
  });

  it('prorates annual inflation for partial-year ranges', () => {
    const partialHistory: PerformancePoint[] = [
      { date: '2024-07-01', value: 100, invested: 100, monthlyReturnPct: 0, cumulativeReturnPct: 0, cumulativeTWRRIndex: 1 },
      { date: '2024-12-31', value: 110, invested: 100, monthlyReturnPct: 0, cumulativeReturnPct: 10, cumulativeTWRRIndex: 1.1 }
    ];
    const metrics = computeAnnualInflationRangeMetrics({
      history: partialHistory,
      annualPoints,
      currency: Currency.CHF
    });
    const fraction = 184 / 366;
    expect(metrics.hasCoverage).toBe(true);
    expect(metrics.inflationGrowth).toBeCloseTo(1 + (0.025 * fraction));
    expect(metrics.prorated).toBe(true);
  });

  it('resolves monthly before annual and allows real charts', () => {
    const result = resolveInflationInputForRange({
      history,
      monthlyPoints: points,
      annualPoints,
      currency: Currency.CHF
    });
    expect(result.mode).toBe('monthly');
    expect(result.canRenderRealChart).toBe(true);
    expect(result.coverageLabel).toBe('Fonte inflazione: mensile');
  });

  it('falls back from monthly to annual and blocks advanced real chart', () => {
    const result = resolveInflationInputForRange({
      history,
      monthlyPoints: [],
      annualPoints,
      currency: Currency.CHF
    });
    expect(result.mode).toBe('annual');
    expect(result.canRenderRealChart).toBe(false);
    expect(result.annualMetrics?.hasCoverage).toBe(true);
    expect(result.annualMetrics?.realReturnPct).toBeCloseTo(((1.2 / (1 + (0.025 * 30 / 366))) - 1) * 100);
  });

  it('falls back from annual to none when annual years are missing', () => {
    const result = resolveInflationInputForRange({
      history,
      monthlyPoints: [],
      annualPoints: [],
      currency: Currency.CHF
    });
    expect(result.mode).toBe('none');
    expect(result.canRenderRealChart).toBe(false);
  });

  it('deduplicates monthly CSV rows by portfolio/currency/date before persistence', () => {
    const rows: InflationPoint[] = [
      { portfolioId: 'p1', currency: Currency.CHF, date: '2026-01-01', index: 100 },
      { portfolioId: 'p1', currency: Currency.CHF, date: '2026-01-01', index: 101 },
      { portfolioId: 'p2', currency: Currency.CHF, date: '2026-01-01', index: 200 }
    ];
    const result = dedupeInflationCsvRows(rows);
    expect(result.duplicateCount).toBe(1);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.find(row => row.portfolioId === 'p1')?.index).toBe(101);
  });

  it('merges monthly rows with existing ids for upsert', () => {
    const rows: InflationPoint[] = [
      { portfolioId: 'p1', currency: Currency.CHF, date: '2026-01-01', index: 100 },
      { portfolioId: 'p1', currency: Currency.CHF, date: '2026-02-01', index: 101 }
    ];
    const result = mergeInflationRowsWithExisting(rows, [
      { id: 10, portfolioId: 'p1', currency: Currency.CHF, date: '2026-01-01', index: 99 },
      { id: 11, portfolioId: 'p2', currency: Currency.CHF, date: '2026-02-01', index: 88 }
    ]);
    expect(result.updatedCount).toBe(1);
    expect(result.insertedCount).toBe(1);
    expect(result.rows[0].id).toBe(10);
    expect(result.rows[1].id).toBeUndefined();
  });

  it('reimporting the same deduped monthly CSV resolves to updates, not new rows', () => {
    const rows: InflationPoint[] = [
      { portfolioId: 'p1', currency: Currency.CHF, date: '2026-01-01', index: 100 },
      { portfolioId: 'p1', currency: Currency.CHF, date: '2026-02-01', index: 101 }
    ];
    const first = mergeInflationRowsWithExisting(rows, []);
    expect(first.insertedCount).toBe(2);
    const existing = first.rows.map((row, idx) => ({ ...row, id: idx + 1 }));
    const second = mergeInflationRowsWithExisting(rows, existing);
    expect(second.insertedCount).toBe(0);
    expect(second.updatedCount).toBe(2);
    expect(second.rows.map(row => row.id)).toEqual([1, 2]);
  });
});
