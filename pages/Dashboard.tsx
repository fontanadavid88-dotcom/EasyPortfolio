import React, { useMemo, useState } from 'react';
import { db, getCurrentPortfolioId } from '../db';
import { useLiveQuery } from 'dexie-react-hooks';
import { calculatePortfolioState, calculateHistoricalPerformance, calculateAnalytics, Granularity, calculateAllocationByAssetClass, calculateRegionExposure } from '../services/financeUtils';
import { DEFAULT_INDICATORS, computeMacroIndex, mapIndexToPhase, MacroIndicatorConfig } from '../services/macroService';
import {
  PRIMARY_BLUE,
  ACCENT_ORANGE,
  NEGATIVE_RED,
  COLORS,
  CARD_BG,
  CARD_TEXT,
  BORDER_COLOR
} from '../constants';
import { MACRO_ZONES } from '../constants';
import { MacroGauge } from '../components/MacroGauge';
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid,
  AreaChart, Area, BarChart, Bar, ReferenceLine, LabelList, ReferenceDot
} from 'recharts';
import { format, subMonths, getYear } from 'date-fns';
import clsx from 'clsx';
import { InfoPopover } from '../components/InfoPopover';
import { AssetClass, RegionKey } from '../types';

// --- Sub-Components ---

const KPICard = ({ title, value, subValue, highlight = false, alert = false }: { title: string, value: string, subValue?: string, highlight?: boolean, alert?: boolean }) => (
  <div className="bg-white p-5 rounded-2xl border border-borderSoft shadow-lg flex flex-col justify-between h-32 transition-transform hover:-translate-y-1 duration-300 relative overflow-hidden group">
    {/* Glow Effect */}
    <div className="absolute top-0 right-0 w-20 h-20 bg-[#0052a3]/5 rounded-full blur-xl -mr-10 -mt-10 transition-opacity group-hover:opacity-100 opacity-50" />

    <div className="flex justify-between items-start z-10">
      <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">{title}</span>
      {highlight && <span className="w-1.5 h-1.5 rounded-full shadow-[0_0_8px_rgba(249,115,22,0.6)]" style={{ backgroundColor: ACCENT_ORANGE }}></span>}
      {alert && <span className="w-1.5 h-1.5 rounded-full shadow-[0_0_8px_rgba(220,38,38,0.6)]" style={{ backgroundColor: NEGATIVE_RED }}></span>}
    </div>
    <div className="mt-2 z-10">
      <div
        className={clsx("text-2xl font-bold tracking-tight", alert ? "text-slate-900" : "text-slate-900")}
        style={{ color: highlight ? PRIMARY_BLUE : undefined, textShadow: highlight ? '0 0 20px rgba(0,82,163,0.1)' : 'none' }}
      >
        {value}
      </div>
      {subValue && <div className="text-xs text-slate-500 font-medium mt-1">{subValue}</div>}
    </div>
  </div>
);



const REGION_BUBBLE_POSITIONS: Record<Exclude<RegionKey, 'UNASSIGNED'>, { x: number; y: number }> = {
  NA: { x: 69.3, y: 64.6 },     // Nord America
  LATAM: { x: 114.4, y: 161.2 },// America Latina
  EU: { x: 267.3, y: 37.6 },    // Europa
  CH: { x: 230.2, y: 59 },      // Svizzera area
  AS: { x: 396.6, y: 73.6 },    // Asia
  AF: { x: 245.9, y: 129.8 },   // Africa
  OC: { x: 404.4, y: 152.3 }    // Oceania
};

