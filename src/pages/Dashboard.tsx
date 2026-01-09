import React, { useMemo, useState } from 'react';
import { db } from '../db';
import { useLiveQuery } from 'dexie-react-hooks';
import { calculatePortfolioState, calculateHistoricalPerformance, calculateAnalytics } from '../services/financeUtils';
import {
  PRIMARY_BLUE,
  ACCENT_ORANGE,
  POSITIVE_GREEN,
  NEGATIVE_RED,
  COLORS,
  CHART_COLORS,
  NEUTRAL_TEXT,
  NEUTRAL_MUTED,
  CARD_BG,
  BORDER_COLOR
} from '../constants';
import {
  PieChart, Pie, Cell, ResponsiveContainer, LineChart, Line, Tooltip, XAxis, YAxis, CartesianGrid,
  AreaChart, Area, BarChart, Bar, ReferenceLine
} from 'recharts';
import { format, subMonths, getYear } from 'date-fns';
import clsx from 'clsx';

// --- Sub-Components ---

const KPICard = ({ title, value, subValue, highlight = false, alert = false }: { title: string, value: string, subValue?: string, highlight?: boolean, alert?: boolean }) => (
  <div className="bg-backgroundElevated p-5 rounded-2xl border border-borderSoft shadow-lg flex flex-col justify-between h-32 transition-transform hover:-translate-y-1 duration-300 relative overflow-hidden group">
    {/* Glow Effect */}
    <div className="absolute top-0 right-0 w-20 h-20 bg-primary/5 rounded-full blur-xl -mr-10 -mt-10 transition-opacity group-hover:opacity-100 opacity-50" />

    <div className="flex justify-between items-start z-10">
      <span className="text-[11px] font-bold text-textMuted uppercase tracking-wider">{title}</span>
      {highlight && <span className="w-1.5 h-1.5 rounded-full shadow-[0_0_8px_rgba(249,115,22,0.6)]" style={{ backgroundColor: ACCENT_ORANGE }}></span>}
      {alert && <span className="w-1.5 h-1.5 rounded-full shadow-[0_0_8px_rgba(220,38,38,0.6)]" style={{ backgroundColor: NEGATIVE_RED }}></span>}
    </div>
    <div className="mt-2 z-10">
      <div
        className={clsx("text-2xl font-bold tracking-tight", alert ? "text-textPrimary" : "text-textPrimary")}
        style={{ color: highlight ? PRIMARY_BLUE : undefined, textShadow: highlight ? '0 0 20px rgba(0,82,163,0.3)' : 'none' }}
      >
        {value}
      </div>
      {subValue && <div className="text-xs text-textMuted font-medium mt-1">{subValue}</div>}
    </div>
  </div>
);

const ProgressBar: React.FC<{ label: string, value: number, color: string, icon?: string }> = ({ label, value, color, icon }) => (
  <div className="flex items-center gap-4 mb-3 p-3 rounded-xl bg-backgroundDark/50 border border-borderSoft hover:border-primary/30 transition-colors group">
    {icon && <span className="material-symbols-outlined text-gray-500 text-[20px]">{icon}</span>}
    <div className="w-28 text-xs font-semibold text-gray-400 truncate group-hover:text-gray-200 transition-colors">{label}</div>
    <div className="flex-1 h-2 bg-backgroundDark rounded-full overflow-hidden border border-white/5">
      <div
        className="h-full rounded-full transition-all duration-1000 ease-out shadow-[0_0_10px_rgba(0,0,0,0.3)] relative"
        style={{ width: `${value}%`, backgroundColor: color }}
      >
        <div className="absolute inset-0 bg-white/20" />
      </div>
    </div>
    <div className="w-12 text-right text-xs font-bold text-gray-300">{value.toFixed(1)}%</div>
  </div>
);

// --- Main Dashboard ---

