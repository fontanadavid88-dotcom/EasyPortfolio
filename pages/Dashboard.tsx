import React, { useMemo } from 'react';
import { db } from '../db';
import { useLiveQuery } from 'dexie-react-hooks';
import { calculatePortfolioState, calculateHistoricalPerformance } from '../services/financeUtils';
import { AssetType } from '../types';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line, BarChart, Bar, ComposedChart } from 'recharts';
import { COLORS } from '../constants';

const Sparkline = ({ data, color }: { data: any[], color: string }) => {
  if (!data || data.length === 0) return <div className="h-8 w-24 bg-gray-50 rounded"></div>;
  
  return (
    <div className="h-8 w-24">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <Line type="monotone" dataKey="pct" stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

export const Dashboard: React.FC = () => {
  const transactions = useLiveQuery(() => db.transactions.toArray());
  const prices = useLiveQuery(() => db.prices.toArray());
  const instruments = useLiveQuery(() => db.instruments.toArray());

  // 1. Calculate Current State
  const state = useMemo(() => {
    if (!transactions || !prices || !instruments) return null;
    return calculatePortfolioState(transactions, instruments, prices);
  }, [transactions, prices, instruments]);

  // 2. Calculate History & Trends
  const trends = useMemo(() => {
    if (!transactions || !prices || !instruments) return null;
    return calculateHistoricalPerformance(transactions, instruments, prices);
  }, [transactions, prices, instruments]);

  // 3. Prepare Data for Pie Chart (Group by Asset Class)
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

  // 4. Gap Analysis Data
  const gapData = useMemo(() => {
    if (!state) return [];
    
    // Map current assets to their classes
    const classMap: Record<string, { current: number, target: number }> = {};
    
    // Init classes
    Object.values(AssetType).forEach(t => classMap[t] = { current: 0, target: 0 });

    state.positions.forEach(p => {
        if(classMap[p.assetType]) {
            classMap[p.assetType].current += p.currentPct;
            classMap[p.assetType].target += p.targetPct;
        }
    });

    return Object.entries(classMap)
      .filter(([_, d]) => d.current > 0 || d.target > 0)
      .map(([name, d]) => ({
        name,
        current: d.current,
        target: d.target,
        diff: d.current - d.target
      }));

  }, [state]);

  // Loading State
  if (!transactions) return (
      <div className="flex flex-col items-center justify-center h-96 text-gray-400">
          <span className="material-symbols-outlined text-4xl mb-2 animate-pulse">sync</span>
          <p>Caricamento dati...</p>
      </div>
  );

  // Empty State (No Transactions)
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
      
      {/* RIGA 1: KPI CARDS */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Total Value */}
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 transition hover:shadow-md">
            <p className="text-gray-500 text-xs font-bold uppercase mb-1 flex items-center gap-1">
                <span className="material-symbols-outlined text-[16px]">account_balance</span> Capitale Attuale
            </p>
            <h3 className="text-2xl font-bold text-gray-900">
                CHF {state.totalValue.toLocaleString('it-CH', { maximumFractionDigits: 0 })}
            </h3>
        </div>

        {/* Invested */}
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 transition hover:shadow-md">
            <p className="text-gray-500 text-xs font-bold uppercase mb-1 flex items-center gap-1">
                <span className="material-symbols-outlined text-[16px]">payments</span> Capitale Investito
            </p>
            <h3 className="text-2xl font-bold text-gray-900">
                CHF {state.investedCapital.toLocaleString('it-CH', { maximumFractionDigits: 0 })}
            </h3>
        </div>

        {/* Balance */}
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 transition hover:shadow-md">
            <p className="text-gray-500 text-xs font-bold uppercase mb-1 flex items-center gap-1">
                <span className="material-symbols-outlined text-[16px]">show_chart</span> Bilancio
            </p>
            <div className="flex items-end gap-2">
                <h3 className={`text-2xl font-bold ${state.balance >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {state.balance >= 0 ? '+' : ''}{state.balance.toLocaleString('it-CH', { maximumFractionDigits: 0 })}
                </h3>
                <span className={`text-sm font-bold mb-1 px-2 py-0.5 rounded ${state.balance >= 0 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                    {state.balancePct.toFixed(1)}%
                </span>
            </div>
        </div>
      </div>

      {/* RIGA 2: ALLOCATION PIE & PERFORMANCE CHART */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        {/* Allocation */}
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 flex flex-col">
            <h3 className="text-gray-800 font-bold mb-4 flex items-center gap-2">
                <span className="material-symbols-outlined text-blue-600">pie_chart</span>
                Composizione Portafoglio
            </h3>
            {assetAllocationData.length > 0 ? (
                <div className="flex flex-col sm:flex-row items-center gap-6 h-full">
                    <div className="w-48 h-48 flex-shrink-0">
                        <ResponsiveContainer width="100%" height="100%">
                            <PieChart>
                                <Pie
                                    data={assetAllocationData}
                                    innerRadius={60}
                                    outerRadius={80}
                                    paddingAngle={5}
                                    dataKey="value"
                                >
                                    {assetAllocationData.map((entry, index) => (
                                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                                    ))}
                                </Pie>
                                <Tooltip formatter={(value: number) => `CHF ${value.toLocaleString()}`} />
                            </PieChart>
                        </ResponsiveContainer>
                    </div>
                    <div className="flex-1 w-full overflow-y-auto max-h-48 pr-2">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-gray-400 text-xs border-b border-gray-100">
                                    <th className="text-left py-1">Asset</th>
                                    <th className="text-right py-1">Valore</th>
                                    <th className="text-right py-1">%</th>
                                </tr>
                            </thead>
                            <tbody>
                                {assetAllocationData.map((d, i) => (
                                    <tr key={d.name} className="border-b border-gray-50 last:border-0">
                                        <td className="py-2 flex items-center gap-2">
                                            <div className="w-2 h-2 rounded-full" style={{backgroundColor: COLORS[i % COLORS.length]}}></div>
                                            {d.name}
                                        </td>
                                        <td className="text-right py-2 font-mono text-xs">{d.value.toLocaleString('it-CH', {maximumFractionDigits: 0})}</td>
                                        <td className="text-right py-2 font-bold text-gray-600">{d.pct.toFixed(1)}%</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            ) : (
                <div className="flex-1 flex items-center justify-center text-gray-400 text-sm italic">
                    Nessun dato di allocazione
                </div>
            )}
        </div>

        {/* Performance Graph */}
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 h-80 flex flex-col">
             <h3 className="text-gray-800 font-bold mb-4 flex items-center gap-2">
                <span className="material-symbols-outlined text-purple-600">monitoring</span>
                Evoluzione Performance
            </h3>
            <div className="flex-1 w-full min-h-0">
                <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={trends.history}>
                        <XAxis dataKey="date" tick={{fontSize: 10}} tickLine={false} axisLine={false} />
                        <YAxis yAxisId="left" hide />
                        <YAxis yAxisId="right" orientation="right" tick={{fontSize: 10}} axisLine={false} tickLine={false} width={30} />
                        <Tooltip 
                            contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                            labelStyle={{ color: '#6b7280', fontWeight: 'bold' }}
                        />
                        <Bar yAxisId="right" dataKey="monthlyReturnPct" fill="#e2e8f0" barSize={20} radius={[4, 4, 0, 0]} name="Rend. Mensile %" />
                        <Line yAxisId="right" type="monotone" dataKey="cumulativeReturnPct" stroke="#8884d8" strokeWidth={2} dot={false} name="Cumulativo %" />
                    </ComposedChart>
                </ResponsiveContainer>
            </div>
        </div>
      </div>

      {/* RIGA 3: ASSET CLASS TRENDS & GAPS */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        {/* Asset Class Trends */}
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
            <h3 className="text-gray-800 font-bold mb-4">Asset Class nel tempo</h3>
            <div className="space-y-4">
                {(Object.entries(trends.assetHistory) as [string, {date: string, pct: number}[]][])
                    .filter(([_, h]) => h.length > 0 && h[h.length-1].pct > 1) // Show only significant assets
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

        {/* Gap Analysis */}
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
            <h3 className="text-gray-800 font-bold mb-4">Analisi Scostamenti</h3>
            <table className="w-full text-sm">
                <thead>
                    <tr className="text-gray-400 text-xs border-b border-gray-100 text-left">
                        <th className="py-2">Class</th>
                        <th className="py-2 text-right">Target</th>
                        <th className="py-2 text-right">Attuale</th>
                        <th className="py-2 text-right">Diff</th>
                    </tr>
                </thead>
                <tbody>
                    {gapData.map(g => {
                        const isOver = g.diff > 2;
                        const isUnder = g.diff < -2;
                        return (
                            <tr key={g.name} className="border-b border-gray-50 last:border-0">
                                <td className="py-3 font-medium text-gray-700">{g.name}</td>
                                <td className="py-3 text-right text-gray-500">{g.target.toFixed(1)}%</td>
                                <td className="py-3 text-right font-bold">{g.current.toFixed(1)}%</td>
                                <td className="py-3 text-right">
                                    <span className={`px-2 py-1 rounded text-xs font-bold ${
                                        isOver ? 'bg-red-100 text-red-700' : 
                                        isUnder ? 'bg-blue-100 text-blue-700' : 
                                        'bg-green-100 text-green-700'
                                    }`}>
                                        {g.diff > 0 ? '+' : ''}{g.diff.toFixed(1)}%
                                    </span>
                                </td>
                            </tr>
                        );
                    })}
                    {gapData.length === 0 && (
                        <tr><td colSpan={4} className="text-center py-4 text-gray-400 text-xs">Nessun target impostato o dati insufficienti.</td></tr>
                    )}
                </tbody>
            </table>
        </div>
      </div>

      {/* RIGA 4: CURRENCY TRENDS */}
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
          <h3 className="text-gray-800 font-bold mb-4">Esposizione Valute nel tempo</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
             {(Object.entries(trends.currencyHistory) as [string, {date: string, pct: number}[]][])
                .filter(([_, h]) => h.length > 0 && h[h.length-1].pct > 0.5)
                .map(([name, history], idx) => (
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