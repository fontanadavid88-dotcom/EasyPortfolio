import React, { useMemo } from 'react';
import clsx from 'clsx';
import { BacktestResult, BacktestScenarioInput } from '../../services/backtestTypes';

const formatCurrency = (value: number, currency: string) => {
  if (!Number.isFinite(value)) return '-';
  return new Intl.NumberFormat('it-CH', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0
  }).format(value);
};

const formatPct = (value?: number, decimals = 2) => {
  if (value === undefined || value === null || !Number.isFinite(value)) return '-';
  return `${value.toFixed(decimals)}%`;
};

type CompareRule = 'higher' | 'lower' | 'none';

const pickBest = (a?: number, b?: number, rule: CompareRule = 'higher') => {
  if (!Number.isFinite(a ?? NaN) || !Number.isFinite(b ?? NaN)) return null;
  if (rule === 'none') return null;
  if (rule === 'lower') {
    const aScore = Math.abs(a as number);
    const bScore = Math.abs(b as number);
    if (aScore === bScore) return null;
    return aScore < bScore ? 'A' : 'B';
  }
  if ((a as number) === (b as number)) return null;
  return (a as number) > (b as number) ? 'A' : 'B';
};

export const BacktestComparisonKpis: React.FC<{
  scenarioA: BacktestScenarioInput;
  scenarioB: BacktestScenarioInput;
  resultA: BacktestResult;
  resultB: BacktestResult;
}> = ({ scenarioA, scenarioB, resultA, resultB }) => {
  const rows = useMemo(() => {
    return [
      {
        label: 'Valore finale',
        rule: 'higher' as CompareRule,
        a: resultA.summary.finalValue,
        b: resultB.summary.finalValue,
        formatA: (value: number) => formatCurrency(value, scenarioA.baseCurrency),
        formatB: (value: number) => formatCurrency(value, scenarioB.baseCurrency)
      },
      {
        label: 'Capitale versato',
        rule: 'none' as CompareRule,
        a: resultA.summary.totalContributions,
        b: resultB.summary.totalContributions,
        formatA: (value: number) => formatCurrency(value, scenarioA.baseCurrency),
        formatB: (value: number) => formatCurrency(value, scenarioB.baseCurrency)
      },
      {
        label: 'Rendimento totale',
        rule: 'higher' as CompareRule,
        a: resultA.summary.totalReturnPct,
        b: resultB.summary.totalReturnPct,
        formatA: (value: number) => formatPct(value),
        formatB: (value: number) => formatPct(value)
      },
      {
        label: 'CAGR',
        rule: 'higher' as CompareRule,
        a: resultA.summary.cagr,
        b: resultB.summary.cagr,
        formatA: (value?: number) => formatPct(value),
        formatB: (value?: number) => formatPct(value)
      },
      {
        label: 'Volatilita ann.',
        rule: 'lower' as CompareRule,
        a: resultA.summary.volatility,
        b: resultB.summary.volatility,
        formatA: (value?: number) => formatPct(value),
        formatB: (value?: number) => formatPct(value)
      },
      {
        label: 'Max Drawdown',
        rule: 'lower' as CompareRule,
        a: resultA.summary.maxDrawdown,
        b: resultB.summary.maxDrawdown,
        formatA: (value?: number) => formatPct(value),
        formatB: (value?: number) => formatPct(value)
      },
      {
        label: 'Sharpe',
        rule: 'higher' as CompareRule,
        a: resultA.summary.sharpe,
        b: resultB.summary.sharpe,
        formatA: (value?: number) => (value === undefined || value === null || !Number.isFinite(value) ? '-' : value.toFixed(2)),
        formatB: (value?: number) => (value === undefined || value === null || !Number.isFinite(value) ? '-' : value.toFixed(2))
      },
      {
        label: 'Best Year',
        rule: 'higher' as CompareRule,
        a: resultA.summary.bestYear,
        b: resultB.summary.bestYear,
        formatA: (value?: number) => formatPct(value),
        formatB: (value?: number) => formatPct(value)
      },
      {
        label: 'Worst Year',
        rule: 'higher' as CompareRule,
        a: resultA.summary.worstYear,
        b: resultB.summary.worstYear,
        formatA: (value?: number) => formatPct(value),
        formatB: (value?: number) => formatPct(value)
      }
    ];
  }, [resultA, resultB, scenarioA.baseCurrency, scenarioB.baseCurrency]);

  return (
    <div className="ui-panel p-5">
      <div className="text-sm font-semibold text-slate-700 mb-3">KPI comparativi</div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left">
          <thead className="text-xs uppercase text-slate-500 bg-slate-50">
            <tr>
              <th className="px-3 py-2">KPI</th>
              <th className="px-3 py-2">Scenario A</th>
              <th className="px-3 py-2">Scenario B</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => {
              const best = pickBest(row.a as number, row.b as number, row.rule);
              const aClass = best === 'A' ? 'bg-emerald-50 text-emerald-700' : 'text-slate-700';
              const bClass = best === 'B' ? 'bg-emerald-50 text-emerald-700' : 'text-slate-700';
              return (
                <tr key={row.label} className="border-t border-slate-200">
                  <td className="px-3 py-2 text-slate-600">{row.label}</td>
                  <td className={clsx('px-3 py-2 font-mono', aClass)}>
                    {row.formatA(row.a as number)}
                  </td>
                  <td className={clsx('px-3 py-2 font-mono', bClass)}>
                    {row.formatB(row.b as number)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
