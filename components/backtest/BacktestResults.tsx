import React, { useMemo } from 'react';
import { Area, AreaChart, Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid, Legend, LabelList } from 'recharts';
import { BacktestResult, BacktestScenarioInput } from '../../services/backtestTypes';
import { CHART_COLORS, COLORS } from '../../constants';

const formatCurrency = (value: number, currency: string) => {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('it-CH', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0
  }).format(value);
};

const formatPct = (value?: number, decimals = 2) => {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(decimals)}%`;
};

const KpiCard: React.FC<{
  label: string;
  value: string;
  subtitle?: string;
  tone?: 'neutral' | 'positive' | 'negative';
}> = ({ label, value, subtitle, tone = 'neutral' }) => {
  const toneClasses = tone === 'positive'
    ? 'border-emerald-200 bg-emerald-50/40'
    : tone === 'negative'
      ? 'border-rose-200 bg-rose-50/40'
      : 'border-slate-200 bg-white';
  const valueClasses = tone === 'positive'
    ? 'text-emerald-700'
    : tone === 'negative'
      ? 'text-rose-700'
      : 'text-slate-900';
  return (
    <div className={`ui-panel ui-kpi p-4 flex flex-col gap-2 border ${toneClasses}`}>
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-2xl font-bold ${valueClasses}`}>{value}</div>
      {subtitle && <div className="text-xs text-slate-500">{subtitle}</div>}
    </div>
  );
};

