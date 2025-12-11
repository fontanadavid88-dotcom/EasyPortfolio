import React, { useMemo, useState } from 'react';
import { db } from '../db';
import { useLiveQuery } from 'dexie-react-hooks';
import { calculatePortfolioState, calculateHistoricalPerformance, calculateAnalytics } from '../services/financeUtils';
import { 
  PRIMARY_BLUE, 
  ACCENT_ORANGE, 
  POSITIVE_GREEN, 
  NEGATIVE_RED, 
  PIE_COLORS, 
  NEUTRAL_TEXT, 
  NEUTRAL_MUTED, 
  BORDER_COLOR,
} from '../constants';
import { 
  PieChart, Pie, Cell, ResponsiveContainer, LineChart, Line, Tooltip, XAxis, YAxis, CartesianGrid, 
  AreaChart, Area, BarChart, Bar, ReferenceLine 
} from 'recharts';
import { format, subMonths, getYear } from 'date-fns';
import clsx from 'clsx';

// --- STYLED SUB-COMPONENTS ---

// 1. KPI Card Style (Glass Effect)
const KPICard = ({ title, value, subValue, highlight = false, alert = false }: { title: string, value: string, subValue?: string, highlight?: boolean, alert?: boolean }) => (
  <div className="bg-panel backdrop-blur-sm p-6 rounded-xl border border-panel-border shadow-card flex flex-col justify-between h-36 transition-all hover:translate-y-[-2px] hover:shadow-lg hover:border-primary/30 relative overflow-hidden group">
    {/* Decorative gradient blob */}
    <div className="absolute -right-6 -top-6 w-20 h-20 bg-primary/5 rounded-full blur-xl group-hover:bg-primary/10 transition-colors"></div>
    
    <div className="flex justify-between items-start relative z-10">
      <span className="text-[11px] font-bold text-panel-muted uppercase tracking-widest">{title}</span>
      {(highlight || alert) && (
        <span className={clsx("w-2 h-2 rounded-full shadow-[0_0_8px_currentColor]", highlight ? "bg-secondary text-secondary" : "bg-negative text-negative")}></span>
      )}
    </div>
    
    <div className="mt-auto relative z-10">
      <div 
        className={clsx("text-2xl font-bold tracking-tight mb-1", alert ? "text-negative" : "text-panel-text")}
      >
        {value}
      </div>
      {subValue && (
        <div className="text-xs font-medium text-panel-muted flex items-center gap-1">
          {subValue}
        </div>
      )}
    </div>
  </div>
);

