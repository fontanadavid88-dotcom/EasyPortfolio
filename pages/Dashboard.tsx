import React, { useMemo } from 'react';
import { db } from '../db';
import { useLiveQuery } from 'dexie-react-hooks';
import { calculatePortfolioState, calculateHistoricalPerformance } from '../services/financeUtils';
import { AssetType } from '../types';
import { COLORS } from '../constants';
import { PieChart, Pie, Cell, ResponsiveContainer, LineChart, Line, Tooltip, XAxis, YAxis, CartesianGrid, Legend, ComposedChart, Bar } from 'recharts';

// Simple Sparkline Component
const Sparkline = ({ data, color }: { data: any[], color: string }) => (
  <div className="h-8 w-24">
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data}>
        <Line type="monotone" dataKey="pct" stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  </div>
);

export const Dashboard: React.FC = () => {
  const transactions = useLiveQuery(() => db.transactions.toArray());
  const prices = useLiveQuery(() => db.prices.toArray());
  const instruments = useLiveQuery(() => db.instruments.toArray());

  const state = useMemo(() => {
    if (!transactions || !prices || !instruments) return null;
    return calculatePortfolioState(transactions, instruments, prices);
  }, [transactions, prices, instruments]);

  const trends = useMemo(() => {
    if (!transactions || !prices || !instruments) return null;
    return calculateHistoricalPerformance(transactions, instruments, prices);
  }, [transactions, prices, instruments]);

  const assetAllocationData = useMemo(() => {
    if (!state) return [];
    const groups: Record<string, number> = {};
    state.positions.forEach(p => {
        groups[p.assetType] = (groups[p.assetType] || 0) + p.currentValueCHF;
    });
    return Object.entries(groups).map(([name, value]) => ({
        name,
        value,
        pct: state.totalValue > 0 ? (value / state.totalValue) * 100 : 0
    })).filter(d => d.value > 0).sort((a,b) => b.value - a.value);
  }, [state]);

  const gapHierarchy = useMemo(() => {
    if (!state) return [];

    const classMap: Record<string, {
      current: number;
      target: number;
      instruments: { name: string; ticker: string; current: number; target: number; diff: number }[];
    }> = {};

    Object.values(AssetType).forEach(t => {
      classMap[t] = { current: 0, target: 0, instruments: [] };
    });

    state.positions.forEach(p => {
      if (!classMap[p.assetType]) return;

      classMap[p.assetType].current += p.currentPct;
      classMap[p.assetType].target += p.targetPct;
      classMap[p.assetType].instruments.push({
        name: p.name,
        ticker: p.ticker,
        current: p.currentPct,
        target: p.targetPct,
        diff: p.currentPct - p.targetPct
      });
    });

    return Object.entries(classMap)
      .filter(([_, d]) => d.current > 0 || d.target > 0)
      .map(([name, d]) => ({
        name,
        current: d.current,
        target: d.target,
        diff: d.current - d.target,
        instruments: d.instruments.sort((a, b) => b.current - a.current)
      }))
      .sort((a, b) => b.current - a.current);

  }, [state]);

  const getHeatmapZone = (diff: number) => {
    if (diff <= -5) return { label: 'Sottopesato grave', className: 'bg-blue-700 text-white' };
    if (diff < -1) return { label: 'Sottopesato lieve', className: 'bg-blue-200 text-blue-900' };
    if (diff <= 1) return { label: 'Neutro', className: 'bg-gray-100 text-gray-700' };
    if (diff < 5) return { label: 'Sovrappesato lieve', className: 'bg-amber-200 text-amber-900' };
    return { label: 'Sovrappesato grave', className: 'bg-red-500 text-white' };
  };

  if (!transactions) return (
      <div className="flex flex-col items-center justify-center h-96 text-gray-400">
          <span className="material-symbols-outlined text-4xl mb-2 animate-pulse">sync</span>
          <p>Caricamento dati...</p>
      </div>
  );

  if (transactions.length === 0) return (
    <div className="flex flex-col items-center justify-center h-96 text-gray-400 bg-white rounded-2xl border border-dashed border-gray-200">
        <span className="material-symbols-outlined text-5xl mb-4 opacity-30">add_chart</span>
        <h3 className="text-lg font-bold text-gray-600">Nessun dato disponibile</h3>
        <p className="mb-4 text-sm">Aggiungi la tua prima transazione per vedere le analisi.</p>
    </div>
  );

  if (!state || !trends) return null;

  return (
    <div className="space-y-6 pb-20 animate-fade-in">
      
      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
            <p className="text-xs font-bold text-gray-400 uppercase tracking-wider">Valore Totale</p>
            <p className="text-2xl font-bold text-gray-900 mt-1">CHF {state.totalValue.toLocaleString('it-CH', { maximumFractionDigits: 0 })}</p>
        </div>
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
             <p className="text-xs font-bold text-gray-400 uppercase tracking-wider">Capitale Investito</p>
             <p className="text-2xl font-bold text-gray-900 mt-1">CHF {state.investedCapital.toLocaleString('it-CH', { maximumFractionDigits: 0 })}</p>
        </div>
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
             <p className="text-xs font-bold text-gray-400 uppercase tracking-wider">Bilancio</p>
             <div className="flex items-baseline gap-2 mt-1">
                 <span className={`text-2xl font-bold ${state.balance >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                     {state.balance >= 0 ? '+' : ''}{state.balance.toLocaleString('it-CH', { maximumFractionDigits: 0 })}
                 </span>
                 <span className={`text-sm font-bold ${state.balance >= 0 ? 'text-green-600' : 'text-red-600'} bg-opacity-10 px-2 py-0.5 rounded-full ${state.balance >= 0 ? 'bg-green-100' : 'bg-red-100'}`}>
                     {state.balancePct.toFixed(2)}%
                 </span>
             </div>
        </div>
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 flex flex-col">
              <h3 className="text-gray-800 font-bold mb-4">Composizione Portafoglio</h3>
              <div className="flex-1 min-h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                          <Pie
                              data={assetAllocationData}
                              cx="50%"
                              cy="50%"
                              innerRadius={60}
                              outerRadius={100}
                              paddingAngle={5}
                              dataKey="value"
                          >
                              {assetAllocationData.map((entry, index) => (
                                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                              ))}
                          </Pie>
                          <Tooltip formatter={(value: number) => `CHF ${value.toLocaleString()}`} />
                          <Legend />
                      </PieChart>
                  </ResponsiveContainer>
              </div>
          </div>

          <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 flex flex-col">
              <h3 className="text-gray-800 font-bold mb-4">Performance Storica</h3>
              <div className="flex-1 min-h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={trends.history}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                          <XAxis dataKey="date" tick={{fontSize: 12, fill: '#94a3b8'}} axisLine={false} tickLine={false} />
                          <YAxis yAxisId="left" tick={{fontSize: 12, fill: '#94a3b8'}} axisLine={false} tickLine={false} unit="%" />
                          <YAxis yAxisId="right" orientation="right" hide />
                          <Tooltip />
                          <Legend />
                          <Bar yAxisId="left" dataKey="monthlyReturnPct" name="Mensile %" fill="#cbd5e1" radius={[4, 4, 0, 0]} barSize={20} />
                          <Line yAxisId="left" type="monotone" dataKey="cumulativeReturnPct" name="Cumulativo %" stroke="#0ea5e9" strokeWidth={3} dot={false} />
                      </ComposedChart>
                  </ResponsiveContainer>
              </div>
          </div>
      </div>

      {/* Trends & Gap Analysis Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        {/* Asset Class Trends */}
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
            <h3 className="text-gray-800 font-bold mb-4">Asset Class nel tempo</h3>
            <div className="space-y-4">
                {(Object.entries(trends.assetHistory) as [string, {date: string, pct: number}[]][])
                    .filter(([_, h]) => h.length > 0 && h[h.length-1].pct > 1)
                    .map(([name, history], idx) => (
                    <div key={name} className="flex items-center justify-between">
                        <span className="text-sm font-medium text-gray-600 w-24 truncate">{name}</span>
                        <Sparkline data={history} color={COLORS[idx % COLORS.length]} />
                        <span className="text-sm font-bold text-gray-800 w-12 text-right">
                            {history[history.length-1].pct.toFixed(0)}%
                        </span>
                    </div>
                ))}
            </div>
        </div>

        {/* Gap Analysis Heatmap */}
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
            <h3 className="text-gray-800 font-bold mb-4">Analisi Scostamenti</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                  <thead>
                      <tr className="text-gray-400 text-xs border-b border-gray-100 text-left">
                          <th className="py-2">Asset Class / Strumento</th>
                          <th className="py-2 text-right">Target</th>
                          <th className="py-2 text-right">Attuale</th>
                          <th className="py-2 text-right">Diff</th>
                          <th className="py-2 text-center">Status</th>
                      </tr>
                  </thead>
                  <tbody>
                      {gapHierarchy.map(group => {
                        const zone = getHeatmapZone(group.diff);
                        return (
                          <React.Fragment key={group.name}>
                            <tr className="border-b border-gray-100 bg-gray-50">
                              <td className="py-3 font-bold text-gray-800">{group.name}</td>
                              <td className="py-3 text-right text-gray-500">{group.target.toFixed(1)}%</td>
                              <td className="py-3 text-right font-bold text-gray-800">{group.current.toFixed(1)}%</td>
                              <td className="py-3 text-right">
                                  <span className="px-2 py-1 rounded text-xs font-bold bg-white border border-gray-100">
                                      {group.diff > 0 ? '+' : ''}{group.diff.toFixed(1)}%
                                  </span>
                              </td>
                              <td className="py-3">
                                  <div className={`flex items-center justify-center px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wide ${zone.className}`}>
                                      {zone.label}
                                  </div>
                              </td>
                            </tr>
                            {group.instruments.map(inst => {
                              const instZone = getHeatmapZone(inst.diff);
                              return (
                                <tr key={inst.ticker} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50">
                                  <td className="py-2 pl-6 text-gray-700">
                                      <div className="flex items-center gap-2">
                                          <div className="w-1.5 h-1.5 bg-gray-300 rounded-full"></div>
                                          <div className="flex flex-col">
                                              <span className="font-medium leading-tight">{inst.name}</span>
                                              <span className="text-[10px] uppercase text-gray-400">{inst.ticker}</span>
                                          </div>
                                      </div>
                                  </td>
                                  <td className="py-2 text-right text-gray-500">{inst.target.toFixed(1)}%</td>
                                  <td className="py-2 text-right font-semibold text-gray-800">{inst.current.toFixed(1)}%</td>
                                  <td className="py-2 text-right">
                                      <span className="text-[11px] text-gray-500">
                                          {inst.diff > 0 ? '+' : ''}{inst.diff.toFixed(1)}%
                                      </span>
                                  </td>
                                  <td className="py-2 text-center">
                                      <div className={`inline-block w-24 py-1 rounded text-[9px] font-bold ${instZone.className} bg-opacity-80`}>
                                          {instZone.label}
                                      </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </React.Fragment>
                        );
                      })}
                      {gapHierarchy.length === 0 && (
                          <tr><td colSpan={5} className="text-center py-4 text-gray-400 text-xs">Nessun target impostato o dati insufficienti.</td></tr>
                      )}
                  </tbody>
              </table>
            </div>
        </div>
      </div>

      {/* Currency Trends */}
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
          <h3 className="text-gray-800 font-bold mb-4">Esposizione Valute nel tempo</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
             {(Object.entries(trends.currencyHistory) as [string, {date: string, pct: number}[]][])
                .filter(([_, h]) => h.length > 0 && h[h.length-1].pct > 0.5)
                .map(([name, history]) => (
                <div key={name} className="flex flex-col gap-2">
                    <div className="flex justify-between items-baseline">
                        <span className="text-xs font-bold uppercase text-gray-500">{name}</span>
                        <span className="text-sm font-bold">{history[history.length-1].pct.toFixed(0)}%</span>
                    </div>
                    <div className="h-12 w-full">
                        <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={history}>
                                <Line type="monotone" dataKey="pct" stroke="#64748b" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                            </LineChart>
                        </ResponsiveContainer>
                    </div>
                </div>
             ))}
          </div>
      </div>

    </div>
  );
};