export const BacktestResults: React.FC<{
  scenario: BacktestScenarioInput;
  result: BacktestResult;
  onBack: () => void;
}> = ({ scenario, result, onBack }) => {
  const effectiveStart = result.effectiveStartDate || scenario.startDate;
  const effectiveEnd = result.effectiveEndDate || scenario.endDate;
  const navSeries = result.navSeries || [];
  const chartSeries = useMemo(() => {
    if (navSeries.length <= 450) return navSeries;
    const map = new Map<string, (typeof navSeries)[0]>();
    navSeries.forEach(point => {
      const key = point.date.slice(0, 7);
      map.set(key, point);
    });
    return Array.from(map.values());
  }, [navSeries]);

  const drawdownSeries = useMemo(() => chartSeries.map(p => ({ date: p.date, drawdown: p.drawdown ?? 0 })), [chartSeries]);

  const annualReturns = result.annualReturns || [];
  const annualChart = useMemo(() => {
    return annualReturns.map(item => ({
      ...item,
      label: `${item.value >= 0 ? '+' : ''}${item.value.toFixed(1)}%`
    }));
  }, [annualReturns]);
  const annualChartView = useMemo(() => {
    if (annualChart.length <= 10) return annualChart;
    return annualChart.slice(-10);
  }, [annualChart]);
  const renderAnnualLabel = (props: any) => {
    const { x, y, width, value } = props;
    if (value === undefined || value === null || !Number.isFinite(value)) return null;
    const label = `${value >= 0 ? '+' : ''}${Number(value).toFixed(1)}%`;
    const yPos = value >= 0 ? y - 6 : y + 16;
    return (
      <text x={x + width / 2} y={yPos} textAnchor="middle" fontSize={11} fill="#0f172a">
        {label}
      </text>
    );
  };

  const weightData = useMemo(() => {
    return scenario.assets.map((asset, idx) => ({
      name: asset.ticker,
      value: asset.allocationPct,
      color: COLORS[idx % COLORS.length]
    }));
  }, [scenario.assets]);

  const allocationRows = useMemo(() => {
    return scenario.assets.map(asset => ({
      ticker: asset.ticker,
      name: asset.name,
      assetClass: asset.assetClass,
      allocationPct: asset.allocationPct
    }));
  }, [scenario.assets]);

  const totalReturnTone = result.summary.totalReturnPct >= 0 ? 'positive' : 'negative';
  const bestYearTone = (result.summary.bestYear ?? 0) >= 0 ? 'positive' : 'negative';
  const worstYearTone = (result.summary.worstYear ?? 0) >= 0 ? 'positive' : 'negative';
  const maxDdTone = (result.summary.maxDrawdown ?? 0) < 0 ? 'negative' : 'neutral';

  return (
    <div className="space-y-6">
      <div className="ui-panel p-6 space-y-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">{scenario.title}</h1>
            <div className="text-sm text-slate-500 space-y-1">
              <div>Periodo richiesto: {scenario.startDate} → {scenario.endDate}</div>
              <div>Periodo simulato: {effectiveStart} → {effectiveEnd}</div>
              <div>Base {scenario.baseCurrency} · Ribilanciamento {scenario.rebalanceFrequency === 'annual' ? 'annuale' : 'no'}</div>
            </div>
            {effectiveEnd < scenario.endDate && (
              <div className="mt-2 inline-flex items-center text-[11px] uppercase tracking-wide font-semibold px-2 py-1 rounded-full border bg-amber-50 text-amber-700 border-amber-200">
                Fine effettiva anticipata all’ultima data disponibile
              </div>
            )}
          </div>
          <button type="button" onClick={onBack} className="ui-btn-secondary">
            Torna al builder
          </button>
        </div>

        {result.warnings.length > 0 && (
          <div className="ui-panel-subtle border-amber-200 bg-amber-50 p-4 text-xs text-amber-800 space-y-1">
            <div className="font-semibold">Avvisi backtest</div>
            <ul className="list-disc pl-4">
              {result.warnings.map((warn, idx) => (
                <li key={idx}>{warn}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
          <div className="ui-panel-subtle p-4 space-y-3">
            <div className="text-xs uppercase tracking-wide text-slate-500 font-semibold">Sintesi</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <KpiCard label="Valore iniziale" value={formatCurrency(result.summary.initialCapital, scenario.baseCurrency)} />
              <KpiCard label="Capitale versato" value={formatCurrency(result.summary.totalContributions, scenario.baseCurrency)} />
              <KpiCard label="Valore finale" value={formatCurrency(result.summary.finalValue, scenario.baseCurrency)} tone="neutral" />
              <KpiCard label="Rendimento totale" value={formatPct(result.summary.totalReturnPct)} tone={totalReturnTone} />
            </div>
          </div>
          <div className="ui-panel-subtle p-4 space-y-3">
            <div className="text-xs uppercase tracking-wide text-slate-500 font-semibold">Performance</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <KpiCard label="CAGR" value={formatPct(result.summary.cagr)} tone={(result.summary.cagr ?? 0) >= 0 ? 'positive' : 'negative'} />
              <KpiCard label="Best Year" value={result.summary.bestYear !== undefined ? formatPct(result.summary.bestYear) : '—'} tone={bestYearTone} />
              <KpiCard label="Worst Year" value={result.summary.worstYear !== undefined ? formatPct(result.summary.worstYear) : '—'} tone={worstYearTone} />
            </div>
          </div>
          <div className="ui-panel-subtle p-4 space-y-3">
            <div className="text-xs uppercase tracking-wide text-slate-500 font-semibold">Rischio</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <KpiCard label="Volatilità ann." value={formatPct(result.summary.volatility)} tone="neutral" />
              <KpiCard label="Max Drawdown" value={formatPct(result.summary.maxDrawdown)} tone={maxDdTone} />
              <KpiCard label="Sharpe" value={result.summary.sharpe !== undefined ? result.summary.sharpe.toFixed(2) : '—'} tone={result.summary.sharpe !== undefined && result.summary.sharpe >= 0 ? 'positive' : 'negative'} />
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="ui-panel p-5 xl:col-span-2">
          <div className="text-sm font-semibold text-slate-700 mb-3">Crescita portafoglio (NAV)</div>
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartSeries}>
                <defs>
                  <linearGradient id="navFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={CHART_COLORS.line} stopOpacity={0.4} />
                    <stop offset="100%" stopColor={CHART_COLORS.line} stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(value: number) => formatCurrency(value, scenario.baseCurrency)} />
                <Area type="monotone" dataKey="nav" stroke={CHART_COLORS.line} fill="url(#navFill)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="ui-panel p-5">
          <div className="text-sm font-semibold text-slate-700 mb-3">Pesi iniziali</div>
          <div className="h-[240px]">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={weightData} dataKey="value" nameKey="name" innerRadius={60} outerRadius={95} paddingAngle={2}>
                  {weightData.map((entry, idx) => (
                    <Cell key={`cell-${idx}`} fill={entry.color} />
                  ))}
                </Pie>
                <Legend />
                <Tooltip formatter={(value: number) => `${value.toFixed(1)}%`} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="ui-panel p-5">
        <div className="text-sm font-semibold text-slate-700 mb-3">Allocazione dettagliata</div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead className="text-[11px] uppercase text-slate-500 bg-slate-50">
              <tr>
                <th className="px-2 py-2">Ticker</th>
                <th className="px-2 py-2">Nome</th>
                <th className="px-2 py-2">Asset Class</th>
                <th className="px-2 py-2 text-right">Allocazione</th>
              </tr>
            </thead>
            <tbody>
              {allocationRows.map(row => (
                <tr key={row.ticker} className="border-t border-slate-200">
                  <td className="px-2 py-2 font-semibold text-slate-700">{row.ticker}</td>
                  <td className="px-2 py-2 text-slate-600 truncate max-w-[220px]">{row.name}</td>
                  <td className="px-2 py-2 text-slate-600">{row.assetClass}</td>
                  <td className="px-2 py-2 text-right font-mono text-slate-700">
                    {row.allocationPct.toFixed(2)}%
                  </td>
                </tr>
              ))}
              {allocationRows.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-2 py-4 text-center text-slate-400">
                    Nessuna allocazione disponibile.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="ui-panel p-5">
          <div className="text-sm font-semibold text-slate-700 mb-3">Drawdown</div>
          <div className="h-[260px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={drawdownSeries}>
                <defs>
                  <linearGradient id="ddFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={CHART_COLORS.drawdown} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={CHART_COLORS.drawdown} stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(value: number) => `${value.toFixed(2)}%`} />
                <Area type="monotone" dataKey="drawdown" stroke={CHART_COLORS.drawdown} fill="url(#ddFill)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="ui-panel p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-semibold text-slate-700">Rendimenti annuali</div>
            {annualChart.length > 10 && (
              <div className="text-[11px] text-slate-500">Visualizzati ultimi 10 anni</div>
            )}
          </div>
          <div className="h-[260px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={annualChartView} margin={{ top: 20, right: 12, left: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="year" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(value: number) => `${value.toFixed(2)}%`} />
                <Bar dataKey="value">
                  {annualChartView.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.value >= 0 ? CHART_COLORS.positive : CHART_COLORS.negative} />
                  ))}
                  <LabelList dataKey="value" content={renderAnnualLabel} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
};