const RegionBubbleMap = ({ data }: { data: { region: RegionKey; label: string; pct: number }[] }) => {
  const filtered = data.filter(d => d.region !== 'UNASSIGNED') as { region: Exclude<RegionKey, 'UNASSIGNED'>; label: string; pct: number }[];
  const maxPct = filtered.reduce((acc, cur) => Math.max(acc, cur.pct), 0);
  const [showAnchors, setShowAnchors] = useState(false);
  const [dragRegion, setDragRegion] = useState<Exclude<RegionKey, 'UNASSIGNED'> | null>(null);
  const [draftPositions, setDraftPositions] = useState<typeof REGION_BUBBLE_POSITIONS>(REGION_BUBBLE_POSITIONS);

  const getSvgPoint = (e: React.MouseEvent<SVGSVGElement, MouseEvent>) => {
    const svg = e.currentTarget;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const inv = ctm.inverse();
    const svgP = pt.matrixTransform(inv);
    return { x: Number(svgP.x.toFixed(1)), y: Number(svgP.y.toFixed(1)) };
  };

  const handleMapClick = (e: React.MouseEvent<SVGSVGElement, MouseEvent>) => {
    if (!import.meta.env.DEV) return;
    const pt = getSvgPoint(e);
    if (pt) console.log("MAP_COORD", pt);
  };

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement, MouseEvent>) => {
    if (!import.meta.env.DEV || !dragRegion) return;
    const pt = getSvgPoint(e);
    if (!pt) return;
    setDraftPositions(prev => ({ ...prev, [dragRegion]: { x: pt.x, y: pt.y } }));
  };

  const handleMouseUp = () => {
    if (!import.meta.env.DEV || !dragRegion) return;
    const updated = draftPositions;
    console.log("NEW_REGION_POSITIONS", updated);
    setDragRegion(null);
  };

  return (
    <div className="bg-slate-50 border border-borderSoft rounded-xl p-3 relative overflow-hidden h-[240px]">
      {import.meta.env.DEV && (
        <div className="absolute top-2 left-2 flex items-center gap-2 text-[11px] text-slate-500 z-30">
          <span className="px-2 py-0.5 rounded bg-white border border-borderSoft shadow-sm">DEV: click per coordinate</span>
          <button
            type="button"
            className="px-2 py-0.5 rounded bg-white border border-borderSoft shadow-sm hover:bg-slate-100 text-[11px] font-bold"
            onClick={() => setShowAnchors(v => !v)}
          >
            Anchors {showAnchors ? 'ON' : 'OFF'}
          </button>
        </div>
      )}
      <svg
        viewBox="0 0 520 240"
        className="w-full h-full"
        preserveAspectRatio="xMidYMid meet"
        onClick={handleMapClick}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <image href="/World-map.png" x="0" y="0" width="520" height="240" preserveAspectRatio="none" />
        {filtered.map((d, idx) => {
          const pos = draftPositions[d.region];
          const radiusBase = 10;
          const radius = maxPct > 0 ? radiusBase + (d.pct / maxPct) * 20 : radiusBase;
          return (
            <g key={d.region}>
              <circle
                cx={pos.x}
                cy={pos.y}
                r={radius}
                fill={COLORS[idx % COLORS.length]}
                fillOpacity={0.85}
                stroke="white"
                strokeWidth="2"
              />
              <text x={pos.x} y={pos.y + 4} textAnchor="middle" fontSize="11" fontWeight={700} fill="#0f172a">
                {`${d.pct.toFixed(1)}%`}
              </text>
              {import.meta.env.DEV && showAnchors && (
                <g>
                  <line x1={pos.x - 6} y1={pos.y} x2={pos.x + 6} y2={pos.y} stroke="#0f172a" strokeWidth="1" />
                  <line x1={pos.x} y1={pos.y - 6} x2={pos.x} y2={pos.y + 6} stroke="#0f172a" strokeWidth="1" />
                  <text x={pos.x + 8} y={pos.y - 8} fontSize="10" fontWeight={700} fill="#0f172a" opacity={0.9}>
                    {d.region} ({Math.round(pos.x)}, {Math.round(pos.y)})
                  </text>
                  <rect
                    x={pos.x - 10}
                    y={pos.y - 10}
                    width={20}
                    height={20}
                    fill="transparent"
                    cursor="grab"
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      setDragRegion(d.region);
                    }}
                  />
                </g>
              )}
            </g>
          );
        })}
      </svg>
      {filtered.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-500">
          Nessuna allocazione geografica disponibile
        </div>
      )}
    </div>
  );
};

	// --- Main Dashboard ---