export const Dashboard: React.FC = () => {
  const transactions = useLiveQuery(() => db.transactions.toArray());
  const prices = useLiveQuery(() => db.prices.toArray());
  const instruments = useLiveQuery(() => db.instruments.toArray());

  // --- Filter State (Global) ---
  const [timeRange, setTimeRange] = useState<'3M' | '6M' | '1Y' | '5Y' | '10Y' | 'YTD' | 'MAX'>('MAX');
  const [metric, setMetric] = useState<'PERF' | 'TWRR' | 'MWRR'>('PERF');

  // --- Calculations ---
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

  // --- Data Preparation (Filtered by TimeRange) ---

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

  // Common Date Calculation
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

  // 1. Performance Chart Data
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

  // 2. Drawdown Chart Data
  const drawdownData = useMemo(() => {
    if (!analytics || !rawTrends) return [];
    return analytics.drawdownSeries
      .filter(d => new Date(d.date) >= startDate)
      .map(d => ({
        ...d,
        displayDate: format(new Date(d.date), 'MMM yy')
      }));
  }, [analytics, rawTrends, startDate]);

  // 3. Annual Returns (Filtered Bars)
  const filteredAnnualReturns = useMemo(() => {
    if (!analytics) return [];
    const startYear = getYear(startDate);

    // For MAX, return all. For others, return years >= start year of filter
    if (timeRange === 'MAX') return analytics.annualReturns;

    return analytics.annualReturns.filter(d => d.year >= startYear);
  }, [analytics, startDate, timeRange]);

  // 4. Bar Data
  const assetBars = useMemo(() => {
    if (!state) return [];
    const groups: Record<string, number> = {};
    state.positions.forEach(p => groups[p.assetType] = (groups[p.assetType] || 0) + p.currentPct);
    return Object.entries(groups).sort((a, b) => b[1] - a[1]);
  }, [state]);

  const currencyBars = useMemo(() => {
    if (!state) return [];
    const groups: Record<string, number> = {};
    state.positions.forEach(p => groups[p.currency] = (groups[p.currency] || 0) + p.currentPct);
    return Object.entries(groups).sort((a, b) => b[1] - a[1]);
  }, [state]);

  if (!transactions) return <div className="p-10 text-center text-textMuted flex flex-col items-center gap-3"><span className="material-symbols-outlined animate-spin text-primary">donut_large</span> Caricamento...</div>;
  if (transactions.length === 0) return (
    <div className="flex flex-col items-center justify-center h-96 bg-backgroundElevated rounded-2xl border border-dashed border-borderSoft">
      <span className="material-symbols-outlined text-4xl text-textMuted mb-2 opacity-50">add_chart</span>
      <p className="text-textMuted">Nessun dato. Aggiungi transazioni per iniziare.</p>
    </div>
  );
  if (!state || !rawTrends || !analytics) return null;

  return (
    <div className="space-y-6 pb-20 animate-fade-in text-textPrimary">

      {/* ROW 1: Pie + KPIs */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

        {/* LEFT: Instrument Allocation Pie (4 cols) */}
        <div className="lg:col-span-4 bg-backgroundElevated p-6 rounded-2xl border border-borderSoft shadow-xl flex flex-col relative overflow-hidden">
          <div className="absolute top-0 right-0 w-32 h-32 bg-primary/5 rounded-full blur-2xl -mr-16 -mt-16 pointer-events-none" />

          <h3 className="font-bold text-textPrimary mb-6 text-xs uppercase tracking-wider flex items-center gap-2 z-10">
            <span className="w-1 h-4 rounded-full bg-primary shadow-[0_0_10px_rgba(0,82,163,0.5)]"></span> Composizione
          </h3>
          <div className="flex-1 min-h-[220px] relative z-10">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={instrumentAllocationData}
                  cx="50%"
                  cy="50%"
                  innerRadius={65}
                  outerRadius={85}
                  paddingAngle={4}
                  dataKey="value"
                  stroke="none"
                >
                  {instrumentAllocationData.map((entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={COLORS[index % COLORS.length]}
                      stroke="rgba(0,0,0,0.2)"
                      strokeWidth={1}
                    />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value: number) => `CHF ${value.toLocaleString()}`}
                  contentStyle={{
                    borderRadius: '12px',
                    border: `1px solid ${BORDER_COLOR}`,
                    backgroundColor: CARD_BG,
                    color: NEUTRAL_TEXT,
                    boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.3)'
                  }}
                  itemStyle={{ color: NEUTRAL_TEXT, fontWeight: 600 }}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none flex-col">
              <div className="text-[10px] text-textMuted font-bold uppercase tracking-widest">Totale</div>
              <div className="text-xl font-bold text-primary drop-shadow-sm">{(state.totalValue / 1000).toFixed(1)}k</div>
            </div>
          </div>
          <div className="mt-4 max-h-44 overflow-y-auto pr-2 space-y-2 custom-scrollbar z-10">
            {instrumentAllocationData.map((d, idx) => (
              <div key={d.name} className="flex items-center justify-between text-xs group p-2 rounded-lg hover:bg-white/5 transition-colors">
                <div className="flex items-center gap-2.5">
                  <div className="w-2 h-2 rounded-full shadow-[0_0_5px_rgba(0,0,0,0.5)]" style={{ backgroundColor: COLORS[idx % COLORS.length] }}></div>
                  <span className="font-medium text-gray-400 group-hover:text-gray-200 truncate max-w-[140px]" title={d.fullName}>{d.name}</span>
                </div>
                <span className="font-bold text-gray-300 bg-backgroundDark/50 px-2 py-0.5 rounded border border-white/5">{d.pct.toFixed(1)}%</span>
              </div>
            ))}
          </div>
        </div>

        {/* CENTER/RIGHT: KPI Grid (8 cols) */}
        <div className="lg:col-span-8 grid grid-cols-2 md:grid-cols-3 gap-4">
          <KPICard
            title="Capitale Iniziale"
            value={`CHF ${(state.investedCapital / 1000).toFixed(1)}k`}
            subValue="Investito Netto"
          />
          <KPICard
            title="Capitale Finale"
            value={`CHF ${(state.totalValue / 1000).toFixed(1)}k`}
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

      {/* GLOBAL FILTERS TOOLBAR */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 py-2 sticky top-[75px] bg-backgroundDark/90 backdrop-blur z-10 border-b border-borderSoft/50 mb-4 px-2 -mx-2 rounded-b-xl">
        <h2 className="text-lg font-bold text-white hidden md:block pl-2">Analisi Temporale</h2>
        <div className="flex flex-col sm:flex-row gap-3 w-full md:w-auto">
          {/* Metric Toggle (BLUE) */}
          <div className="flex bg-backgroundElevated p-1 rounded-xl shadow-lg border border-borderSoft">
            {(['PERF', 'TWRR', 'MWRR'] as const).map(m => (
              <button
                key={m}
                onClick={() => setMetric(m)}
                className={clsx(
                  "px-4 py-1.5 rounded-lg text-xs font-bold transition-all",
                  metric === m ? "text-white shadow-lg bg-primary" : "text-gray-500 hover:text-gray-300 hover:bg-white/5"
                )}
              >
                {m === 'PERF' ? 'Valore' : m}
              </button>
            ))}
          </div>

          {/* Time Toggle (ORANGE ACCENT) */}
          <div className="flex bg-backgroundElevated p-1 rounded-xl shadow-lg border border-borderSoft overflow-x-auto no-scrollbar">
            {(['3M', '6M', '1Y', '5Y', 'YTD', 'MAX'] as const).map(t => (
              <button
                key={t}
                onClick={() => setTimeRange(t)}
                className={clsx(
                  "px-3 py-1.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap",
                  timeRange === t ? "text-white shadow-lg bg-secondary" : "text-gray-500 hover:text-gray-300 hover:bg-white/5"
                )}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ROW 2: Performance Chart */}
      <div className="bg-backgroundElevated p-6 rounded-2xl border border-borderSoft shadow-xl relative">
        <h3 className="font-bold text-textPrimary text-xs uppercase tracking-wider mb-6 flex items-center gap-2">
          <span className="w-1 h-4 rounded-full bg-primary shadow-[0_0_10px_rgba(0,82,163,0.5)]"></span> Andamento Portafoglio
        </h3>

        <div className="h-[380px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 5, right: 0, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={PRIMARY_BLUE} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={PRIMARY_BLUE} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#334155" opacity={0.3} />
              <XAxis
                dataKey="displayDate"
                tick={{ fontSize: 11, fill: '#64748b' }}
                axisLine={false}
                tickLine={false}
                minTickGap={40}
                dy={10}
              />
              <YAxis
                tick={{ fontSize: 11, fill: '#64748b' }}
                axisLine={false}
                tickLine={false}
                domain={['auto', 'auto']}
                unit={metric === 'PERF' ? '' : '%'}
                dx={-10}
              />
              <Tooltip
                contentStyle={{
                  borderRadius: '12px',
                  border: `1px solid ${BORDER_COLOR}`,
                  backgroundColor: CARD_BG,
                  color: NEUTRAL_TEXT,
                  boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.5)'
                }}
                formatter={(val: number) => [
                  <span className="font-bold text-white">{metric === 'PERF' ? `CHF ${val.toLocaleString()}` : `${val.toFixed(2)}%`}</span>,
                  <span className="text-xs uppercase text-gray-400">{metric === 'PERF' ? 'Valore' : metric}</span>
                ]}
                labelStyle={{ color: '#94a3b8', fontSize: '12px', marginBottom: '8px' }}
              />
              <Area
                type="monotone"
                dataKey="metricValue"
                stroke={PRIMARY_BLUE}
                fillOpacity={1}
                fill="url(#colorValue)"
                strokeWidth={3}
                animationDuration={1000}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ROW 3: Annual Returns & Drawdowns */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Annual Returns */}
        <div className="bg-backgroundElevated p-6 rounded-2xl border border-borderSoft shadow-xl">
          <h3 className="font-bold text-textPrimary text-xs uppercase tracking-wider mb-6 flex items-center gap-2">
            <span className="w-1 h-4 rounded-full bg-gray-500"></span> Ritorni Annuali
          </h3>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={filteredAnnualReturns}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#334155" opacity={0.3} />
                <XAxis dataKey="year" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} dy={10} />
                <Tooltip
                  cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                  contentStyle={{
                    borderRadius: '8px',
                    border: `1px solid ${BORDER_COLOR}`,
                    backgroundColor: CARD_BG,
                    color: NEUTRAL_TEXT
                  }}
                  formatter={(val: number) => [`${val.toFixed(2)}%`, 'Ritorno']}
                />
                <ReferenceLine y={0} stroke="#475569" />
                <Bar dataKey="returnPct" radius={[4, 4, 0, 0]}>
                  {filteredAnnualReturns.map((entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={entry.returnPct >= 0 ? POSITIVE_GREEN : NEGATIVE_RED}
                      stroke={entry.returnPct >= 0 ? 'rgba(22,163,74,0.3)' : 'rgba(220,38,38,0.3)'}
                      strokeWidth={1}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Drawdowns */}
        <div className="bg-backgroundElevated p-6 rounded-2xl border border-borderSoft shadow-xl">
          <h3 className="font-bold text-textPrimary text-xs uppercase tracking-wider mb-6 flex items-center gap-2">
            <span className="w-1 h-4 rounded-full bg-negative shadow-[0_0_10px_rgba(220,38,38,0.5)]"></span> Drawdowns
          </h3>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={drawdownData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#334155" opacity={0.3} />
                <XAxis
                  dataKey="displayDate"
                  tick={{ fontSize: 11, fill: '#64748b' }}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={40}
                  dy={10}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: '#64748b' }}
                  axisLine={false}
                  tickLine={false}
                  unit="%"
                  dx={-10}
                />
                <Tooltip
                  contentStyle={{
                    borderRadius: '8px',
                    border: `1px solid ${BORDER_COLOR}`,
                    backgroundColor: CARD_BG,
                    color: NEUTRAL_TEXT
                  }}
                  formatter={(val: number) => [`${val.toFixed(2)}%`, 'Drawdown']}
                />
                <defs>
                  <linearGradient id="colorDrawdown" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={NEGATIVE_RED} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={NEGATIVE_RED} stopOpacity={0} />
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

      {/* ROW 4: Allocation Bars */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-backgroundElevated p-6 rounded-2xl border border-borderSoft shadow-xl">
          <h3 className="font-bold text-textPrimary text-xs uppercase tracking-wider mb-6 border-b border-borderSoft pb-2">Allocazione Asset Class</h3>
          <div>
            {assetBars.map(([name, val], idx) => (
              <ProgressBar key={name} label={name} value={val} color={COLORS[idx % COLORS.length]} icon="category" />
            ))}
          </div>
        </div>

        <div className="bg-backgroundElevated p-6 rounded-2xl border border-borderSoft shadow-xl">
          <h3 className="font-bold text-textPrimary text-xs uppercase tracking-wider mb-6 border-b border-borderSoft pb-2">Esposizione Valutaria</h3>
          <div>
            {currencyBars.map(([name, val], idx) => (
              <ProgressBar key={name} label={name} value={val} color={COLORS[(idx + 3) % COLORS.length]} icon="payments" />
            ))}
          </div>
        </div>
      </div>

    </div>
  );
};