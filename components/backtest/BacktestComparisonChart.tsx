import React from 'react';
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid, Legend } from 'recharts';
import { BacktestComparisonSeries } from '../../services/backtestComparison';
import { CHART_COLORS } from '../../constants';

const formatPct = (value?: number) => {
  if (value === undefined || value === null || !Number.isFinite(value)) return '-';
  return `${value.toFixed(2)}%`;
};

export const BacktestComparisonChart: React.FC<{
  seriesData: BacktestComparisonSeries;
  labelA: string;
  labelB: string;
}> = ({ seriesData, labelA, labelB }) => {
  const renderTooltip = ({ label, payload }: any) => {
    if (!payload || payload.length === 0) return null;
    const aValue = payload.find((p: any) => p.dataKey === 'aIndex')?.value as number | undefined;
    const bValue = payload.find((p: any) => p.dataKey === 'bIndex')?.value as number | undefined;
    const delta = (aValue !== undefined && bValue !== undefined) ? bValue - aValue : undefined;
    return (
      <div className="bg-white border border-slate-200 rounded-md px-3 py-2 text-xs text-slate-700 space-y-1">
        <div className="font-semibold">Data: {label}</div>
        <div>{labelA}: {formatPct(aValue)}</div>
        <div>{labelB}: {formatPct(bValue)}</div>
        <div>Delta: {formatPct(delta)}</div>
      </div>
    );
  };

  if (seriesData.warning) {
    return (
      <div className="ui-panel p-5">
        <div className="text-sm font-semibold text-slate-700 mb-2">Confronto NAV (indice 100)</div>
        <div className="text-xs text-amber-700">{seriesData.warning}</div>
      </div>
    );
  }

  if (!seriesData.series.length) {
    return (
      <div className="ui-panel p-5">
        <div className="text-sm font-semibold text-slate-700 mb-2">Confronto NAV (indice 100)</div>
        <div className="text-xs text-slate-500">Nessuna serie disponibile.</div>
      </div>
    );
  }

  return (
    <div className="ui-panel p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-semibold text-slate-700">Confronto NAV (indice 100)</div>
        {seriesData.rangeStart && seriesData.rangeEnd && (
          <div className="text-xs text-slate-500">Range comune: {seriesData.rangeStart} {'->'} {seriesData.rangeEnd}</div>
        )}
      </div>
      <div className="h-[280px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={seriesData.series} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip content={renderTooltip} />
            <Legend
              formatter={(value) => {
                if (value === 'aIndex') return labelA;
                if (value === 'bIndex') return labelB;
                return value;
              }}
            />
            <Line type="monotone" dataKey="aIndex" stroke={CHART_COLORS.line} strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="bIndex" stroke={CHART_COLORS.positive} strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};
