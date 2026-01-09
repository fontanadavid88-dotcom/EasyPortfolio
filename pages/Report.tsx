
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Rnd } from 'react-rnd';
import { format } from 'date-fns';
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
  AreaChart,
  Area,
  BarChart,
  Bar,
  ReferenceLine
} from 'recharts';
import { MacroGauge } from '../components/MacroGauge';
import { DEFAULT_INDICATORS, computeMacroIndex, mapIndexToPhase } from '../services/macroService';
import { db, getCurrentPortfolioId } from '../db';
import {
  calculateAnalytics,
  calculateHistoricalPerformance,
  calculatePortfolioState,
  calculateAllocationByAssetClass,
  calculateRegionExposure
} from '../services/financeUtils';
import { MACRO_ZONES, COLORS, CARD_BG, CARD_TEXT, PRIMARY_BLUE, ACCENT_ORANGE } from '../constants';
import { useElementSize } from '../hooks/useElementSize';
import '../report.css';
import {
  ReportLayout,
  ReportSettings,
  Widget,
  presetA,
  presetB,
  validateLayout,
  getCanvasSize
} from '../report/reportLayout';
import { PortfolioPosition } from '../types';

const MM_PER_PX = 25.4 / 96;
const mmToPx = (mm: number) => mm / MM_PER_PX;
const pxToMm = (px: number) => px * MM_PER_PX;
const STORAGE_KEY_BASE = 'investi.report.layout.v1';

type LayoutName = 'a' | 'b';
type Orientation = 'portrait' | 'landscape';

const safeClipboardWrite = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    alert('Layout copiato negli appunti.');
  } catch {
    prompt('Copia il layout manualmente e premi OK', text);
  }
};

const titleMap: Record<string, string> = {
  kpi: 'KPI Portafoglio',
  macro: 'Macro Indicator',
  trend: 'Andamento Portafoglio',
  composition: 'Asset Class',
  currency: 'Esposizione Valutaria',
  regions: 'Distribuzione Geografica',
  twrr: 'Andamento Portafoglio (TWRR)',
  mwrr: 'Andamento Portafoglio (MWRR)',
  retann: 'Ritorni Annuali',
  dd: 'Drawdowns',
  asset: 'Allocazione Asset Class',
  holdings: 'Posizioni',
  text: 'Testo'
};

const normalizeWidgetType = (rawType: string) => {
  const baseType = rawType.split('-')[0];
  if (titleMap[rawType]) return rawType;
  if (titleMap[baseType]) return baseType;
  const lower = baseType.toLowerCase();
  return titleMap[lower] ? lower : baseType;
};

const formatCurrency = (value?: number) =>
  typeof value === 'number'
    ? value.toLocaleString('it-IT', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 })
    : '-';

const formatPct = (value?: number) =>
  typeof value === 'number' ? `${value.toFixed(2)}%` : '-';

const WIDGET_TEXT_DEFAULT = 'Doppio click per modificare';
const DEFAULT_REPORT_SETTINGS: ReportSettings = {
  headerEnabled: true,
  footerEnabled: true,
  headerTitle: 'Report Portafoglio',
  headerSubtitle: 'Generato automaticamente',
  footerLeft: 'EasyPortfolio',
  footerRightTemplate: 'Pagina {page}/{pages}',
  logoPosition: 'left' as const,
  logoSizeMm: 12
};

const ensureVersion = (layout: ReportLayout): ReportLayout => {
  const base = validateLayout(layout);
  return {
    ...base,
    version: 2,
    page: {
      marginMm: base.page.marginMm,
      headerMm: base.page.headerMm,
      footerMm: base.page.footerMm,
      orientation: base.page.orientation ?? 'portrait'
    }
  };
};

