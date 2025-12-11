import React, { useMemo, useState } from 'react';
import { db } from '../db';
import { useLiveQuery } from 'dexie-react-hooks';
import { calculatePortfolioState, calculateHistoricalPerformance, calculateAnalytics } from '../services/financeUtils';
import { COLORS } from '../constants';
import { 
  PieChart, Pie, Cell, ResponsiveContainer, LineChart, Line, Tooltip, XAxis, YAxis, CartesianGrid, 
  AreaChart, Area, BarChart, Bar, ReferenceLine 
} from 'recharts';
import { format, subMonths } from 'date-fns';
import clsx from 'clsx';

// --- Sub-Components ---

const KPICard = ({ title, value, subValue, highlight = false }: { title: string, value: string, subValue?: string, highlight?: boolean }) => (
  <div className="bg-white p-4 rounded-xl border border-gray-100 shadow-sm flex flex-col justify-between h-28">
    <span className="text-xs font-bold text-gray-400 uppercase tracking-wide">{title}</span>
    <div className="mt-1">
      <div className={clsx("text-xl font-bold", highlight ? "text-blue-600" : "text-gray-900")}>
        {value}
      </div>
      {subValue && <div className="text-xs text-gray-400 font-medium mt-1">{subValue}</div>}
    </div>
  </div>
);

const ProgressBar: React.FC<{ label: string, value: number, color: string }> = ({ label, value, color }) => (
  <div className="flex items-center gap-3 mb-3">
    <div className="w-24 text-xs font-bold text-gray-600 truncate">{label}</div>
    <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
      <div 
        className="h-full rounded-full transition-all duration-500" 
        style={{ width: `${value}%`, backgroundColor: color }}
      />
    </div>
    <div className="w-12 text-right text-xs font-bold text-gray-900">{value.toFixed(1)}%</div>
  </div>
);

// --- Main Dashboard ---