export const Dashboard: React.FC = () => {
  const currentPortfolioId = getCurrentPortfolioId();
  const transactions = useLiveQuery(
    () => db.transactions.where('portfolioId').equals(currentPortfolioId).toArray(),
    [currentPortfolioId],
    []
  );
  const prices = useLiveQuery(
    () => db.prices.where('portfolioId').equals(currentPortfolioId).toArray(),
    [currentPortfolioId],
    []
  );
  const instruments = useLiveQuery(
    () => db.instruments.where('portfolioId').equals(currentPortfolioId).toArray(),
    [currentPortfolioId],
    []
  );

  // --- Filter State (Global) ---
  const [timeRange, setTimeRange] = useState<'3M' | '6M' | '1Y' | '5Y' | '10Y' | 'YTD' | 'MAX'>('MAX');
  const [metric, setMetric] = useState<'PERF' | 'TWRR' | 'MWRR'>('PERF');

  // --- Macro State ---
  const [macroConfig] = useState<MacroIndicatorConfig[]>(() => {
    try {
      const saved = localStorage.getItem('macro_indicators_config');
      return saved ? JSON.parse(saved) : DEFAULT_INDICATORS;
    } catch {
      return DEFAULT_INDICATORS;
    }
  });

  const macroState = useMemo(() => {
    const { index01 } = computeMacroIndex(macroConfig);
    const score = Math.round((1 - index01) * 100);
    const zone = score < MACRO_ZONES.CRISIS.max
      ? MACRO_ZONES.CRISIS
      : score < MACRO_ZONES.NEUTRAL.max
        ? MACRO_ZONES.NEUTRAL
        : MACRO_ZONES.EUPHORIA;
    return {
      score,
      phase: mapIndexToPhase(index01),
      color: zone.color
    };
  }, [macroConfig]);

  const granularity: Granularity = useMemo(() => {
    return timeRange === 'MAX' ? 'monthly' : 'daily';
  }, [timeRange]);

  // --- Calculations ---
  const state = useMemo(() => {
    if (!transactions || !prices || !instruments) return null;
    return calculatePortfolioState(transactions, instruments, prices);
  }, [transactions, prices, instruments]);

  const rawTrends = useMemo(() => {
    if (!transactions || !prices || !instruments) return null;
    return calculateHistoricalPerformance(transactions, instruments, prices, 120, granularity);
  }, [transactions, prices, instruments, granularity]);

  const analytics = useMemo(() => {
    if (!rawTrends) return null;
    return calculateAnalytics(rawTrends.history, granularity);
  }, [rawTrends, granularity]);

  // --- Data Preparation (Filtered by TimeRange) ---

  const assetClassAllocationData = useMemo(() => {
    if (!state || !instruments) return [];
    return calculateAllocationByAssetClass(state, instruments);
  }, [state, instruments]);

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

  const lastChartPoint = useMemo(() => {
    if (!chartData.length) return null;
    return chartData[chartData.length - 1];
  }, [chartData]);

  const investedAtEnd = useMemo(() => {
    if (!rawTrends) return 0;
    const filtered = rawTrends.history.filter(d => new Date(d.date) >= startDate);
    if (!filtered.length) return 0;
    return filtered[filtered.length - 1].invested || 0;
  }, [rawTrends, startDate]);

  const renderChartTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload || !payload.length) return null;
    const point = payload[0]?.payload;
    if (!point) return null;

    if (metric === 'PERF') {
      const value = point.value ?? 0;
      const invested = point.invested ?? 0;
      const profit = value - invested;
      const profitPct = invested > 0 ? (profit / invested) * 100 : null;
      return (
        <div className="bg-white border border-borderSoft rounded-xl shadow-xl px-4 py-3 min-w-[220px]">
          <div className="text-xs text-slate-500 mb-1">{point.displayDate || label}</div>
          <div className="flex items-center justify-between text-sm font-bold text-slate-900">
            <span>Valore</span>
            <span>{`CHF ${Math.round(value).toLocaleString()}`}</span>
          </div>
          <div className="flex items-center justify-between text-xs text-slate-600 mt-1">
            <span>Investito</span>
            <span>{`CHF ${Math.round(invested).toLocaleString()}`}</span>
          </div>
          <div className="flex items-center justify-between text-xs mt-1">
            <span className="text-slate-600">Profitto</span>
            <span className={clsx("font-bold", profit >= 0 ? "text-green-600" : "text-red-600")}>
              {`CHF ${Math.round(profit).toLocaleString()}`}{profitPct !== null ? ` (${profitPct.toFixed(2)}%)` : ''}
            </span>
          </div>
        </div>
      );
    }

    const valuePct = typeof point.metricValue === 'number' ? point.metricValue : 0;
    return (
      <div className="bg-white border border-borderSoft rounded-xl shadow-xl px-4 py-3">
        <div className="text-xs text-slate-500 mb-1">{point.displayDate || label}</div>
        <div className="flex items-center justify-between text-sm font-bold text-slate-900">
          <span>{metric}</span>
          <span>{`${valuePct.toFixed(2)}%`}</span>
        </div>
      </div>
    );
  };

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

  const regionExposure = useMemo(() => {
    if (!state || !instruments) return [];
    return calculateRegionExposure(state, instruments);
  }, [state, instruments]);
  const regionData = useMemo(() => regionExposure.filter(r => r.region !== 'UNASSIGNED'), [regionExposure]);
  const unassignedRegion = useMemo(() => regionExposure.find(r => r.region === 'UNASSIGNED'), [regionExposure]);
  const hasIncompleteRegionData = !!(unassignedRegion && unassignedRegion.value > 0);

  // 3. Annual Returns (Filtered Bars)
  const filteredAnnualReturns = useMemo(() => {
    if (!analytics) return [];
    const startYear = getYear(startDate);

    // For MAX, return all. For others, return years >= start year of filter
    if (timeRange === 'MAX') return analytics.annualReturns;

    return analytics.annualReturns.filter(d => d.year >= startYear);
  }, [analytics, startDate, timeRange]);

  // 4. Bar Data
  const currencyBars = useMemo(() => {
    if (!state) return [];
    const groups: Record<string, { value: number; pct: number }> = {};
    state.positions.forEach(p => {
      const current = groups[p.currency] || { value: 0, pct: 0 };
      current.value += p.currentValueCHF;
      groups[p.currency] = current;
    });
    const total = state.totalValue || 0;
    return Object.entries(groups)
      .map(([name, data]) => ({
        name,
        value: data.value,
        pct: total > 0 ? (data.value / total) * 100 : 0
      }))
      .sort((a, b) => b.value - a.value);
  }, [state]);

  // deprecated: legacy inline print removed in favor of Report PDF view
  const currentPortfolio = useLiveQuery(
    () => db.portfolios.where('portfolioId').equals(currentPortfolioId).first(),
    [currentPortfolioId]
  );

  const [macroInfoOpen, setMacroInfoOpen] = useState(false);


  return (
    <div className="space-y-6 pb-20 animate-fade-in text-textPrimary">

      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col">
          <p className="text-xs uppercase tracking-[0.08em] text-slate-500 font-bold">Dashboard</p>
          <p className="text-sm text-slate-500">Portafoglio {currentPortfolio?.name || 'Selezionato'}</p>
        </div>
        <a href="#/report" className="inline-flex items-center gap-2 bg-white border border-borderSoft text-slate-700 px-4 py-2 rounded-xl text-sm font-bold hover:bg-slate-50 transition shadow-sm no-underline">
          <span className="material-symbols-outlined text-base">picture_as_pdf</span>
          Report PDF
        </a>
      </div>

      {/* KPI ROW */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6 gap-3 md:gap-4">
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

      {/* GLOBAL FILTERS TOOLBAR */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 py-4 px-4 sticky top-[75px] bg-slate-100/90 backdrop-blur z-20 border border-borderSoft shadow-sm rounded-xl mb-6 mx-0.5">
        <h2 className="text-lg font-bold text-slate-800 hidden md:block pl-2">Analisi Temporale</h2>
        <div className="flex flex-col sm:flex-row gap-3 w-full md:w-auto">
          {/* Metric Toggle (BLUE) */}
          <div className="flex bg-white p-1 rounded-xl shadow border border-borderSoft">
            {(['PERF', 'TWRR', 'MWRR'] as const).map(m => (
              <button
                key={m}
                onClick={() => setMetric(m)}
                className={clsx(
                  "px-4 py-1.5 rounded-lg text-xs font-bold transition-all",
                  metric === m ? "text-white shadow-md bg-[#0052a3]" : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
                )}
              >
                {m === 'PERF' ? 'Valore' : m}
              </button>
            ))}
          </div>

          {/* Time Toggle (ORANGE ACCENT) */}
          <div className="flex bg-white p-1 rounded-xl shadow border border-borderSoft overflow-x-auto no-scrollbar">
            {(['3M', '6M', '1Y', '5Y', 'YTD', 'MAX'] as const).map(t => (
              <button
                key={t}
                onClick={() => setTimeRange(t)}
                className={clsx(
                  "px-3 py-1.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap",
                  timeRange === t ? "text-white shadow-md bg-[#f97316]" : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
                )}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ROW 2: Performance Chart */}
      <div className="bg-white p-6 rounded-2xl border border-borderSoft shadow-xl relative">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="font-bold text-slate-900 text-xs uppercase tracking-wider flex items-center gap-2">
              <span className="w-1 h-4 rounded-full bg-[#0052a3] shadow-[0_0_10px_rgba(0,82,163,0.5)]"></span> Andamento Portafoglio
            </h3>
          </div>
          <InfoPopover
            ariaLabel="Info grafico rendimento"
            title="Valore vs TWRR vs MWRR"
            renderContent={() => (
              <div className="text-sm space-y-1">
                <p><strong>Valore:</strong> profitto vs investito (CHF).</p>
                <p><strong>TWRR:</strong> rendimento ponderato nel tempo (indipendente dai flussi).</p>
                <p><strong>MWRR:</strong> rendimento ponderato per il denaro (sensibile a depositi/prelievi).</p>
              </div>
            )}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
          <div className="bg-slate-50 border border-borderSoft rounded-xl p-3">
            <div className="text-[11px] uppercase font-bold text-slate-500">Saldo</div>
            <div className="text-xl font-bold text-slate-900">
              {lastChartPoint ? `CHF ${lastChartPoint.value?.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : 'N/D'}
            </div>
          </div>
          <div className="bg-slate-50 border border-borderSoft rounded-xl p-3">
            <div className="flex items-center justify-between">
              <div className="text-[11px] uppercase font-bold text-slate-500">Rendimento</div>
              {metric !== 'PERF' && (
                <span className="text-[11px] text-slate-500">Ultimo</span>
              )}
            </div>
            <div className="text-xl font-bold text-slate-900 flex items-center gap-2">
              {metric === 'PERF' && lastChartPoint && investedAtEnd > 0 ? (
                <>
                  <span>{`CHF ${(lastChartPoint.value - investedAtEnd).toLocaleString(undefined, { maximumFractionDigits: 0 })}`}</span>
                  <span className={clsx("text-sm font-bold", (lastChartPoint.value - investedAtEnd) >= 0 ? "text-green-600" : "text-red-600")}>
                    {`${(((lastChartPoint.value - investedAtEnd) / investedAtEnd) * 100).toFixed(2)}%`}
                  </span>
                </>
              ) : metric !== 'PERF' && lastChartPoint ? (
                <span className={clsx("text-xl font-bold", lastChartPoint.metricValue >= 0 ? "text-green-600" : "text-red-600")}>
                  {`${lastChartPoint.metricValue.toFixed(2)}%`}
                </span>
              ) : (
                'N/D'
              )}
            </div>
          </div>
        </div>

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
              <Tooltip content={renderChartTooltip} />
              <Area
                type="monotone"
                dataKey="metricValue"
                stroke={PRIMARY_BLUE}
                fillOpacity={1}
                fill="url(#colorValue)"
                strokeWidth={3}
                animationDuration={1000}
              />
              {lastChartPoint && (
                <ReferenceDot
                  x={lastChartPoint.displayDate}
                  y={lastChartPoint.metricValue}
                  r={4}
                  fill={PRIMARY_BLUE}
                  stroke="white"
                  strokeWidth={1}
                  ifOverflow="visible"
                  label={{
                    position: 'top',
                    value: metric === 'PERF' ? '' : `${lastChartPoint.metricValue.toFixed(2)}%`,
                    fill: '#0f172a',
                    fontSize: 11,
                    fontWeight: 700
                  }}
                />
              )}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ROW: Annual Returns & Drawdowns */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Annual Returns */}
        <div className="bg-white p-6 rounded-2xl border border-borderSoft shadow-xl">
          <h3 className="font-bold text-slate-900 text-xs uppercase tracking-wider mb-6 flex items-center gap-2">
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
                    color: CARD_TEXT
                  }}
                  formatter={(val: number) => [`${val.toFixed(2)}%`, 'Ritorno']}
                />
                <ReferenceLine y={0} stroke="#475569" />
                <Bar dataKey="returnPct" radius={[4, 4, 0, 0]}>
                  {filteredAnnualReturns.map((entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={entry.returnPct >= 0 ? PRIMARY_BLUE : ACCENT_ORANGE}
                      stroke={entry.returnPct >= 0 ? PRIMARY_BLUE : ACCENT_ORANGE}
                      strokeWidth={1}
                      fillOpacity={0.8}
                    />
                  ))}
                  <LabelList
                    dataKey="returnPct"
                    formatter={(val: number) => `${val >= 0 ? '+' : ''}${val.toFixed(1)}%`}
                    position="top"
                    className="text-[11px] font-bold fill-slate-700"
                    content={(props) => {
                      const { x, y, value } = props as any;
                      if (value === undefined || x === undefined || y === undefined) return null;
                      const val = Number(value);
                      const offset = val >= 0 ? -6 : 14;
                      return (
                        <text x={x} y={y + offset} textAnchor="middle" fontSize={11} fontWeight={700} fill="#334155">
                          {`${val >= 0 ? '+' : ''}${val.toFixed(1)}%`}
                        </text>
                      );
                    }}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Drawdowns */}
        <div className="bg-white p-6 rounded-2xl border border-borderSoft shadow-xl">
          <h3 className="font-bold text-slate-900 text-xs uppercase tracking-wider mb-6 flex items-center gap-2">
            <span className="w-1 h-4 rounded-full shadow-[0_0_10px_rgba(249,115,22,0.5)]" style={{ backgroundColor: ACCENT_ORANGE }}></span> Drawdowns
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
                    color: CARD_TEXT
                  }}
                  formatter={(val: number) => [`${val.toFixed(2)}%`, 'Drawdown']}
                />
                <defs>
                  <linearGradient id="colorDrawdown" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={ACCENT_ORANGE} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={ACCENT_ORANGE} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Area
                  type="monotone"
                  dataKey="depth"
                  stroke={ACCENT_ORANGE}
                  fill="url(#colorDrawdown)"
                  strokeWidth={2}
                  animationDuration={800}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* ROW: Donut cards + Macro */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-white p-6 rounded-2xl border border-borderSoft shadow-xl lg:col-span-2 flex flex-col gap-4">
          <div className="flex items-start justify-between mb-2">
            <div>
              <h3 className="font-bold text-slate-900 text-xs uppercase tracking-wider flex items-center gap-2">
                <span className="w-1 h-4 rounded-full bg-[#0052a3] shadow-[0_0_10px_rgba(0,82,163,0.5)]"></span> Composizione & Valute
              </h3>
              <p className="text-xs text-slate-500 mt-1">Ripartizione per asset class e valuta.</p>
            </div>
            <InfoPopover
              ariaLabel="Info asset class"
              title="Regole pratiche Asset Class"
              renderContent={() => (
                <div className="space-y-2 text-sm">
                  <ul className="list-disc list-inside space-y-1">
                    <li>ETF Azionari: parole chiave MSCI, S&P, Equity, World, EM.</li>
                    <li>ETF Obbligazionari: Bond, Treasury, Aggregate, Corporate, Duration, Inflation.</li>
                    <li>ETC: ETC/ETN o oro/commodity fisiche.</li>
                    <li>Cripto: BTC, ETH, ecc.</li>
                    <li>Puoi correggere l'asset class nel modal Aggiungi Strumento o in Settings.</li>
                  </ul>
                </div>
              )}
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-slate-50 border border-borderSoft rounded-xl p-3">
              <h4 className="text-xs font-bold text-slate-600 mb-2 uppercase">Asset Class</h4>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart margin={{ top: 16, bottom: 8, left: 8, right: 8 }}>
                    <Pie
                      data={assetClassAllocationData}
                      cx="50%"
                      cy="50%"
                      innerRadius={55}
                      outerRadius={90}
                      paddingAngle={4}
                      dataKey="value"
                      stroke="none"
                    >
                      {assetClassAllocationData.map((_entry, index) => (
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
                        color: CARD_TEXT,
                        boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.3)'
                      }}
                      itemStyle={{ color: CARD_TEXT, fontWeight: 600 }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-3 max-h-44 overflow-y-auto pr-1 custom-scrollbar space-y-1.5">
                {assetClassAllocationData.map((d, idx) => (
                  <div key={d.key} className="flex items-center justify-between text-xs px-2 py-1.5 rounded-lg hover:bg-white transition-colors">
                    <div className="flex items-center gap-2.5">
                      <div className="w-2 h-2 rounded-full shadow-[0_0_5px_rgba(0,0,0,0.1)]" style={{ backgroundColor: COLORS[idx % COLORS.length] }}></div>
                      <span className="font-medium text-slate-600 truncate max-w-[140px]" title={d.label}>{d.label}</span>
                    </div>
                    <span className="font-bold text-slate-700 bg-white px-2 py-0.5 rounded border border-black/5">{d.pct.toFixed(1)}%</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="bg-slate-50 border border-borderSoft rounded-xl p-3">
              <h4 className="text-xs font-bold text-slate-600 mb-2 uppercase flex items-center justify-between">
                <span>Valute</span>
                <span className="text-[11px] text-slate-500">Percentuale su CHF</span>
              </h4>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart margin={{ top: 16, bottom: 12, left: 12, right: 12 }}>
                    <Pie
                      data={currencyBars}
                      dataKey="pct"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={55}
                      outerRadius={90}
                      paddingAngle={1.5}
                      stroke="#fff"
                      strokeWidth={2}
                    >
                      {currencyBars.map((entry, idx) => (
                        <Cell key={entry.name} fill={COLORS[(idx + 3) % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(value: number, name: string, props: any) => {
                        const val = props?.payload?.value ?? props?.payload?.pct ?? value;
                        return [`${(val as number).toFixed(1)}%`, name];
                      }}
                      contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', boxShadow: '0 10px 20px -6px rgba(0,0,0,0.15)' }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-3 bg-white border border-borderSoft rounded-xl p-2 space-y-1">
                {currencyBars.map((c, idx) => (
                  <div key={c.name} className="flex items-center justify-between rounded-lg px-2 py-1 hover:bg-slate-50 transition-colors">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: COLORS[(idx + 3) % COLORS.length] }} />
                      <span className="font-medium text-slate-700 text-sm">{c.name}</span>
                    </div>
                    <div className="text-right text-sm leading-tight">
                      <div className="font-bold text-slate-900">{c.pct.toFixed(1)}%</div>
                      <div className="text-[11px] text-slate-500">CHF {Math.round(c.value).toLocaleString()}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
        <div className="bg-white p-6 rounded-2xl border border-borderSoft shadow-xl flex flex-col items-start relative overflow-visible">
          <div className="absolute top-0 right-0 w-32 h-32 bg-[#0052a3]/5 rounded-full blur-2xl -mr-16 -mt-16 pointer-events-none" />
          <div className="w-full flex items-center justify-between mb-4 z-10">
            <h3 className="font-bold text-slate-900 text-xs uppercase tracking-wider flex items-center gap-2">
              <span className="w-1 h-4 rounded-full bg-[#0052a3] shadow-[0_0_10px_rgba(0,82,163,0.5)]"></span> Macro Indicator
            </h3>
            <InfoPopover
              ariaLabel="Info Macro Indicator"
              title="Come interpretare il Macro Indicator"
              onOpenChange={setMacroInfoOpen}
              renderContent={() => (
                <div className="text-sm space-y-1">
                  <p>Il gauge sintetizza il sentiment macro (CRISI → NEUTRO → EUPHORIA).</p>
                  <p>Il punteggio deriva da indicatori configurati (menu Macro) normalizzati 0-100.</p>
                  <p>Zona rossa: rischio alto, zona gialla: neutro/attenzione, zona verde: fase favorevole.</p>
                  <p>Puoi personalizzare gli indicatori dalla sezione Macro, il gauge si aggiorna di conseguenza.</p>
                </div>
              )}
            />
          </div>
          <div className="w-full flex justify-center items-center relative py-4">
            <div
              className="relative"
              style={{
                width: 260,
                height: 220,
                visibility: macroInfoOpen ? 'hidden' : 'visible'
              }}
            >
              <MacroGauge value={macroState.score} />
            </div>
          </div>
        </div>
      </div>

      {/* ROW: Regioni full width */}
      <div className="grid grid-cols-1">
        <div className="bg-white p-6 rounded-2xl border border-borderSoft shadow-xl flex flex-col gap-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="font-bold text-slate-900 text-xs uppercase tracking-wider flex items-center gap-2">
                <span className="w-1 h-4 rounded-full bg-[#0052a3] shadow-[0_0_10px_rgba(0,82,163,0.5)]"></span> Distribuzione geografica
              </h3>
              <p className="text-xs text-slate-500 mt-1">Valori in CHF. Definisci le percentuali per ogni strumento in Settings &gt; Listings &amp; FX.</p>
            </div>
            <div className="flex items-center gap-2">
              {hasIncompleteRegionData && (
                <span className="px-3 py-1 rounded-full text-[11px] font-bold bg-amber-100 text-amber-800 border border-amber-200">Dati incompleti</span>
              )}
              <InfoPopover
                ariaLabel="Info distribuzione geografica"
                title="Dati geografici"
                renderContent={() => (
                  <div className="text-sm space-y-1">
                    <p>Assegna percentuali regione per regione a ciascuno strumento.</p>
                    <p>Se mancano dati, la quota appare come “Non definito”.</p>
                    <p>Usa Listings &amp; FX per salvare la distribuzione geografica o normalizzarla al 100%.</p>
                  </div>
                )}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 items-stretch">
            <div className="lg:col-span-3">
              <RegionBubbleMap data={regionData} />
            </div>
            <div className="lg:col-span-2">
              <div className="bg-slate-50 border border-borderSoft rounded-xl p-2 h-full">
                {regionData.length ? (
                  <div className="space-y-1">
                    {regionData.map((r, idx) => (
                      <div key={r.region} className="flex items-center justify-between rounded-lg px-2 py-1 hover:bg-white transition-colors">
                        <div className="flex items-center gap-2">
                          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: COLORS[idx % COLORS.length] }} />
                          <span className="font-medium text-slate-700 text-sm">{r.label}</span>
                        </div>
                        <div className="text-right text-sm leading-tight">
                          <div className="font-bold text-slate-900">{r.pct.toFixed(1)}%</div>
                          <div className="text-[11px] text-slate-500">CHF {Math.round(r.value).toLocaleString()}</div>
                        </div>
                      </div>
                    ))}
                    {hasIncompleteRegionData && (
                      <div className="flex items-center justify-between text-xs bg-amber-50 border border-amber-100 rounded-lg px-2 py-1.5">
                        <span className="font-semibold text-amber-800">Non definito</span>
                        <span className="font-bold text-amber-800">{`${(unassignedRegion?.pct ?? 0).toFixed(1)}% · CHF ${Math.round(unassignedRegion?.value ?? 0).toLocaleString()}`}</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-2 text-sm text-slate-500">
                    <div>Nessun dato geografico ancora disponibile. Imposta le allocazioni in Settings per vedere la mappa.</div>
                    {hasIncompleteRegionData && (
                      <div className="flex items-center justify-between text-xs bg-amber-50 border border-amber-100 rounded-lg px-2 py-1.5">
                        <span className="font-semibold text-amber-800">Non definito</span>
                        <span className="font-bold text-amber-800">{`${(unassignedRegion?.pct ?? 0).toFixed(1)}% · CHF ${Math.round(unassignedRegion?.value ?? 0).toLocaleString()}`}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="text-[11px] text-slate-500 flex items-center gap-3">
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-slate-100 text-slate-700 border border-borderSoft">
              <span className="material-symbols-outlined text-xs">public</span>
              Valori in CHF
            </span>
            {hasIncompleteRegionData && (
              <span className="text-amber-700">Alcuni strumenti non hanno una regione assegnata.</span>
            )}
          </div>
        </div>

        {/* Esposizione Valutaria card rimossa su richiesta */}
      </div>

    </div>
  );
};