export const Report: React.FC = () => {
  const [layoutName, setLayoutName] = useState<LayoutName>('a');
  const [layout, setLayout] = useState<ReportLayout>(presetA);
  const [designer, setDesigner] = useState(false);
  const [activePageId, setActivePageId] = useState(presetA.pages[0]?.id ?? 'page-1');
  const [importText, setImportText] = useState('');
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [textDraft, setTextDraft] = useState('');
  const [selectedWidget, setSelectedWidget] = useState<{ pageId: string; widgetId: string } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);


  const [snapEnabled, setSnapEnabled] = useState(true);
  const [snapStepMm, setSnapStepMm] = useState(5);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentPortfolioId = getCurrentPortfolioId();
  const storageKey = `${STORAGE_KEY_BASE}.${currentPortfolioId || 'default'}`;

  const portfolio = useLiveQuery(
    () => db.portfolios.where('portfolioId').equals(currentPortfolioId).first(),
    [currentPortfolioId]
  );
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
  const [macroConfig] = useState(() => {
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

  const assetClassAllocationData = useMemo(() => {
    if (!state || !instruments) return [];
    return calculateAllocationByAssetClass(state, instruments);
  }, [state, instruments]);

  const twrrData = useMemo(() => {
    if (!rawTrends) return [];
    return rawTrends.history.map(h => ({
      displayDate: format(new Date(h.date), 'MMM yy'),
      twrr: h.cumulativeReturnPct ?? 0
    }));
  }, [rawTrends]);

  const mwrrData = useMemo(() => {
    if (!rawTrends) return [];
    return rawTrends.history.map(h => ({
      displayDate: format(new Date(h.date), 'MMM yy'),
      mwrr: h.invested > 0 ? ((h.value - h.invested) / h.invested) * 100 : 0
    }));
  }, [rawTrends]);

  const twrrHasData = twrrData.length > 0 && twrrData.some(d => Number.isFinite(d.twrr));
  const mwrrHasData = mwrrData.length > 0 && mwrrData.some(d => Number.isFinite(d.mwrr));

  const trendData = useMemo(() => {
    if (!rawTrends) return [];
    return rawTrends.history.map(h => ({
      displayDate: format(new Date(h.date), 'MMM yy'),
      value: h.value,
      invested: h.invested
    }));
  }, [rawTrends]);

  const annualReturns = analytics?.annualReturns || [];
  const drawdownData = analytics?.drawdownSeries?.map(d => ({
    ...d,
    displayDate: format(new Date(d.date), 'MMM yy')
  })) || [];

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

  const currencyDisplay = useMemo(() => {
    if (currencyBars.length === 0) return { chart: [], legend: [] };
    const maxItems = 6;
    if (currencyBars.length <= maxItems) return { chart: currencyBars, legend: currencyBars };
    const top = currencyBars.slice(0, maxItems - 1);
    const rest = currencyBars.slice(maxItems - 1);
    const otherValue = rest.reduce((sum, item) => sum + item.value, 0);
    const otherPct = rest.reduce((sum, item) => sum + item.pct, 0);
    const other = { name: 'Altro', value: otherValue, pct: otherPct };
    return { chart: [...top, other], legend: [...top, other] };
  }, [currencyBars]);

  const regionExposure = useMemo(() => {
    if (!state || !instruments) return [];
    return calculateRegionExposure(state, instruments);
  }, [state, instruments]);

  const holdings = useMemo<PortfolioPosition[]>(() => {
    if (!state) return [];
    return [...state.positions]
      .sort((a, b) => b.currentValueCHF - a.currentValueCHF)
      .filter(p => p.currentValueCHF > 0);
  }, [state]);

  const holdingsPreview = holdings.slice(0, 14);

  const layoutFromStorage = (): ReportLayout | null => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (!saved) return null;
      const parsed = JSON.parse(saved);
      return ensureVersion(parsed);
    } catch {
      return null;
    }
  };

  useEffect(() => {
    const saved = layoutFromStorage();
    if (saved) {
      setLayout(saved);
      if (saved.pages[0]?.id) setActivePageId(saved.pages[0].id);
    } else {
      setLayout(presetA);
      setLayoutName('a');
      setActivePageId(presetA.pages[0]?.id ?? 'page-1');
    }
  }, [storageKey]);

  useEffect(() => {
    if (!layout.pages.some(p => p.id === activePageId)) {
      setActivePageId(layout.pages[0]?.id ?? 'page-1');
    }
  }, [layout.pages, activePageId]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  const { canvasW, canvasH, pageW, pageH, orientation } = useMemo(() => getCanvasSize(layout.page), [layout.page]);
  const marginMm = layout.page.marginMm ?? 8;
  const headerMm = layout.page.headerMm ?? 14;
  const footerMm = layout.page.footerMm ?? 10;
  const reportSettings = layout.settings ?? DEFAULT_REPORT_SETTINGS;
  const dashboardPages = layout.pages;
  const clampToCanvasMm = (xMm: number, yMm: number, widget: Widget, size?: { w: number; h: number }) => {
    const width = size?.w ?? widget.w;
    const height = size?.h ?? widget.h;
    const maxX = Math.max(0, canvasW - width);
    const maxY = Math.max(0, canvasH - height);
    return {
      x: Math.max(0, Math.min(xMm, maxX)),
      y: Math.max(0, Math.min(yMm, maxY))
    };
  };
  const applyLayout = (nextLayout: ReportLayout, immediate = false) => {
    const validated = ensureVersion(nextLayout);
    setLayout(validated);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (immediate) {
      localStorage.setItem(storageKey, JSON.stringify(validated));
      return;
    }
    saveTimer.current = setTimeout(() => {
      localStorage.setItem(storageKey, JSON.stringify(validated));
    }, 250);
  };

  const replaceWithPreset = (preset: LayoutName) => {
    const base = preset === 'a' ? presetA : presetB;
    setLayoutName(preset);
    setSelectedWidget(null);
    setEditingTextId(null);
    setActivePageId(base.pages[0]?.id ?? 'page-1');
    applyLayout(base);
  };

  const resetCurrentPreset = () => replaceWithPreset(layoutName);

  const handleExport = () => {
    const json = JSON.stringify(layout, null, 2);
    setImportText(json);
    safeClipboardWrite(json);
  };

  const handleImport = () => {
    if (!importText.trim()) return;
    try {
      const parsed = JSON.parse(importText);
      applyLayout(ensureVersion(parsed));
      setImportText('');
    } catch {
      alert('Layout non valido.');
    }
  };

  const addTextWidget = () => {
    const page = layout.pages.find(p => p.id === activePageId);
    if (!page) return;
    const newWidget: Widget = {
      id: `text-${Date.now()}`,
      type: 'text',
      x: 0,
      y: 0,
      w: 80,
      h: 20,
      minW: 30,
      minH: 12,
      text: WIDGET_TEXT_DEFAULT,
      fontSize: 12,
      align: 'left'
    };
    applyLayout({
      ...layout,
      pages: layout.pages.map(p => p.id === page.id ? { ...p, widgets: [...p.widgets, newWidget] } : p)
    });
    setSelectedWidget({ pageId: page.id, widgetId: newWidget.id });
  };

  const updateWidget = (
    pageId: string,
    widgetId: string,
    updater: (w: Widget) => Widget,
    options?: { immediate?: boolean }
  ) => {
    const nextPages = layout.pages.map(p => {
      if (p.id !== pageId) return p;
      return {
        ...p,
        widgets: p.widgets.map(w => (w.id === widgetId ? updater(w) : w))
      };
    });
    applyLayout({ ...layout, pages: nextPages }, options?.immediate);
  };

  const deleteWidget = (pageId: string, widgetId: string) => {
    const nextPages = layout.pages.map(p => {
      if (p.id !== pageId) return p;
      return { ...p, widgets: p.widgets.filter(w => w.id !== widgetId) };
    });
    if (selectedWidget?.widgetId === widgetId) {
      setSelectedWidget(null);
      setEditingTextId(null);
    }
    applyLayout({ ...layout, pages: nextPages });
  };

  const duplicateWidget = (pageId: string, widget: Widget) => {
    const page = layout.pages.find(p => p.id === pageId);
    if (!page) return;
    const clone: Widget = {
      ...widget,
      id: `${widget.id}-${Date.now()}`,
      x: Math.min(widget.x + 5, canvasW - widget.w),
      y: Math.min(widget.y + 5, canvasH - widget.h)
    };
    applyLayout({
      ...layout,
      pages: layout.pages.map(p => p.id === pageId ? { ...p, widgets: [...p.widgets, clone] } : p)
    });
    setSelectedWidget({ pageId, widgetId: clone.id });
  };

  const positionsChunks = useMemo(() => {
    const rowsPerPage = 18;
    if (holdings.length === 0) return [[]] as PortfolioPosition[][];
    const chunks: PortfolioPosition[][] = [];
    for (let i = 0; i < holdings.length; i += rowsPerPage) {
      chunks.push(holdings.slice(i, i + rowsPerPage));
    }
    return chunks;
  }, [holdings]);

  const totalPages = dashboardPages.length + positionsChunks.length;
  const now = new Date();

  const renderBadgeWarning = (showOut: boolean) => (showOut ? <span className="widget-badge">OUT</span> : null);

  const WidgetContent: React.FC<{ widget: Widget }> = ({ widget }) => {
    const widgetType = normalizeWidgetType(
      typeof widget.props?.widgetType === 'string' ? widget.props.widgetType : widget.id
    );

    if (widget.type === 'text') {
      return (
        <div
          style={{
            height: '100%',
            padding: 4,
            fontSize: widget.fontSize ?? 12,
            fontWeight: widget.bold ? 700 : 400,
            fontStyle: widget.italic ? 'italic' : 'normal',
            textAlign: widget.align ?? 'left',
            color: widget.color ?? CARD_TEXT,
            background: widget.bg ?? 'transparent',
            border: widget.border ? `1px solid ${widget.border}` : 'none',
            borderRadius: 8,
            whiteSpace: 'pre-wrap'
          }}
        >
          {widget.text || WIDGET_TEXT_DEFAULT}
        </div>
      );
    }

    // Chart height handled by CSS flex in parent
    const empty = (label: string) => <div className="chart-empty">{label}</div>;

    switch (widgetType) {
      case 'kpi': {
        const kpiItems = [
          {
            label: 'Valore',
            value: formatCurrency(state?.totalValue),
            sub: 'Totale portafoglio'
          },
          {
            label: 'Investito',
            value: formatCurrency(state?.investedCapital),
            sub: 'Capitale investito'
          },
          {
            label: 'Bilancio',
            value: formatCurrency(state?.balance),
            sub: formatPct(state?.balancePct)
          }
        ];
        return (
          <div className="kpi-grid">
            {kpiItems.map(item => (
              <div key={item.label} className="kpi">
                <div className="label">{item.label}</div>
                <div className="value">{item.value}</div>
                <div className="sub">{item.sub}</div>
              </div>
            ))}
          </div>
        );
      }
      case 'macro':
        return (
          <div className="widget-body">
            <MacroGauge value={macroState.score} />
            <div style={{ textAlign: 'center', fontSize: 11, color: macroState.color }}>
              {macroState.phase}
            </div>
          </div>
        );
      case 'trend':
        if (!trendData.length) return empty('Dati non disponibili');
        return (
          <div className="chart-box">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trendData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={PRIMARY_BLUE} stopOpacity={0.3} />
                    <stop offset="100%" stopColor={PRIMARY_BLUE} stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="investedFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={ACCENT_ORANGE} stopOpacity={0.25} />
                    <stop offset="100%" stopColor={ACCENT_ORANGE} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
                <XAxis dataKey="displayDate" tick={{ fontSize: 10 }} />
                <YAxis
                  tick={{ fontSize: 10 }}
                  width={50}
                  tickFormatter={(value: number) => formatCurrency(value)}
                />
                <Tooltip formatter={(value: number | string) => (typeof value === 'number' ? formatCurrency(value) : value)} />
                <Area type="monotone" dataKey="value" stroke={PRIMARY_BLUE} fill="url(#trendFill)" />
                <Area type="monotone" dataKey="invested" stroke={ACCENT_ORANGE} fill="url(#investedFill)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        );
      case 'twrr':
        if (!twrrHasData) return empty('Serie non disponibile');
        return (
          <div className="chart-box">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={twrrData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
                <XAxis dataKey="displayDate" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} width={40} tickFormatter={(v: number) => `${v.toFixed(0)}%`} />
                <Tooltip formatter={(value: number | string) => (typeof value === 'number' ? `${value.toFixed(2)}%` : value)} />
                <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="3 3" />
                <Area type="monotone" dataKey="twrr" stroke={PRIMARY_BLUE} fill="rgba(0,82,163,0.2)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        );
      case 'mwrr':
        if (!mwrrHasData) return empty('Serie non disponibile');
        return (
          <div className="chart-box">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={mwrrData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
                <XAxis dataKey="displayDate" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} width={40} tickFormatter={(v: number) => `${v.toFixed(0)}%`} />
                <Tooltip formatter={(value: number | string) => (typeof value === 'number' ? `${value.toFixed(2)}%` : value)} />
                <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="3 3" />
                <Area type="monotone" dataKey="mwrr" stroke={ACCENT_ORANGE} fill="rgba(249,115,22,0.2)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        );
      case 'retann':
        if (annualReturns.length === 0) return empty('Nessun ritorno annuale');
        return (
          <div className="chart-box">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={annualReturns} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
                <XAxis dataKey="year" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} width={40} tickFormatter={(v: number) => `${v.toFixed(0)}%`} />
                <Tooltip formatter={(value: number | string) => (typeof value === 'number' ? `${value.toFixed(1)}%` : value)} />
                <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="3 3" />
                <Bar dataKey="returnPct" fill={PRIMARY_BLUE} radius={2} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        );
      case 'dd':
        if (drawdownData.length === 0) return empty('Nessun drawdown');
        return (
          <div className="chart-box">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={drawdownData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
                <XAxis dataKey="displayDate" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} width={40} tickFormatter={(v: number) => `${v.toFixed(0)}%`} />
                <Tooltip formatter={(value: number | string) => (typeof value === 'number' ? `${value.toFixed(1)}%` : value)} />
                <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="3 3" />
                <Area type="monotone" dataKey="depth" stroke="#dc2626" fill="rgba(220,38,38,0.2)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        );
      case 'asset':
      case 'composition':
        if (assetClassAllocationData.length === 0) return empty('Nessun dato asset class');
        return (
          <div className="fx-exposure-wrap">
            <div className="fx-exposure-chart">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={assetClassAllocationData} dataKey="value" innerRadius={30} outerRadius={60} paddingAngle={3}>
                    {assetClassAllocationData.map((entry, index) => (
                      <Cell key={entry.key} fill={COLORS[index % COLORS.length]} stroke={CARD_BG} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value: number | string) => (typeof value === 'number' ? formatCurrency(value) : value)} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="fx-exposure-legend">
              <ul>
                {assetClassAllocationData.map((item, idx) => (
                  <li key={item.key}>
                    <span className="fx-exposure-label">
                      <span className="fx-swatch" style={{ background: COLORS[idx % COLORS.length] }} />
                      {item.label}
                    </span>
                    <span className="fx-exposure-values">
                      <span className="fx-exposure-pct">{item.pct.toFixed(1)}%</span>
                      <span className="fx-exposure-val">{formatCurrency(item.value)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        );
      case 'currency': {
        const showLegend = typeof widget.props?.showLegend === 'boolean' ? widget.props.showLegend : true;
        if (currencyDisplay.chart.length === 0) return empty('Nessun dato valuta');
        return (
          <div className={`fx-exposure-wrap ${showLegend ? '' : 'no-legend'}`}>
            <div className="fx-exposure-chart">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={currencyDisplay.chart} dataKey="value" innerRadius={30} outerRadius={60} paddingAngle={3}>
                    {currencyDisplay.chart.map((entry, index) => (
                      <Cell key={entry.name} fill={COLORS[index % COLORS.length]} stroke={CARD_BG} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value: number | string) => (typeof value === 'number' ? formatCurrency(value) : value)} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            {showLegend && (
              <div className="fx-exposure-legend">
                <ul>
                  {currencyDisplay.legend.map((item, idx) => (
                    <li key={item.name}>
                      <span className="fx-exposure-label">
                        <span className="fx-swatch" style={{ background: COLORS[idx % COLORS.length] }} />
                        {item.name}
                      </span>
                      <span className="fx-exposure-values">
                        <span className="fx-exposure-pct">{item.pct.toFixed(1)}%</span>
                        <span className="fx-exposure-val">{formatCurrency(item.value)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        );
      }
      case 'regions':
        if (regionExposure.length === 0) return empty('Nessuna regione');
        return (
          <div className="chart-box">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={regionExposure} layout="vertical" margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
                <XAxis
                  type="number"
                  tick={{ fontSize: 10 }}
                  tickFormatter={(v: number) => `${v.toFixed(1)}%`}
                />
                <YAxis
                  type="category"
                  dataKey="label"
                  width={80}
                  tick={{ fontSize: 10 }}
                />
                <Tooltip formatter={(value: number | string) => (typeof value === 'number' ? `${value.toFixed(1)}%` : value)} />
                <Bar dataKey="pct" fill={PRIMARY_BLUE} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        );
      case 'holdings':
        if (holdingsPreview.length === 0) return empty('Nessuna posizione');
        return (
          <table className="table positions-table">
            <colgroup>
              <col className="col-ticker" />
              <col className="col-name" />
              <col className="col-qty" />
              <col className="col-value" />
              <col className="col-weight" />
            </colgroup>
            <thead>
              <tr>
                <th className="cell-clip">Ticker</th>
                <th className="cell-clip">Nome</th>
                <th className="num">Quote</th>
                <th className="num">Valore</th>
                <th className="num">Peso %</th>
              </tr>
            </thead>
            <tbody>
              {holdingsPreview.map(h => (
                <tr key={h.ticker}>
                  <td className="cell-clip">{h.ticker}</td>
                  <td className="cell-clip">{h.name}</td>
                  <td className="num">{h.quantity.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                  <td className="num">{formatCurrency(h.currentValueCHF)}</td>
                  <td className="num">{h.currentPct.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        );
      default:
        return empty('Widget non configurato');
    }
  };

  type WidgetCardProps = {
    widget: Widget;
    pageId: string;
    canvasW: number;
    canvasH: number;
    isEditable: boolean;
    isSelected: boolean;
    isEditing?: boolean;
    onSelect?: () => void;
    onDoubleClick?: () => void;
  };

  const WidgetCard: React.FC<WidgetCardProps> = ({
    widget,
    pageId,
    canvasW,
    canvasH,
    isEditable,
    isSelected,
    isEditing = false,
    onSelect,
    onDoubleClick
  }) => {
    // Local state for controlled Rnd to ensure smooth drag/resize without full layout re-renders
    const [localDim, setLocalDim] = useState({
      x: mmToPx(widget.x),
      y: mmToPx(widget.y),
      width: mmToPx(widget.w),
      height: mmToPx(widget.h)
    });

    // Sync local state when widget props change (e.g. undo/redo or external update)
    useEffect(() => {
      setLocalDim({
        x: mmToPx(widget.x),
        y: mmToPx(widget.y),
        width: mmToPx(widget.w),
        height: mmToPx(widget.h)
      });
    }, [widget.x, widget.y, widget.w, widget.h]);

    const snapPx = Math.max(1, mmToPx(snapStepMm));
    const grid: [number, number] = snapEnabled ? [snapPx, snapPx] : [1, 1];
    const isText = widget.type === 'text';
    const widgetType = normalizeWidgetType(
      typeof widget.props?.widgetType === 'string' ? widget.props.widgetType : widget.id
    );

    const showOut = widget.x < 0 || widget.y < 0 || widget.x + widget.w > canvasW || widget.y + widget.h > canvasH;

    const handleSelect = () => {
      onSelect?.();
    };

    const card = (
      <div
        className={`widget ${isText ? 'text-widget' : ''} ${showOut ? 'widget-out' : ''} ${isSelected ? 'widget-selected' : ''}`}
        style={{ width: '100%', height: '100%' }}
        onClick={handleSelect}
        onDoubleClick={onDoubleClick}
        onContextMenu={isEditable ? (event: React.MouseEvent) => event.preventDefault() : undefined}
        title={isEditable ? 'Trascina con tasto sinistro' : undefined}
      >
        {renderBadgeWarning(showOut)}

        {isEditable && (
          <button
            type="button"
            className="widget-remove no-print"
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
            onClick={(e) => {
              e.stopPropagation();
              deleteWidget(pageId, widget.id);
            }}
            aria-label="Elimina widget"
            title="Elimina"
          >
            x
          </button>
        )}
        <div className="card-inner">
          {!isText && <h3>{titleMap[widgetType] ?? widget.id.toUpperCase()}</h3>}
          <WidgetContent widget={widget} />
        </div>
      </div>
    );

    if (!isEditable || widget.locked) {
      return card;
    }

    return (
      <Rnd
        key={widget.id} // Stable key
        position={{ x: localDim.x, y: localDim.y }}
        size={{ width: localDim.width, height: localDim.height }}
        className={`report-rnd ${isEditable ? 'is-designer' : 'is-viewer'} ${isSelected ? 'is-selected' : ''}`}
        data-widget-id={widget.id}
        enableResizing={isEditable && !widget.locked && !isEditing}
        disableDragging={!isEditable || widget.locked || isEditing}
        bounds="parent" // Ensure drag stays within parent container
        cancel=".no-drag, button, .widget-remove"
        onContextMenu={isEditable ? (event: React.MouseEvent) => event.preventDefault() : undefined}

        onDragStart={(event: any) => {
          if ('button' in event && event.button !== 0) return;
          setDraggingId(widget.id);
          handleSelect();
        }}

        onDrag={(e, d) => {
          setLocalDim(prev => ({ ...prev, x: d.x, y: d.y }));
        }}

        onDragStop={(event: any, data) => {
          if ('button' in event && event.button !== 0) return;

          const nextX = pxToMm(data.x);
          const nextY = pxToMm(data.y);
          // Use current localDim for size to be safe
          const currentW_mm = pxToMm(localDim.width);
          const currentH_mm = pxToMm(localDim.height);

          const clamped = clampToCanvasMm(nextX, nextY, widget, { w: currentW_mm, h: currentH_mm });

          // Optimistic update of local state to clamped values (if any)
          setLocalDim(prev => ({
            ...prev,
            x: mmToPx(clamped.x),
            y: mmToPx(clamped.y)
          }));

          updateWidget(pageId, widget.id, w => ({ ...w, x: clamped.x, y: clamped.y }), { immediate: true });
          setDraggingId(null);
        }}

        onResizeStart={() => {
          setDraggingId(widget.id);
        }}

        onResize={(e, dir, ref, delta, position) => {
          setLocalDim({
            x: position.x,
            y: position.y,
            width: ref.offsetWidth,
            height: ref.offsetHeight
          });
        }}

        onResizeStop={(_e, _dir, refEl, _delta, position) => {
          setDraggingId(null);
          const nextW = pxToMm(refEl.offsetWidth);
          const nextH = pxToMm(refEl.offsetHeight);
          const nextX = pxToMm(position.x);
          const nextY = pxToMm(position.y);
          const clamped = clampToCanvasMm(nextX, nextY, widget, { w: nextW, h: nextH });

          updateWidget(
            pageId,
            widget.id,
            w => ({ ...w, x: clamped.x, y: clamped.y, w: nextW, h: nextH }),
            { immediate: true }
          );
        }}
        dragGrid={grid}
        resizeGrid={grid}
        minWidth={mmToPx(widget.minW ?? 25)}
        minHeight={mmToPx(widget.minH ?? 20)}
        style={{
          zIndex: isSelected ? 8 : widget.type === 'text' ? 6 : 5,
          cursor: 'grab'
        }}
      >
        {card}
      </Rnd>
    );
  };

  const handleOrientation = (value: Orientation) => {
    applyLayout({ ...layout, page: { ...layout.page, orientation: value } });
  };

  const startEditText = (widget: Widget) => {
    if (widget.type !== 'text') return;
    setEditingTextId(widget.id);
    setTextDraft(widget.text || WIDGET_TEXT_DEFAULT);
  };

  const commitTextEdit = (pageId: string, widgetId: string) => {
    updateWidget(pageId, widgetId, w => ({ ...w, text: textDraft }));
    setEditingTextId(null);
  };

  const adjustFont = (pageId: string, widgetId: string, delta: number) => {
    updateWidget(pageId, widgetId, w => ({ ...w, fontSize: Math.max(8, (w.fontSize ?? 12) + delta) }));
  };

  const toggleStyle = (pageId: string, widgetId: string, key: 'bold' | 'italic') => {
    updateWidget(pageId, widgetId, w => ({ ...w, [key]: !w[key] }));
  };

  const setAlign = (pageId: string, widgetId: string, align: 'left' | 'center' | 'right') => {
    updateWidget(pageId, widgetId, w => ({ ...w, align }));
  };
  const selectedInfo = selectedWidget
    ? layout.pages.find(p => p.id === selectedWidget.pageId)?.widgets.find(w => w.id === selectedWidget.widgetId) ?? null
    : null;

  const selectedType = selectedInfo
    ? (() => {
      const rawType = typeof selectedInfo.props?.widgetType === 'string' ? selectedInfo.props.widgetType : selectedInfo.id;
      return normalizeWidgetType(rawType);
    })()
    : null;

  const updateSelectedWidget = (updater: (w: Widget) => Widget) => {
    if (!selectedWidget || !selectedInfo) return;
    updateWidget(selectedWidget.pageId, selectedWidget.widgetId, updater);
  };

  const nudgeSelected = (dx: number, dy: number) => {
    if (!selectedInfo) return;
    const nextX = Math.max(0, Math.min(selectedInfo.x + dx, canvasW - selectedInfo.w));
    const nextY = Math.max(0, Math.min(selectedInfo.y + dy, canvasH - selectedInfo.h));
    updateSelectedWidget(w => ({ ...w, x: nextX, y: nextY }));
  };

  const alignSelected = (mode: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') => {
    if (!selectedInfo) return;
    let nextX = selectedInfo.x;
    let nextY = selectedInfo.y;
    if (mode === 'left') nextX = 0;
    if (mode === 'center') nextX = (canvasW - selectedInfo.w) / 2;
    if (mode === 'right') nextX = canvasW - selectedInfo.w;
    if (mode === 'top') nextY = 0;
    if (mode === 'middle') nextY = (canvasH - selectedInfo.h) / 2;
    if (mode === 'bottom') nextY = canvasH - selectedInfo.h;
    updateSelectedWidget(w => ({ ...w, x: nextX, y: nextY }));
  };

  const reorderWidget = (direction: 'front' | 'back') => {
    if (!selectedWidget || !selectedInfo) return;
    const pageIndex = layout.pages.findIndex(p => p.id === selectedWidget.pageId);
    if (pageIndex === -1) return;
    const page = layout.pages[pageIndex];
    const widgets = [...page.widgets];
    const currentIndex = widgets.findIndex(w => w.id === selectedInfo.id);
    if (currentIndex === -1) return;
    widgets.splice(currentIndex, 1);
    if (direction === 'front') {
      widgets.push(selectedInfo);
    } else {
      widgets.unshift(selectedInfo);
    }
    const nextPages = layout.pages.map((p, idx) => idx === pageIndex ? { ...p, widgets } : p);
    applyLayout({ ...layout, pages: nextPages });
  };

  const updateSettings = (patch: Partial<typeof reportSettings>) => {
    applyLayout({ ...layout, settings: { ...reportSettings, ...patch } });
  };

  const widgetLibrary = [
    { id: 'kpi', label: 'KPI Portafoglio', w: 130, h: 50, minW: 80, minH: 40 },
    { id: 'macro', label: 'Macro Indicator', w: 55, h: 50, minW: 45, minH: 40 },
    { id: 'trend', label: 'Andamento Portafoglio', w: 190, h: 75, minW: 120, minH: 60 },
    { id: 'twrr', label: 'Andamento Portafoglio (TWRR)', w: 190, h: 70, minW: 120, minH: 60 },
    { id: 'mwrr', label: 'Andamento Portafoglio (MWRR)', w: 190, h: 70, minW: 120, minH: 60 },
    { id: 'retann', label: 'Ritorni Annuali', w: 95, h: 55, minW: 70, minH: 40 },
    { id: 'dd', label: 'Drawdowns', w: 90, h: 55, minW: 70, minH: 40 },
    { id: 'composition', label: 'Asset Class', w: 90, h: 60, minW: 60, minH: 45 },
    { id: 'currency', label: 'Esposizione Valutaria', w: 90, h: 60, minW: 60, minH: 45 },
    { id: 'regions', label: 'Distribuzione Geografica', w: 190, h: 70, minW: 120, minH: 50 }
  ];

  const addWidgetById = (id: string) => {
    const page = layout.pages.find(p => p.id === activePageId);
    if (!page) return;
    const preset = widgetLibrary.find(w => w.id === id);
    if (!preset) return;
    const newWidget: Widget = {
      id: `${id}-${Date.now()}`,
      x: 0,
      y: 0,
      w: preset.w,
      h: preset.h,
      minW: preset.minW,
      minH: preset.minH,
      props: { widgetType: id, ...(id === 'currency' ? { showLegend: true } : {}) }
    };
    applyLayout({
      ...layout,
      pages: layout.pages.map(p => p.id === page.id ? { ...p, widgets: [...p.widgets, newWidget] } : p)
    });
    setSelectedWidget({ pageId: page.id, widgetId: newWidget.id });
  };

  const handleLogoUpload = (file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      updateSettings({ logoDataUrl: String(reader.result || '') });
    };
    reader.readAsDataURL(file);
  };
  useEffect(() => {
    if (!designer) return;
    const handler = (e: KeyboardEvent) => {
      if (!selectedWidget || !selectedInfo) return;
      const key = e.key.toLowerCase();
      if (key === 'delete' || key === 'backspace') {
        e.preventDefault();
        deleteWidget(selectedWidget.pageId, selectedWidget.widgetId);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && key === 'd') {
        e.preventDefault();
        duplicateWidget(selectedWidget.pageId, selectedInfo);
        return;
      }
      const step = e.shiftKey ? 5 : 1;
      if (key === 'arrowup') {
        e.preventDefault();
        nudgeSelected(0, -step);
      }
      if (key === 'arrowdown') {
        e.preventDefault();
        nudgeSelected(0, step);
      }
      if (key === 'arrowleft') {
        e.preventDefault();
        nudgeSelected(-step, 0);
      }
      if (key === 'arrowright') {
        e.preventDefault();
        nudgeSelected(step, 0);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [designer, selectedWidget, selectedInfo, canvasW, canvasH, layout]);

  const formatFooterRight = (pageNumber: number, pages: number) =>
    reportSettings.footerRightTemplate
      .replace('{page}', String(pageNumber))
      .replace('{pages}', String(pages));

  const headerGapMm = 0;
  const footerGapMm = 0;

  const renderHeader = (pageNumber: number, pages: number) => {
    if (!reportSettings.headerEnabled) return null;
    return (
      <div className="report-header" style={{ minHeight: `${headerMm}mm` }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {reportSettings.logoDataUrl && reportSettings.logoPosition === 'left' && (
            <img
              src={reportSettings.logoDataUrl}
              alt="Logo"
              style={{ height: `${reportSettings.logoSizeMm}mm`, width: 'auto', objectFit: 'contain' }}
            />
          )}
          <div>
            <h1>{reportSettings.headerTitle}</h1>
            <div>{reportSettings.headerSubtitle}</div>
            <div style={{ fontSize: 11, color: '#64748b' }}>
              Portafoglio: {portfolio?.name || 'Selezionato'} - Generato il {format(now, 'dd/MM/yyyy HH:mm')}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {reportSettings.logoDataUrl && reportSettings.logoPosition === 'right' && (
            <img
              src={reportSettings.logoDataUrl}
              alt="Logo"
              style={{ height: `${reportSettings.logoSizeMm}mm`, width: 'auto', objectFit: 'contain' }}
            />
          )}
          <div className="pill">{formatFooterRight(pageNumber, pages)}</div>
        </div>
      </div>
    );
  };

  const renderFooter = (pageNumber: number, pages: number) => {
    if (!reportSettings.footerEnabled) return null;
    return (
      <div className="report-footer" style={{ minHeight: `${footerMm}mm`, marginTop: `${footerGapMm}mm` }}>
        <span>{reportSettings.footerLeft}</span>
        <span>{formatFooterRight(pageNumber, pages)}</span>
      </div>
    );
  };

  const renderPositionsTable = (rows: PortfolioPosition[], label: string) => (
    <div className="positions-block">
      <h3>{label}</h3>
      <table className="table positions-table">
        <colgroup>
          <col className="col-ticker" />
          <col className="col-name" />
          <col className="col-qty" />
          <col className="col-value" />
          <col className="col-weight" />
        </colgroup>
        <thead>
          <tr>
            <th className="cell-clip">Ticker</th>
            <th className="cell-clip">Nome</th>
            <th className="num">Quote</th>
            <th className="num">Valore</th>
            <th className="num">Peso %</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={5} style={{ textAlign: 'center', color: '#94a3b8' }}>Nessuna posizione</td>
            </tr>
          ) : (
            rows.map(h => (
              <tr key={h.ticker}>
                <td className="cell-clip">{h.ticker}</td>
                <td className="cell-clip">{h.name}</td>
                <td className="num">{h.quantity.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                <td className="num">{formatCurrency(h.currentValueCHF)}</td>
                <td className="num">{h.currentPct.toFixed(1)}%</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
  const renderDashboardPage = (page: typeof dashboardPages[number], pageIndex: number) => {
    const isEditablePage = designer;
    const isActivePage = page.id === activePageId;
    const pageNumber = pageIndex + 1;

    return (
      <section
        className="pdf-page"
        key={page.id}
        style={{
          padding: `${marginMm}mm`,
          width: `${pageW}mm`,
          minHeight: `${pageH}mm`
        }}
      >
        {renderHeader(pageNumber, totalPages)}

        <div
          className="pdf-canvas"
          style={{
            width: `${canvasW}mm`,
            height: `${canvasH}mm`,
            marginTop: `${headerGapMm}mm`,
            position: 'relative'
          }}
          onContextMenu={designer ? (event) => event.preventDefault() : undefined}
        >
          {isActivePage && <div className="designer-overlay" />}

          {page.widgets.map(widget => {
            const editing = isEditablePage && widget.type === 'text' && editingTextId === widget.id;
            const overlay = editing ? (
              <div
                className="no-print"
                style={{
                  position: 'absolute',
                  left: `${widget.x}mm`,
                  top: `${widget.y}mm`,
                  width: `${widget.w}mm`,
                  height: `${widget.h}mm`,
                  background: 'rgba(255,255,255,0.9)',
                  border: '1px dashed #0ea5e9',
                  padding: 8,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  zIndex: 10
                }}
              >
                <textarea
                  value={textDraft}
                  onChange={e => setTextDraft(e.target.value)}
                  style={{ flex: 1, fontSize: widget.fontSize ?? 12, padding: 6, border: '1px solid #cbd5e1', borderRadius: 8 }}
                />
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button onClick={() => adjustFont(page.id, widget.id, 1)}>Font +</button>
                  <button onClick={() => adjustFont(page.id, widget.id, -1)}>Font -</button>
                  <button onClick={() => toggleStyle(page.id, widget.id, 'bold')}>{widget.bold ? 'Unbold' : 'Bold'}</button>
                  <button onClick={() => toggleStyle(page.id, widget.id, 'italic')}>{widget.italic ? 'Unitalic' : 'Italic'}</button>
                  <button onClick={() => setAlign(page.id, widget.id, 'left')}>Allinea SX</button>
                  <button onClick={() => setAlign(page.id, widget.id, 'center')}>Centro</button>
                  <button onClick={() => setAlign(page.id, widget.id, 'right')}>DX</button>
                  <button onClick={() => commitTextEdit(page.id, widget.id)}>Salva</button>
                  <button onClick={() => setEditingTextId(null)}>Chiudi</button>
                </div>
              </div>
            ) : null;

            const isSelected = designer && selectedWidget?.widgetId === widget.id && selectedWidget?.pageId === page.id;

            if (isEditablePage && !widget.locked) {
              return (
                <React.Fragment key={widget.id}>
                  <WidgetCard
                    widget={widget}
                    pageId={page.id}
                    canvasW={canvasW}
                    canvasH={canvasH}
                    isEditable={isEditablePage}
                    isSelected={isSelected}
                    isEditing={editing}
                    onSelect={() => { setSelectedWidget({ pageId: page.id, widgetId: widget.id }); setActivePageId(page.id); }}
                    onDoubleClick={() => startEditText(widget)}
                  />
                  {overlay}
                </React.Fragment>
              );
            }

            return (
              <div
                key={widget.id}
                onDoubleClick={() => startEditText(widget)}
                style={{
                  position: 'absolute',
                  left: `${widget.x}mm`,
                  top: `${widget.y}mm`,
                  width: `${widget.w}mm`,
                  height: `${widget.h}mm`
                }}
              >
                <WidgetCard
                  widget={widget}
                  pageId={page.id}
                  canvasW={canvasW}
                  canvasH={canvasH}
                  isEditable={false}
                  isSelected={isSelected}
                  onSelect={() => { setSelectedWidget({ pageId: page.id, widgetId: widget.id }); setActivePageId(page.id); }}
                  onDoubleClick={() => startEditText(widget)}
                />
                {overlay}
              </div>
            );
          })}
        </div>

        {renderFooter(pageNumber, totalPages)}
      </section>
    );
  };

  const renderPositionsPage = (rows: PortfolioPosition[], index: number) => {
    const pageNumber = dashboardPages.length + index + 1;
    const label = index === 0 ? 'Posizioni' : 'Posizioni (continua)';

    return (
      <section
        className="pdf-page positions-page"
        key={`positions-${index}`}
        style={{
          padding: `${marginMm}mm`,
          width: `${pageW}mm`,
          minHeight: `${pageH}mm`
        }}
      >
        {renderHeader(pageNumber, totalPages)}
        <div
          className="pdf-canvas"
          style={{
            width: `${canvasW}mm`,
            height: `${canvasH}mm`,
            marginTop: `${headerGapMm}mm`,
            position: 'relative'
          }}
        >
          {renderPositionsTable(rows, label)}
        </div>
        {renderFooter(pageNumber, totalPages)}
      </section>
    );
  };

  return (
    <div className={`report-root report-layout-${layoutName} ${orientation === 'landscape' ? 'is-landscape' : ''} ${designer ? 'is-designer' : 'is-viewer'}`}>
      <style>
        {orientation === 'landscape'
          ? '@page { size: A4 landscape; margin: 0; }'
          : '@page { size: A4 portrait; margin: 0; }'}
      </style>

      <div className="report-workspace">
        <div className="report-pages">
          <div className="no-print report-actions">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                onClick={() => {
                  setDesigner(prev => {
                    const next = !prev;
                    if (!next) setSelectedWidget(null);
                    return next;
                  });
                }}
                style={{ background: designer ? '#e0f2fe' : undefined }}
              >
                Modalita designer {designer ? 'ON' : 'OFF'}
              </button>

              <button onClick={() => replaceWithPreset('a')} style={{ background: layoutName === 'a' ? '#e0f2fe' : undefined }}>Layout A</button>
              <button onClick={() => replaceWithPreset('b')} style={{ background: layoutName === 'b' ? '#e0f2fe' : undefined }}>Layout B</button>
              <button onClick={resetCurrentPreset}>Reset layout</button>
              <button onClick={addTextWidget}>+ Testo</button>
              <button onClick={() => handleOrientation('portrait')} style={{ background: orientation === 'portrait' ? '#e0f2fe' : undefined }}>Verticale</button>
              <button onClick={() => handleOrientation('landscape')} style={{ background: orientation === 'landscape' ? '#e0f2fe' : undefined }}>Orizzontale</button>
              <button onClick={handleExport}>Esporta layout</button>
              <button onClick={handleImport}>Importa layout</button>
              <button onClick={() => window.print()}>Stampa / Salva PDF</button>
              <a href="#/" className="no-underline" style={{ padding: '10px 14px' }}>Torna alla dashboard</a>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
              <label style={{ fontSize: 12, color: '#475569' }}>Pagina attiva:</label>
              <select value={activePageId} onChange={e => setActivePageId(e.target.value)}>
                {dashboardPages.map(p => <option key={p.id} value={p.id}>{p.id}</option>)}
              </select>
            </div>
            <div style={{ width: '100%', marginTop: 6 }}>
              <textarea
                className="no-print"
                placeholder="Incolla JSON layout da importare"
                value={importText}
                onChange={e => setImportText(e.target.value)}
                style={{ width: '100%', minHeight: 60, fontSize: 12, border: '1px solid #e2e8f0', borderRadius: 8, padding: 8 }}
              />
            </div>
          </div>

          {dashboardPages.map(renderDashboardPage)}
          {positionsChunks.map(renderPositionsPage)}
        </div>

        {designer && (
          <aside className="report-toolbox no-print">
            <h4>Selezione widget</h4>
            {!selectedInfo && (
              <div style={{ fontSize: 13, color: '#64748b' }}>Seleziona una card per modificarla.</div>
            )}
            {selectedInfo && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 12, color: '#0f172a', fontWeight: 700 }}>
                  {selectedType ? (titleMap[selectedType] ?? selectedType) : (titleMap[selectedInfo.id] ?? selectedInfo.id)}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
                  <label style={{ fontSize: 12 }}>
                    X (mm)
                    <input
                      type="number"
                      value={selectedInfo.x.toFixed(1)}
                      onChange={e => updateSelectedWidget(w => ({ ...w, x: parseFloat(e.target.value || '0') }))}
                    />
                  </label>
                  <label style={{ fontSize: 12 }}>
                    Y (mm)
                    <input
                      type="number"
                      value={selectedInfo.y.toFixed(1)}
                      onChange={e => updateSelectedWidget(w => ({ ...w, y: parseFloat(e.target.value || '0') }))}
                    />
                  </label>
                  <label style={{ fontSize: 12 }}>
                    W (mm)
                    <input
                      type="number"
                      value={selectedInfo.w.toFixed(1)}
                      onChange={e => updateSelectedWidget(w => ({ ...w, w: parseFloat(e.target.value || '0') }))}
                    />
                  </label>
                  <label style={{ fontSize: 12 }}>
                    H (mm)
                    <input
                      type="number"
                      value={selectedInfo.h.toFixed(1)}
                      onChange={e => updateSelectedWidget(w => ({ ...w, h: parseFloat(e.target.value || '0') }))}
                    />
                  </label>
                </div>
                {selectedType === 'currency' && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={typeof selectedInfo.props?.showLegend === 'boolean' ? selectedInfo.props.showLegend : true}
                      onChange={e => updateSelectedWidget(w => ({ ...w, props: { ...(w.props ?? {}), showLegend: e.target.checked } }))}
                    />
                    Mostra legenda
                  </label>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
                  <button onClick={() => alignSelected('left')}>Allinea SX</button>
                  <button onClick={() => alignSelected('center')}>Allinea CX</button>
                  <button onClick={() => alignSelected('right')}>Allinea DX</button>
                  <button onClick={() => alignSelected('top')}>Allinea SU</button>
                  <button onClick={() => alignSelected('middle')}>Allinea Centro</button>
                  <button onClick={() => alignSelected('bottom')}>Allinea Giu</button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
                  <button onClick={() => reorderWidget('front')}>Porta avanti</button>
                  <button onClick={() => reorderWidget('back')}>Porta dietro</button>
                  <button onClick={() => duplicateWidget(selectedWidget!.pageId, selectedInfo)}>Duplica</button>
                  <button onClick={() => updateSelectedWidget(w => ({ ...w, locked: !w.locked }))}>{selectedInfo.locked ? 'Sblocca' : 'Blocca'}</button>
                </div>
              </div>
            )}

            <div style={{ borderTop: '1px solid #e2e8f0', margin: '14px 0' }} />
            <h4>Aggancio</h4>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <input type="checkbox" checked={snapEnabled} onChange={e => setSnapEnabled(e.target.checked)} />
              Aggancio attivo
            </label>
            <label style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
              Passo (mm)
              <select value={snapStepMm} onChange={e => setSnapStepMm(parseInt(e.target.value, 10))}>
                <option value={1}>1</option>
                <option value={5}>5</option>
                <option value={10}>10</option>
              </select>
            </label>

            <div style={{ borderTop: '1px solid #e2e8f0', margin: '14px 0' }} />
            <h4>Intestazione / Pie di pagina</h4>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <input type="checkbox" checked={reportSettings.headerEnabled} onChange={e => updateSettings({ headerEnabled: e.target.checked })} />
              Intestazione attiva
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <input type="checkbox" checked={reportSettings.footerEnabled} onChange={e => updateSettings({ footerEnabled: e.target.checked })} />
              Pie di pagina attivo
            </label>
            <label style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
              Titolo intestazione
              <input type="text" value={reportSettings.headerTitle} onChange={e => updateSettings({ headerTitle: e.target.value })} />
            </label>
            <label style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
              SottoTitolo intestazione
              <input type="text" value={reportSettings.headerSubtitle} onChange={e => updateSettings({ headerSubtitle: e.target.value })} />
            </label>
            <label style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
              Pie di pagina sinistra
              <input type="text" value={reportSettings.footerLeft} onChange={e => updateSettings({ footerLeft: e.target.value })} />
            </label>
            <label style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
              Pie di pagina destra
              <input type="text" value={reportSettings.footerRightTemplate} onChange={e => updateSettings({ footerRightTemplate: e.target.value })} />
            </label>

            <div style={{ borderTop: '1px solid #e2e8f0', margin: '14px 0' }} />
            <h4>Logo</h4>
            <input
              type="file"
              accept="image/*"
              onChange={e => handleLogoUpload(e.target.files && e.target.files[0] ? e.target.files[0] : null)}
            />
            {reportSettings.logoDataUrl && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                <img src={reportSettings.logoDataUrl} alt="Logo" style={{ maxWidth: '100%', maxHeight: 80, objectFit: 'contain' }} />
                <button onClick={() => updateSettings({ logoDataUrl: undefined })}>Rimuovi logo</button>
              </div>
            )}
            <label style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
              Posizione logo
              <select value={reportSettings.logoPosition} onChange={e => updateSettings({ logoPosition: e.target.value as 'left' | 'right' })}>
                <option value="left">Sinistra</option>
                <option value="right">Destra</option>
              </select>
            </label>
            <label style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
              Dimensione logo (mm)
              <input
                type="range"
                min={6}
                max={24}
                value={reportSettings.logoSizeMm}
                onChange={e => updateSettings({ logoSizeMm: parseInt(e.target.value, 10) })}
              />
            </label>

            <div style={{ borderTop: '1px solid #e2e8f0', margin: '14px 0' }} />
            <h4>Libreria widget</h4>
            <div style={{ display: 'grid', gap: 6 }}>
              {widgetLibrary.map(item => (
                <button key={item.id} onClick={() => addWidgetById(item.id)}>
                  + {item.label}
                </button>
              ))}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
};