export const Dashboard: React.FC = () => {
  const transactions = useLiveQuery(() => db.transactions.toArray());
  const prices = useLiveQuery(() => db.prices.toArray());
  const instruments = useLiveQuery(() => db.instruments.toArray());

  // --- Filter State ---
  const [timeRange, setTimeRange] = useState<'3M' | '6M' | '1Y' | '5Y' | '10Y' | 'YTD' | 'MAX'>('MAX');
  const [metric, setMetric] = useState<'PERF' | 'TWRR' | 'MWRR'>('PERF');

  // --- Calculations ---
  const state = useMemo(() => {
    if (!transactions || !prices || !instruments) return null;
    return calculatePortfolioState(transactions, instruments, prices);
  }, [transactions, prices, instruments]);

  const rawTrends = useMemo(() => {
    if (!transactions || !prices || !instruments) return null;
    // Get full history first, then filter for display
    return calculateHistoricalPerformance(transactions, instruments, prices, 120); // Get up to 10 years
  }, [transactions, prices, instruments]);

  const analytics = useMemo(() => {
    if (!rawTrends) return null;
    return calculateAnalytics(rawTrends.history);
  }, [rawTrends]);

  // --- Data Preparation for Charts ---

  // 1. Pie Data (Instruments)
  const instrumentAllocationData = useMemo(() => {
    if (!state) return [];
    return state.positions
      .map(p => ({
        name: p.ticker, // Using Ticker for brevity in legend
        fullName: p.name,
        value: p.currentValueCHF,
        pct: p.currentPct
      }))
      .filter(d => d.value > 0)
      .sort((a, b) => b.value - a.value);
  }, [state]);

  // 2. Filtered History for Performance Chart
  const chartData = useMemo(() => {
    if (!rawTrends) return [];
    let data = [...rawTrends.history];
    const now = new Date();
    let startDate: Date;

    switch (timeRange) {
      case '3M': startDate = subMonths(now, 3); break;
      case '6M': startDate = subMonths(now, 6); break;
      case '1Y': startDate = subMonths(now, 12); break;
      case '5Y': startDate = subMonths(now, 60); break;
      case '10Y': startDate = subMonths(now, 120); break;
      case 'YTD': startDate = new Date(now.getFullYear(), 0, 1); break;
      default: startDate = new Date(0); // MAX
    }

    // Filter and Format
    return data
      .filter(d => new Date(d.date) >= startDate)
      .map(d => ({
        ...d,
        displayDate: format(new Date(d.date), 'MMM yy'),
        // Map metrics
        metricValue: metric === 'PERF' ? d.value : 
                     metric === 'TWRR' ? d.cumulativeReturnPct : 
                     // Simple MWRR proxy: (Value - Invested) / Invested. 
                     // True MWRR needs XIRR solving which is heavy for frontend series.
                     (d.invested > 0 ? ((d.value - d.invested) / d.invested) * 100 : 0)
      }));
  }, [rawTrends, timeRange, metric]);

  // 3. Drawdown Series (Filtered by same time range or MAX?)
  // Usually Drawdown chart matches the performance chart range.
  const drawdownData = useMemo(() => {
    if (!analytics || !rawTrends) return [];
    // Match the time filtering logic of chartData
    const now = new Date();
    let startDate: Date;
    switch (timeRange) {
      case '3M': startDate = subMonths(now, 3); break;
      case '6M': startDate = subMonths(now, 6); break;
      case '1Y': startDate = subMonths(now, 12); break;
      case '5Y': startDate = subMonths(now, 60); break;
      case '10Y': startDate = subMonths(now, 120); break;
      case 'YTD': startDate = new Date(now.getFullYear(), 0, 1); break;
      default: startDate = new Date(0);
    }
    
    return analytics.drawdownSeries
      .filter(d => new Date(d.date) >= startDate)
      .map(d => ({
        ...d,
        displayDate: format(new Date(d.date), 'MMM yy')
      }));
  }, [analytics, rawTrends, timeRange]);

  // 4. Asset & Currency Bars (Current)
  const assetBars = useMemo(() => {
    if (!state) return [];
    const groups: Record<string, number> = {};
    state.positions.forEach(p => groups[p.assetType] = (groups[p.assetType] || 0) + p.currentPct);
    return Object.entries(groups).sort((a,b) => b[1] - a[1]);
  }, [state]);

  const currencyBars = useMemo(() => {
    if (!state) return [];
    const groups: Record<string, number> = {};
    state.positions.forEach(p => groups[p.currency] = (groups[p.currency] || 0) + p.currentPct);
    return Object.entries(groups).sort((a,b) => b[1] - a[1]);
  }, [state]);


  // --- Loading / Empty States ---

  if (!transactions) return <div className="p-10 text-center text-gray-400">Caricamento...</div>;
  if (transactions.length === 0) return (
    <div className="flex flex-col items-center justify-center h-96 bg-white rounded-2xl border border-dashed border-gray-200">
       <span className="material-symbols-outlined text-4xl text-gray-300 mb-2">add_chart</span>
       <p className="text-gray-500">Nessun dato. Aggiungi transazioni per iniziare.</p>
    </div>
  );
  if (!state || !rawTrends || !analytics) return null;

  // --- Render ---

  return (
    <div className="space-y-6 pb-20 animate-fade-in text-gray-800">
      
      {/* ROW 1: Pie + KPIs */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* LEFT: Instrument Allocation Pie */}
        <div className="lg:col-span-1 bg-white p-6 rounded-2xl border border-gray-100 shadow-sm flex flex-col">
          <h3 className="font-bold text-gray-800 mb-4 text-sm uppercase tracking-wide">Composizione Strumenti</h3>
          <div className="flex-1 min-h-[250px] relative">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={instrumentAllocationData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={80}
                  paddingAngle={2}
                  dataKey="value"
                >
                  {instrumentAllocationData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} strokeWidth={0} />
                  ))}
                </Pie>
                <Tooltip 
                  formatter={(value: number) => `CHF ${value.toLocaleString()}`} 
                  contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                />
              </PieChart>
            </ResponsiveContainer>
            {/* Center Total */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="text-center">
                <div className="text-xs text-gray-400 font-bold uppercase">Totale</div>
                <div className="text-lg font-bold text-gray-800">{(state.totalValue / 1000).toFixed(1)}k</div>
              </div>
            </div>
          </div>
          {/* Custom Legend */}
          <div className="mt-4 max-h-40 overflow-y-auto pr-2 space-y-2">
             {instrumentAllocationData.map((d, idx) => (
               <div key={d.name} className="flex items-center justify-between text-xs">
                 <div className="flex items-center gap-2">
                   <div className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[idx % COLORS.length] }}></div>
                   <span className="font-medium text-gray-700 truncate max-w-[120px]" title={d.fullName}>{d.name}</span>
                 </div>
                 <span className="font-bold text-gray-900">{d.pct.toFixed(1)}%</span>
               </div>
             ))}
          </div>
        </div>

        {/* CENTER/RIGHT: KPI Grid */}
        <div className="lg:col-span-2 grid grid-cols-2 md:grid-cols-3 gap-4">
          <KPICard 
            title="Capitale Iniziale" 
            value={`CHF ${(state.investedCapital/1000).toFixed(1)}k`} 
            subValue="Investito Netto"
          />
          <KPICard 
            title="Capitale Finale" 
            value={`CHF ${(state.totalValue/1000).toFixed(1)}k`} 
            subValue="Valore Attuale"
            highlight
          />
          <KPICard 
            title="Rendimento Annuo" 
            value={`${analytics.annualizedReturn.toFixed(2)}%`} 
            subValue="CAGR"
            highlight
          />
          <KPICard 
            title="Deviazione Std" 
            value={`${analytics.stdDev.toFixed(2)}%`} 
            subValue="Volatilità"
          />
          <KPICard 
            title="Sharpe Ratio" 
            value={analytics.sharpeRatio.toFixed(2)} 
          />
          <KPICard 
            title="Drawdown Max" 
            value={`${analytics.maxDrawdown.toFixed(2)}%`} 
            subValue="Dal picco max"
            // highlight color red manually
          />
        </div>
      </div>

      {/* ROW 2: Performance Chart */}
      <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between mb-6 gap-4">
          <h3 className="font-bold text-gray-800 text-sm uppercase tracking-wide">Analisi Performance</h3>
          
          <div className="flex flex-col sm:flex-row gap-4">
            {/* Metric Toggle */}
            <div className="flex bg-gray-100 rounded-lg p-1">
              {(['PERF', 'TWRR', 'MWRR'] as const).map(m => (
                <button
                  key={m}
                  onClick={() => setMetric(m)}
                  className={clsx(
                    "px-3 py-1 rounded-md text-xs font-bold transition-all",
                    metric === m ? "bg-white text-blue-600 shadow-sm" : "text-gray-500 hover:text-gray-700"
                  )}
                >
                  {m === 'PERF' ? 'Valore' : m}
                </button>
              ))}
            </div>

            {/* Time Toggle */}
            <div className="flex bg-gray-100 rounded-lg p-1 overflow-x-auto">
              {(['3M', '6M', '1Y', '5Y', 'YTD', 'MAX'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setTimeRange(t)}
                  className={clsx(
                    "px-3 py-1 rounded-md text-xs font-bold transition-all whitespace-nowrap",
                    timeRange === t ? "bg-white text-blue-600 shadow-sm" : "text-gray-500 hover:text-gray-700"
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="h-[350px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f3f4f6" />
              <XAxis 
                dataKey="displayDate" 
                tick={{fontSize: 11, fill: '#9ca3af'}} 
                axisLine={false} 
                tickLine={false} 
                minTickGap={30}
              />
              <YAxis 
                tick={{fontSize: 11, fill: '#9ca3af'}} 
                axisLine={false} 
                tickLine={false}
                domain={['auto', 'auto']}
                unit={metric === 'PERF' ? '' : '%'}
              />
              <Tooltip 
                contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                formatter={(val: number) => [
                  metric === 'PERF' ? `CHF ${val.toLocaleString()}` : `${val.toFixed(2)}%`, 
                  metric === 'PERF' ? 'Valore' : metric
                ]}
              />
              <Line 
                type="monotone" 
                dataKey="metricValue" 
                stroke="#2563eb" 
                strokeWidth={2} 
                dot={false} 
                activeDot={{ r: 6, strokeWidth: 0 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ROW 3: Annual Returns & Drawdowns */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        {/* Annual Returns */}
        <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
           <h3 className="font-bold text-gray-800 text-sm uppercase tracking-wide mb-6">Ritorni Annuali</h3>
           <div className="h-64 w-full">
             <ResponsiveContainer width="100%" height="100%">
               <BarChart data={analytics.annualReturns}>
                 <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f3f4f6" />
                 <XAxis dataKey="year" tick={{fontSize: 11, fill: '#9ca3af'}} axisLine={false} tickLine={false} />
                 <Tooltip 
                    cursor={{fill: '#f9fafb'}}
                    contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                    formatter={(val: number) => [`${val.toFixed(2)}%`, 'Ritorno']}
                 />
                 <ReferenceLine y={0} stroke="#e5e7eb" />
                 <Bar dataKey="returnPct" radius={[4, 4, 0, 0]}>
                    {analytics.annualReturns.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.returnPct >= 0 ? '#10b981' : '#ef4444'} />
                    ))}
                 </Bar>
               </BarChart>
             </ResponsiveContainer>
           </div>
        </div>

        {/* Drawdowns */}
        <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
           <h3 className="font-bold text-gray-800 text-sm uppercase tracking-wide mb-6">Drawdowns</h3>
           <div className="h-64 w-full">
             <ResponsiveContainer width="100%" height="100%">
               <AreaChart data={drawdownData}>
                 <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f3f4f6" />
                 <XAxis 
                   dataKey="displayDate" 
                   tick={{fontSize: 11, fill: '#9ca3af'}} 
                   axisLine={false} 
                   tickLine={false} 
                   minTickGap={40}
                 />
                 <YAxis 
                   tick={{fontSize: 11, fill: '#9ca3af'}} 
                   axisLine={false} 
                   tickLine={false} 
                   unit="%"
                 />
                 <Tooltip 
                    contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                    formatter={(val: number) => [`${val.toFixed(2)}%`, 'Drawdown']}
                 />
                 <Area 
                   type="stepAfter" 
                   dataKey="depth" 
                   stroke="#ef4444" 
                   fill="#fee2e2" 
                   strokeWidth={2}
                 />
               </AreaChart>
             </ResponsiveContainer>
           </div>
        </div>
      </div>

      {/* ROW 4: Allocation Bars */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
           <h3 className="font-bold text-gray-800 text-sm uppercase tracking-wide mb-6">Allocazione Asset Class</h3>
           <div>
             {assetBars.map(([name, val], idx) => (
                <ProgressBar key={name} label={name} value={val} color={COLORS[idx % COLORS.length]} />
             ))}
           </div>
        </div>

        <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
           <h3 className="font-bold text-gray-800 text-sm uppercase tracking-wide mb-6">Esposizione Valutaria</h3>
           <div>
             {currencyBars.map(([name, val], idx) => (
                <ProgressBar key={name} label={name} value={val} color={COLORS[(idx + 2) % COLORS.length]} />
             ))}
           </div>
        </div>
      </div>

    </div>
  );
};