// 2. Stacked Allocation Bar (100% Stacked Single Bar)
const StackedAllocation: React.FC<{ data: { label: string, value: number, color: string }[] }> = ({ data }) => {
  if (!data.length) return <div className="text-xs text-panel-muted italic">Nessun dato disponibile</div>;

  return (
    <div className="w-full flex flex-col h-full">
      {/* The Single 100% Stacked Bar */}
      <div className="h-8 w-full flex rounded-lg overflow-hidden bg-gray-100 border border-panel-border shadow-inner">
        {data.map((d) => (
          <div 
            key={d.label}
            style={{ width: `${d.value}%`, backgroundColor: d.color }}
            className="h-full relative group transition-all duration-700 ease-in-out hover:brightness-110"
            title={`${d.label}: ${d.value.toFixed(1)}%`}
          >
             {/* Tooltip on hover usually handled by title or custom CSS, keeping it simple */}
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3">
        {data.map((d) => (
          <div key={d.label} className="flex items-center justify-between text-xs group p-1.5 rounded hover:bg-gray-50 transition-colors">
            <div className="flex items-center gap-2 overflow-hidden">
              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0 shadow-sm" style={{ backgroundColor: d.color }}></div>
              <span className="font-semibold text-panel-text truncate group-hover:text-primary transition-colors">{d.label}</span>
            </div>
            <span className="text-panel-muted font-bold flex-shrink-0">{d.value.toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// 3. Filter Button Style
const FilterButton: React.FC<{ active: boolean, label: string, onClick: () => void }> = ({ active, label, onClick }) => (
  <button
    onClick={onClick}
    className={clsx(
      "px-4 py-1.5 rounded-md text-xs font-bold transition-all border backdrop-blur-sm",
      active 
        ? "bg-secondary text-white border-secondary shadow-md shadow-secondary/20" 
        : "bg-white/5 text-shell-muted border-white/10 hover:border-white/30 hover:text-white"
    )}
  >
    {label}
  </button>
);

// --- MAIN DASHBOARD COMPONENT ---

export const Dashboard: React.FC = () => {
  const transactions = useLiveQuery(() => db.transactions.toArray());
  const prices = useLiveQuery(() => db.prices.toArray());
  const instruments = useLiveQuery(() => db.instruments.toArray());

  const [timeRange, setTimeRange] = useState<'3M' | '6M' | '1Y' | '5Y' | '10Y' | 'YTD' | 'MAX'>('MAX');
  const [metric, setMetric] = useState<'PERF' | 'TWRR' | 'MWRR'>('PERF');

  const state = useMemo(() => {
    if (!transactions || !prices || !instruments) return null;
    return calculatePortfolioState(transactions, instruments, prices);
  }, [transactions, prices, instruments]);

  const rawTrends = useMemo(() => {
    if (!transactions || !prices || !instruments) return null;
    return calculateHistoricalPerformance(transactions, instruments, prices, 120); 
  }, [transactions, prices, instruments]);

  const analytics = useMemo(() => {
    if (!rawTrends) return null;
    return calculateAnalytics(rawTrends.history);
  }, [rawTrends]);

  const instrumentAllocationData = useMemo(() => {
    if (!state) return [];
    return state.positions
      .map(p => ({
        name: p.ticker,
        fullName: p.name,
        value: p.currentValueCHF,
        pct: p.currentPct
      }))
      .filter(d => d.value > 0)
      .sort((a, b) => b.value - a.value);
  }, [state]);

  const startDate = useMemo(() => {
    const now = new Date();
    switch (timeRange) {
      case '3M': return subMonths(now, 3);
      case '6M': return subMonths(now, 6);
      case '1Y': return subMonths(now, 12);
      case '5Y': return subMonths(now, 60);
      case '10Y': return subMonths(now, 120);
      case 'YTD': return new Date(now.getFullYear(), 0, 1);
      default: return new Date(0); 
    }
  }, [timeRange]);

  const chartData = useMemo(() => {
    if (!rawTrends) return [];
    const data = [...rawTrends.history];
    return data
      .filter(d => new Date(d.date) >= startDate)
      .map(d => ({
        ...d,
        displayDate: format(new Date(d.date), 'MMM yy'),
        metricValue: metric === 'PERF' ? d.value : 
                     metric === 'TWRR' ? d.cumulativeReturnPct : 
                     (d.invested > 0 ? ((d.value - d.invested) / d.invested) * 100 : 0)
      }));
  }, [rawTrends, startDate, metric]);

  const drawdownData = useMemo(() => {
    if (!analytics || !rawTrends) return [];
    return analytics.drawdownSeries
      .filter(d => new Date(d.date) >= startDate)
      .map(d => ({
        ...d,
        displayDate: format(new Date(d.date), 'MMM yy')
      }));
  }, [analytics, rawTrends, startDate]);

  const filteredAnnualReturns = useMemo(() => {
    if (!analytics) return [];
    const startYear = getYear(startDate);
    if (timeRange === 'MAX') return analytics.annualReturns;
    return analytics.annualReturns.filter(d => d.year >= startYear);
  }, [analytics, startDate, timeRange]);

  const assetAllocationData = useMemo(() => {
    if (!state) return [];
    const groups: Record<string, number> = {};
    state.positions.forEach(p => groups[p.assetType] = (groups[p.assetType] || 0) + p.currentPct);
    
    return Object.entries(groups)
      .sort((a,b) => b[1] - a[1])
      .map(([label, value], idx) => ({
        label,
        value,
        color: PIE_COLORS[idx % PIE_COLORS.length]
      }));
  }, [state]);

  const currencyAllocationData = useMemo(() => {
    if (!state) return [];
    const groups: Record<string, number> = {};
    state.positions.forEach(p => groups[p.currency] = (groups[p.currency] || 0) + p.currentPct);
    
    return Object.entries(groups)
      .sort((a,b) => b[1] - a[1])
      .map(([label, value], idx) => ({
        label,
        value,
        color: PIE_COLORS[(idx + 2) % PIE_COLORS.length]
      }));
  }, [state]);

  if (!transactions) return <div className="p-10 text-center text-shell-muted animate-pulse">Sincronizzazione dati...</div>;
  if (transactions.length === 0) return (
    <div className="flex flex-col items-center justify-center h-96 bg-panel backdrop-blur-sm rounded-xl border border-dashed border-panel-border shadow-card">
       <span className="material-symbols-outlined text-4xl text-panel-muted mb-2 opacity-50">add_chart</span>
       <p className="text-panel-text font-medium">Nessun dato.</p>
       <p className="text-sm text-panel-muted">Aggiungi transazioni per iniziare.</p>
    </div>
  );
  if (!state || !rawTrends || !analytics) return null;

  return (
    <div className="space-y-8 pb-20 animate-fade-in">
      
      {/* ROW 1: Pie + KPI Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        
        {/* LEFT: Instrument Allocation Pie */}
        <div className="lg:col-span-4 bg-panel backdrop-blur-sm p-6 rounded-xl border border-panel-border shadow-card flex flex-col h-full relative overflow-hidden">
          <div className="absolute top-0 right-0 w-32 h-32 bg-primary/5 rounded-bl-full pointer-events-none"></div>
          
          <h3 className="text-xs font-bold text-panel-muted uppercase tracking-widest mb-6 flex items-center gap-2 relative z-10">
             <span className="material-symbols-outlined text-[18px] text-primary">pie_chart</span> Composizione
          </h3>
          <div className="flex-1 min-h-[240px] relative">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={instrumentAllocationData}
                  cx="50%"
                  cy="50%"
                  innerRadius={70}
                  outerRadius={90}
                  paddingAngle={4}
                  dataKey="value"
                  stroke="none"
                >
                  {instrumentAllocationData.map((entry, index) => (
                    <Cell 
                      key={`cell-${index}`} 
                      fill={PIE_COLORS[index % PIE_COLORS.length]} 
                    />
                  ))}
                </Pie>
                <Tooltip 
                  formatter={(value: number) => `CHF ${value.toLocaleString()}`} 
                  contentStyle={{ borderRadius: '8px', border: `1px solid ${BORDER_COLOR}`, boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)', color: NEUTRAL_TEXT }}
                  itemStyle={{ color: NEUTRAL_TEXT, fontWeight: 600, fontSize: '13px' }}
                />
              </PieChart>
            </ResponsiveContainer>
            {/* Center Total */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none flex-col">
                <div className="text-[10px] text-panel-muted font-bold uppercase tracking-widest">Totale</div>
                <div className="text-xl font-bold text-primary">{(state.totalValue / 1000).toFixed(1)}k</div>
            </div>
          </div>
          {/* Legend */}
          <div className="mt-4 border-t border-panel-border pt-4 max-h-48 overflow-y-auto pr-2 space-y-3 custom-scrollbar">
             {instrumentAllocationData.map((d, idx) => (
               <div key={d.name} className="flex items-center justify-between text-xs group">
                 <div className="flex items-center gap-2.5">
                   <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: PIE_COLORS[idx % PIE_COLORS.length] }}></div>
                   <span className="font-semibold text-panel-text truncate max-w-[120px] group-hover:text-primary transition-colors" title={d.fullName}>{d.name}</span>
                 </div>
                 <span className="font-bold text-panel-muted">{d.pct.toFixed(1)}%</span>
               </div>
             ))}
          </div>
        </div>

        {/* CENTER/RIGHT: KPI Grid */}
        <div className="lg:col-span-8 grid grid-cols-2 md:grid-cols-3 gap-6 content-start">
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
            subValue="CAGR (Pesato)"
            highlight
          />
          <KPICard 
            title="Deviazione Std" 
            value={`${analytics.stdDev.toFixed(2)}%`} 
            subValue="Volatilità 1Y"
          />
          <KPICard 
            title="Sharpe Ratio" 
            value={analytics.sharpeRatio.toFixed(2)} 
          />
          <KPICard 
            title="Drawdown Max" 
            value={`${analytics.maxDrawdown.toFixed(2)}%`} 
            subValue="Dal picco max"
            alert
          />
        </div>
      </div>

      {/* FILTER BAR */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 py-2 sticky top-20 bg-shell/90 backdrop-blur z-10 border-b border-white/5 pb-4">
        <h2 className="text-sm font-bold text-shell-text uppercase tracking-widest hidden md:block">
            Analisi Temporale
        </h2>
        <div className="flex flex-col sm:flex-row gap-4 w-full md:w-auto">
            {/* Metric Toggle */}
            <div className="flex gap-2">
              {(['PERF', 'TWRR', 'MWRR'] as const).map(m => (
                <FilterButton 
                    key={m} 
                    active={metric === m} 
                    label={m === 'PERF' ? 'Valore' : m} 
                    onClick={() => setMetric(m)} 
                />
              ))}
            </div>

            {/* Separator */}
            <div className="hidden sm:block w-px bg-white/10 mx-2"></div>

            {/* Time Toggle */}
            <div className="flex gap-2 overflow-x-auto pb-1 sm:pb-0">
              {(['3M', '6M', '1Y', '5Y', 'YTD', 'MAX'] as const).map(t => (
                <FilterButton 
                    key={t} 
                    active={timeRange === t} 
                    label={t} 
                    onClick={() => setTimeRange(t)} 
                />
              ))}
            </div>
        </div>
      </div>

      {/* ROW 2: Performance Chart */}
      <div className="bg-panel backdrop-blur-sm p-6 rounded-xl border border-panel-border shadow-card">
        <h3 className="text-xs font-bold text-panel-muted uppercase tracking-widest mb-6 flex items-center gap-2">
           <span className="material-symbols-outlined text-[18px] text-primary">show_chart</span> Andamento Portafoglio
        </h3>

        <div className="h-[400px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 10, right: 0, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={BORDER_COLOR} opacity={0.5} />
              <XAxis 
                dataKey="displayDate" 
                tick={{fontSize: 11, fill: NEUTRAL_MUTED}} 
                axisLine={false} 
                tickLine={false} 
                minTickGap={50}
                dy={10}
              />
              <YAxis 
                tick={{fontSize: 11, fill: NEUTRAL_MUTED}} 
                axisLine={false} 
                tickLine={false}
                domain={['auto', 'auto']}
                unit={metric === 'PERF' ? '' : '%'}
                dx={-10}
              />
              <Tooltip 
                contentStyle={{ borderRadius: '8px', border: `1px solid ${BORDER_COLOR}`, padding: '12px', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)' }}
                formatter={(val: number) => [
                  <span className="font-bold text-neutral-text">{metric === 'PERF' ? `CHF ${val.toLocaleString()}` : `${val.toFixed(2)}%`}</span>, 
                  <span className="text-xs uppercase text-panel-muted">{metric === 'PERF' ? 'Valore' : metric}</span>
                ]}
                labelStyle={{ color: NEUTRAL_MUTED, fontSize: '12px', marginBottom: '8px' }}
              />
              <Line 
                type="monotone" 
                dataKey="metricValue" 
                stroke={PRIMARY_BLUE} 
                strokeWidth={3} 
                dot={false} 
                activeDot={{ r: 6, strokeWidth: 0, fill: ACCENT_ORANGE }}
                animationDuration={800}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ROW 3: Annual Returns & Drawdowns */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        
        {/* Annual Returns */}
        <div className="bg-panel backdrop-blur-sm p-6 rounded-xl border border-panel-border shadow-card">
           <h3 className="text-xs font-bold text-panel-muted uppercase tracking-widest mb-6 flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px]">bar_chart</span> Ritorni Annuali
           </h3>
           <div className="h-72 w-full">
             <ResponsiveContainer width="100%" height="100%">
               <BarChart data={filteredAnnualReturns}>
                 <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={BORDER_COLOR} opacity={0.5} />
                 <XAxis dataKey="year" tick={{fontSize: 11, fill: NEUTRAL_MUTED}} axisLine={false} tickLine={false} dy={10} />
                 <Tooltip 
                    cursor={{fill: '#f3f4f6'}}
                    contentStyle={{ borderRadius: '8px', border: `1px solid ${BORDER_COLOR}`, boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)' }}
                    formatter={(val: number) => [`${val.toFixed(2)}%`, 'Ritorno']}
                 />
                 <ReferenceLine y={0} stroke={BORDER_COLOR} />
                 <Bar dataKey="returnPct" radius={[4, 4, 0, 0]}>
                    {filteredAnnualReturns.map((entry, index) => (
                      <Cell 
                        key={`cell-${index}`} 
                        fill={entry.returnPct >= 0 ? POSITIVE_GREEN : NEGATIVE_RED} 
                      />
                    ))}
                 </Bar>
               </BarChart>
             </ResponsiveContainer>
           </div>
        </div>

        {/* Drawdowns */}
        <div className="bg-panel backdrop-blur-sm p-6 rounded-xl border border-panel-border shadow-card">
           <h3 className="text-xs font-bold text-panel-muted uppercase tracking-widest mb-6 flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px] text-negative">trending_down</span> Drawdowns
           </h3>
           <div className="h-72 w-full">
             <ResponsiveContainer width="100%" height="100%">
               <AreaChart data={drawdownData}>
                 <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={BORDER_COLOR} opacity={0.5} />
                 <XAxis 
                   dataKey="displayDate" 
                   tick={{fontSize: 11, fill: NEUTRAL_MUTED}} 
                   axisLine={false} 
                   tickLine={false} 
                   minTickGap={50}
                   dy={10}
                 />
                 <YAxis 
                   tick={{fontSize: 11, fill: NEUTRAL_MUTED}} 
                   axisLine={false} 
                   tickLine={false} 
                   unit="%"
                   dx={-10}
                 />
                 <Tooltip 
                    contentStyle={{ borderRadius: '8px', border: `1px solid ${BORDER_COLOR}`, boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)' }}
                    formatter={(val: number) => [`${val.toFixed(2)}%`, 'Drawdown']}
                 />
                 <defs>
                    <linearGradient id="colorDrawdown" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={NEGATIVE_RED} stopOpacity={0.1}/>
                      <stop offset="95%" stopColor={NEGATIVE_RED} stopOpacity={0}/>
                    </linearGradient>
                 </defs>
                 <Area 
                   type="stepAfter" 
                   dataKey="depth" 
                   stroke={NEGATIVE_RED}
                   fill="url(#colorDrawdown)" 
                   strokeWidth={2}
                   animationDuration={800}
                 />
               </AreaChart>
             </ResponsiveContainer>
           </div>
        </div>
      </div>

      {/* ROW 4: Stacked Allocation Bars (100% Single Bar) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <div className="bg-panel backdrop-blur-sm p-6 rounded-xl border border-panel-border shadow-card flex flex-col">
           <h3 className="text-xs font-bold text-panel-muted uppercase tracking-widest mb-6 border-b border-panel-border pb-3 flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px]">donut_small</span> Allocazione Asset Class
           </h3>
           <StackedAllocation data={assetAllocationData} />
        </div>

        <div className="bg-panel backdrop-blur-sm p-6 rounded-xl border border-panel-border shadow-card flex flex-col">
           <h3 className="text-xs font-bold text-panel-muted uppercase tracking-widest mb-6 border-b border-panel-border pb-3 flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px]">currency_exchange</span> Esposizione Valutaria
           </h3>
           <StackedAllocation data={currencyAllocationData} />
        </div>
      </div>

    </div>
  );
};