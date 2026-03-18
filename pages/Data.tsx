import React, { useEffect, useMemo, useRef, useState } from 'react';
import Dexie from 'dexie';
import { useLiveQuery } from 'dexie-react-hooks';
import { useLocation } from 'react-router-dom';
import { db, getCurrentPortfolioId } from '../db';
import { AssetType, Currency, Instrument, PricePoint } from '../types';
import { analyzeFxSeries, analyzePriceSeries, FxRatePoint, analyzeRebalanceQuality } from '../services/dataQuality';
import { PRICE_GAP_DAYS } from '../services/constants';
import { fillMissingPrices } from '../services/priceBackfill';
import { buildNavSeriesDetailed, calculateHoldings, getCanonicalTicker, getValuationDateForHoldings } from '../services/financeUtils';
import { queryFxForPairsRange, queryLatestFxForPairs, queryLatestPricesForTickers, queryPriceBoundsForTickers, queryPricesForTickersRange } from '../services/dbQueries';
import { downsampleSeries } from '../services/chartUtils';
import { addDaysYmd, subDaysYmd, diffDaysYmd } from '../services/dateUtils';
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import clsx from 'clsx';
import { InfoPopover } from '../components/InfoPopover';
import { format } from 'date-fns';

type TabKey = 'prices' | 'fx' | 'checks';

const isValidDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

const dedupeByKey = <T,>(rows: T[], keyFn: (row: T) => string): T[] => {
  const map = new Map<string, T>();
  rows.forEach(row => {
    map.set(keyFn(row), row);
  });
  return Array.from(map.values());
};

const downloadText = (content: string, filename: string) => {
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

const resolveInstrumentForTicker = (instruments: Instrument[], ticker: string): Instrument | undefined => {
  return instruments.find(i => i.preferredListing?.symbol === ticker)
    || instruments.find(i => i.ticker === ticker)
    || instruments.find(i => i.listings?.some(l => l.symbol === ticker));
};

export const Data: React.FC = () => {
  const currentPortfolioId = getCurrentPortfolioId();
  const location = useLocation();
  const [tab, setTab] = useState<TabKey>('prices');
  const [showUnusedTickers, setShowUnusedTickers] = useState(false);
  const [hiddenTickers, setHiddenTickers] = useState<string[]>([]);
  const [showPreTransactions, setShowPreTransactions] = useState(false);
  const [checkRunId, setCheckRunId] = useState(0);
  const [selectedTicker, setSelectedTicker] = useState('');
  const [priceRange, setPriceRange] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const [selectedFxPair, setSelectedFxPair] = useState<string>('');
  const [fxRange, setFxRange] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const [showAllFxRows, setShowAllFxRows] = useState(false);
  const [importPreview, setImportPreview] = useState<PricePoint[]>([]);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [fxImportPreview, setFxImportPreview] = useState<FxRatePoint[]>([]);
  const [fxImportErrors, setFxImportErrors] = useState<string[]>([]);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const fxImportInputRef = useRef<HTMLInputElement | null>(null);

  const instruments = useLiveQuery(
    () => db.instruments.where('portfolioId').equals(currentPortfolioId).toArray(),
    [currentPortfolioId],
    []
  );
  const transactions = useLiveQuery(
    () => db.transactions.where('portfolioId').equals(currentPortfolioId).toArray(),
    [currentPortfolioId],
    []
  );

  const portfolioTickers = useMemo(() => {
    const set = new Set<string>();
    (instruments || []).forEach(instr => {
      const ticker = getCanonicalTicker(instr);
      if (ticker) set.add(ticker);
      if (instr.ticker) set.add(instr.ticker);
    });
    (transactions || []).forEach(t => {
      if (t.instrumentTicker) set.add(t.instrumentTicker);
    });
    return Array.from(set.values()).sort();
  }, [instruments, transactions]);

  const portfolioTickersKey = useMemo(() => portfolioTickers.join('|'), [portfolioTickers]);

  const todayYmd = useMemo(() => format(new Date(), 'yyyy-MM-dd'), []);
  const checkWindowStart = useMemo(() => subDaysYmd(todayYmd, 365), [todayYmd]);
  const checkWindowEnd = todayYmd;

  const selectedTickerBounds = useLiveQuery(
    async () => {
      if (!selectedTicker) return { firstPriceDate: undefined, lastPriceDate: undefined };
      const t0 = performance.now();
      const bounds = await queryPriceBoundsForTickers({
        portfolioId: currentPortfolioId,
        tickers: [selectedTicker],
        firstTransactionDate: '0000-01-01'
      });
      if (import.meta.env.DEV) {
        console.log('[PERF][Data] price bounds', Math.round(performance.now() - t0), 'ms', bounds);
      }
      return bounds;
    },
    [currentPortfolioId, selectedTicker],
    { firstPriceDate: undefined, lastPriceDate: undefined }
  );

  const priceQueryStart = priceRange.from || selectedTickerBounds?.firstPriceDate || '';
  const priceQueryEnd = priceRange.to || selectedTickerBounds?.lastPriceDate || '';

  const selectedPrices = useLiveQuery(
    async () => {
      if (tab !== 'prices' || !selectedTicker || !priceQueryStart || !priceQueryEnd) return [];
      const t0 = performance.now();
      const rows = await queryPricesForTickersRange({
        portfolioId: currentPortfolioId,
        tickers: [selectedTicker],
        startDate: priceQueryStart,
        endDate: priceQueryEnd
      });
      if (import.meta.env.DEV) {
        console.log('[PERF][Data] prices query', Math.round(performance.now() - t0), 'ms', {
          ticker: selectedTicker,
          count: rows.length,
          range: `${priceQueryStart}..${priceQueryEnd}`
        });
      }
      return rows;
    },
    [tab, currentPortfolioId, selectedTicker, priceQueryStart, priceQueryEnd],
    []
  );

  const checkPrices = useLiveQuery(
    async () => {
      if (!portfolioTickers.length) return [];
      const t0 = performance.now();
      const rows = await queryPricesForTickersRange({
        portfolioId: currentPortfolioId,
        tickers: portfolioTickers,
        startDate: checkWindowStart,
        endDate: checkWindowEnd
      });
      if (import.meta.env.DEV) {
        console.log('[PERF][Data] check prices query', Math.round(performance.now() - t0), 'ms', {
          tickers: portfolioTickers.length,
          count: rows.length,
          range: `${checkWindowStart}..${checkWindowEnd}`
        });
      }
      return rows;
    },
    [currentPortfolioId, portfolioTickersKey, checkWindowStart, checkWindowEnd],
    []
  );

  const latestPrices = useLiveQuery(
    async () => {
      if (!portfolioTickers.length) return [];
      const t0 = performance.now();
      const rows = await queryLatestPricesForTickers({
        portfolioId: currentPortfolioId,
        tickers: portfolioTickers
      });
      if (import.meta.env.DEV) {
        console.log('[PERF][Data] latest prices query', Math.round(performance.now() - t0), 'ms', {
          tickers: portfolioTickers.length,
          count: rows.length
        });
      }
      return rows;
    },
    [currentPortfolioId, portfolioTickersKey],
    []
  );

  const portfolioCurrencies = useMemo(() => {
    const set = new Set<Currency>();
    (instruments || []).forEach(instr => {
      if (instr.currency) set.add(instr.currency);
    });
    (transactions || []).forEach(t => {
      if (t.currency) set.add(t.currency as Currency);
    });
    return Array.from(set.values());
  }, [instruments, transactions]);

  const fxPairs = useMemo(() => {
    const base = Currency.CHF;
    return Array.from(new Set(
      portfolioCurrencies
        .filter(c => c && c !== base)
        .map(c => `${c}/${base}`)
    )).sort();
  }, [portfolioCurrencies]);

  const fxPairsKey = useMemo(() => fxPairs.join('|'), [fxPairs]);

  const fxQueryStart = fxRange.from || subDaysYmd(todayYmd, 365);
  const fxQueryEnd = fxRange.to || todayYmd;

  const selectedFxRates = useLiveQuery(
    async () => {
      if (tab !== 'fx' || !selectedFxPair) return [];
      const t0 = performance.now();
      const rows = await queryFxForPairsRange({
        pairs: [selectedFxPair],
        startDate: fxQueryStart,
        endDate: fxQueryEnd
      });
      if (import.meta.env.DEV) {
        console.log('[PERF][Data] fx query', Math.round(performance.now() - t0), 'ms', {
          pair: selectedFxPair,
          count: rows.length,
          range: `${fxQueryStart}..${fxQueryEnd}`
        });
      }
      return rows;
    },
    [tab, selectedFxPair, fxQueryStart, fxQueryEnd],
    []
  );

  const checkFxRates = useLiveQuery(
    async () => {
      if (!fxPairs.length) return [];
      const t0 = performance.now();
      const rows = await queryFxForPairsRange({
        pairs: fxPairs,
        startDate: checkWindowStart,
        endDate: checkWindowEnd
      });
      if (import.meta.env.DEV) {
        console.log('[PERF][Data] check fx query', Math.round(performance.now() - t0), 'ms', {
          pairs: fxPairs.length,
          count: rows.length,
          range: `${checkWindowStart}..${checkWindowEnd}`
        });
      }
      return rows;
    },
    [fxPairsKey, checkWindowStart, checkWindowEnd],
    []
  );

  const valuationDate = useMemo(() => {
    if (!transactions || !instruments || !latestPrices.length) return '';
    return getValuationDateForHoldings(transactions, latestPrices, instruments) || '';
  }, [transactions, instruments, latestPrices]);

  const latestFxRates = useLiveQuery(
    async () => {
      if (!fxPairs.length || !valuationDate) return [];
      const t0 = performance.now();
      const rows = await queryLatestFxForPairs({
        pairs: fxPairs,
        upToDate: valuationDate
      });
      if (import.meta.env.DEV) {
        console.log('[PERF][Data] latest fx query', Math.round(performance.now() - t0), 'ms', {
          pairs: fxPairs.length,
          count: rows.length,
          upToDate: valuationDate
        });
      }
      return rows;
    },
    [fxPairsKey, valuationDate],
    []
  );

  useEffect(() => {
    const key = `hiddenTickers:${currentPortfolioId}`;
    const raw = localStorage.getItem(key);
    if (!raw) {
      setHiddenTickers([]);
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setHiddenTickers(parsed.filter((t: unknown) => typeof t === 'string'));
      } else {
        setHiddenTickers([]);
      }
    } catch {
      setHiddenTickers([]);
    }
  }, [currentPortfolioId]);

  const persistHiddenTickers = (next: string[]) => {
    const key = `hiddenTickers:${currentPortfolioId}`;
    localStorage.setItem(key, JSON.stringify(next));
    setHiddenTickers(next);
  };

  const tickers = useMemo(() => {
    return portfolioTickers;
  }, [portfolioTickers]);

  const checkTickers = useMemo(() => {
    const maxTickers = 40;
    return tickers.length > maxTickers ? tickers.slice(0, maxTickers) : tickers;
  }, [tickers]);

  const usedTickers = useMemo(() => {
    const used = new Set<string>(portfolioTickers);
    if (selectedTicker) used.add(selectedTicker);
    return used;
  }, [portfolioTickers, selectedTicker]);

  const tickerOptions = useMemo(() => {
    const options = new Map<string, { value: string; label: string; isPreferred: boolean; isAlternative: boolean; instrument?: Instrument }>();
    const instrumentsList = instruments || [];
    const priceTickers = new Set(portfolioTickers);
    const txTickers = new Set(
      (transactions || [])
        .map(t => t.instrumentTicker)
        .filter((ticker): ticker is string => Boolean(ticker))
    );

    const addOption = (ticker: string) => {
      if (!ticker || options.has(ticker)) return;
      const instr = resolveInstrumentForTicker(instrumentsList, ticker);
      const canonical = instr ? getCanonicalTicker(instr) : '';
      const isPreferred = canonical ? canonical === ticker : false;
      const isAlternative = !!instr && !isPreferred;
      const name = instr?.name ? ` - ${instr.name}` : '';
      const isin = instr?.isin ? ` (${instr.isin})` : '';
      const suffix = isPreferred ? ' • attivo' : isAlternative ? ' • alt' : '';
      options.set(ticker, { value: ticker, label: `${ticker}${name}${isin}${suffix}`, isPreferred, isAlternative, instrument: instr });
    };

    instrumentsList.forEach(instr => addOption(getCanonicalTicker(instr)));
    priceTickers.forEach(ticker => addOption(ticker));
    txTickers.forEach(ticker => addOption(ticker));

    const filtered = Array.from(options.values()).filter(opt => {
      if (hiddenTickers.includes(opt.value)) return false;
      if (showUnusedTickers) return true;
      return usedTickers.has(opt.value);
    });

    return filtered.sort((a, b) => a.label.localeCompare(b.label));
  }, [portfolioTickers, instruments, transactions, hiddenTickers, showUnusedTickers, usedTickers]);

  const selectedInstrument = useMemo(() => {
    if (!selectedTicker || !instruments) return undefined;
    return resolveInstrumentForTicker(instruments, selectedTicker);
  }, [selectedTicker, instruments]);

  const selectedCanonicalTicker = selectedInstrument ? getCanonicalTicker(selectedInstrument) : '';
  const isSelectedPreferred = !!selectedTicker && !!selectedCanonicalTicker && selectedTicker === selectedCanonicalTicker;
  const hasPriceData = useMemo(() => {
    if (!selectedTicker) return false;
    return (selectedPrices || []).some(p => p.ticker === selectedTicker);
  }, [selectedPrices, selectedTicker]);

  const firstTransactionDateByTicker = useMemo(() => {
    const map = new Map<string, string>();
    (transactions || []).forEach(t => {
      if (!t.instrumentTicker) return;
      const dateStr = format(t.date, 'yyyy-MM-dd');
      const prev = map.get(t.instrumentTicker);
      if (!prev || dateStr < prev) {
        map.set(t.instrumentTicker, dateStr);
      }
    });
    return map;
  }, [transactions]);

  const firstTransactionDate = useMemo(() => {
    if (!selectedTicker) return '';
    if (selectedInstrument?.ticker) {
      return firstTransactionDateByTicker.get(selectedInstrument.ticker) || '';
    }
    return firstTransactionDateByTicker.get(selectedTicker) || '';
  }, [selectedTicker, selectedInstrument, firstTransactionDateByTicker]);

  const hiddenTickersSet = useMemo(() => new Set(hiddenTickers), [hiddenTickers]);

  const cleanupCandidates = useMemo(() => {
    if (!instruments || !transactions) return [];
    const canonicalSet = new Set(instruments.map(instr => getCanonicalTicker(instr)));
    const txSet = new Set(transactions.map(t => t.instrumentTicker).filter(Boolean) as string[]);
    const priceSet = new Set(portfolioTickers);
    const allTickers = new Set<string>();
    instruments.forEach(instr => {
      const canonical = getCanonicalTicker(instr);
      if (canonical) allTickers.add(canonical);
      if (instr.ticker) allTickers.add(instr.ticker);
      (instr.listings || []).forEach(listing => {
        if (listing.symbol) allTickers.add(listing.symbol);
      });
    });
    priceSet.forEach(ticker => allTickers.add(ticker));
    txSet.forEach(ticker => allTickers.add(ticker));

    const candidates: { ticker: string; reason: string }[] = [];
    allTickers.forEach(ticker => {
      if (!ticker) return;
      if (canonicalSet.has(ticker)) return;
      if (txSet.has(ticker)) return;
      if (hiddenTickersSet.has(ticker)) return;
      if (!priceSet.has(ticker) && !showUnusedTickers) return;
      candidates.push({ ticker, reason: 'Listing non canonico senza transazioni' });
    });
    return candidates.sort((a, b) => a.ticker.localeCompare(b.ticker));
  }, [portfolioTickers, instruments, transactions, hiddenTickersSet, showUnusedTickers]);

  const priceCounts = useLiveQuery(
    async () => {
      if (tab !== 'prices' || !portfolioTickers.length) return new Map<string, number>();
      const t0 = performance.now();
      const entries = await Promise.all(portfolioTickers.map(async ticker => {
        const count = await db.prices
          .where('[ticker+date]')
          .between([ticker, Dexie.minKey], [ticker, Dexie.maxKey])
          .and(p => p.portfolioId === currentPortfolioId)
          .count();
        return [ticker, count] as const;
      }));
      const map = new Map<string, number>(entries);
      if (import.meta.env.DEV) {
        console.log('[PERF][Data] price counts', Math.round(performance.now() - t0), 'ms', {
          tickers: portfolioTickers.length
        });
      }
      return map;
    },
    [tab, currentPortfolioId, portfolioTickersKey],
    new Map<string, number>()
  );

  const cleanupMeta = useMemo(() => {
    if (!transactions || !instruments) return null;
    const canonicalSet = new Set(instruments.map(instr => getCanonicalTicker(instr)));
    const txSet = new Set(transactions.map(t => t.instrumentTicker).filter(Boolean) as string[]);
    return { canonicalSet, txSet, priceCount: priceCounts };
  }, [transactions, instruments, priceCounts]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const tabParam = params.get('tab');
    const dateParam = params.get('date') || '';
    const tickerParam = params.get('ticker') || '';
    const baseParam = params.get('base') || '';
    const quoteParam = params.get('quote') || '';

    if (tabParam) {
      const normalized = tabParam === 'check' ? 'checks' : tabParam;
      if (normalized === 'prices' || normalized === 'fx' || normalized === 'checks') {
        setTab(normalized);
      }
    }

    if (tickerParam) {
      setSelectedTicker(tickerParam);
      if (dateParam) {
        setPriceRange({ from: dateParam, to: dateParam });
      }
    } else if (dateParam && tabParam === 'prices') {
      setPriceRange({ from: dateParam, to: dateParam });
    }

    if (baseParam && quoteParam) {
      setSelectedFxPair(`${baseParam}/${quoteParam}`);
      if (dateParam) {
        setFxRange({ from: dateParam, to: dateParam });
      }
    } else if (dateParam && tabParam === 'fx') {
      setFxRange({ from: dateParam, to: dateParam });
    }
  }, [location.search]);

  useEffect(() => {
    setShowAllFxRows(false);
  }, [selectedFxPair]);

  const filteredPrices = useMemo(() => {
    return selectedPrices || [];
  }, [selectedPrices]);

  const warningsFromDate = useMemo(() => {
    if (showPreTransactions) return '';
    const base = firstTransactionDate || '';
    const userFrom = priceRange.from || '';
    if (base && userFrom) return userFrom > base ? userFrom : base;
    return userFrom || base;
  }, [showPreTransactions, firstTransactionDate, priceRange.from]);

  const { priceAnalysis, visiblePriceIssues } = useMemo(() => {
    const analysis = analyzePriceSeries(filteredPrices, {
      assetClass: selectedInstrument?.assetClass,
      assetType: selectedInstrument?.type
    });

    if (!analysis.issues.length) {
      return { priceAnalysis: analysis, visiblePriceIssues: [] as typeof analysis.issues };
    }
    if (!warningsFromDate) {
      return { priceAnalysis: analysis, visiblePriceIssues: analysis.issues };
    }
    return {
      priceAnalysis: analysis,
      visiblePriceIssues: analysis.issues.filter(issue => !issue.date || issue.date >= warningsFromDate)
    };
  }, [filteredPrices, selectedInstrument, warningsFromDate]);

  const fxFiltered = useMemo(() => {
    return selectedFxRates || [];
  }, [selectedFxRates]);

  const fxAnalysis = useMemo(() => analyzeFxSeries(fxFiltered), [fxFiltered]);
  const fxTableRows = useMemo(() => {
    return fxFiltered
      .slice()
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [fxFiltered]);
  const fxTableMaxRows = 200;
  const fxTableVisible = useMemo(
    () => (showAllFxRows ? fxTableRows : fxTableRows.slice(0, fxTableMaxRows)),
    [fxTableRows, showAllFxRows]
  );
  const fxGapDetails = useMemo(() => {
    const sorted = fxFiltered.slice().sort((a, b) => a.date.localeCompare(b.date));
    const gaps: { from: string; to: string; days: number }[] = [];
    let prevDate: string | null = null;
    sorted.forEach(row => {
      if (prevDate) {
        const gap = diffDaysYmd(row.date, prevDate);
        if (gap > PRICE_GAP_DAYS) {
          gaps.push({
            from: addDaysYmd(prevDate, 1),
            to: subDaysYmd(row.date, 1),
            days: gap - 1
          });
        }
      }
      prevDate = row.date;
    });
    return gaps.sort((a, b) => b.days - a.days);
  }, [fxFiltered]);

  const priceChartData = useMemo(() => {
    return filteredPrices
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(p => ({ date: p.date, close: p.close }));
  }, [filteredPrices]);

  const fxChartData = useMemo(() => {
    return fxFiltered
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(p => ({ date: p.date, close: p.rate }));
  }, [fxFiltered]);

  const priceChartSeries = useMemo(() => downsampleSeries(priceChartData, 900), [priceChartData]);
  const fxChartSeries = useMemo(() => downsampleSeries(fxChartData, 900), [fxChartData]);

  const handlePriceExport = () => {
    if (!selectedTicker) return;
    const rows = filteredPrices
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(p => `${p.date},${p.close},${p.currency},${p.ticker}`);
    const content = ['date,close,currency,ticker', ...rows].join('\n');
    downloadText(content, `prices-${selectedTicker}.csv`);
  };

  const handleFxExport = () => {
    if (!selectedFxPair) return;
    const rows = fxFiltered
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(p => `${p.date},${p.rate},${p.baseCurrency},${p.quoteCurrency}`);
    const content = ['date,rate,base,quote', ...rows].join('\n');
    downloadText(content, `fx-${selectedFxPair.replace('/', '-')}.csv`);
  };

  const handleTxExport = () => {
    if (!transactions || !transactions.length) return;
    downloadText(JSON.stringify(transactions, null, 2), `transactions-${currentPortfolioId}.json`);
  };

  const handlePriceCurrencyChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value as Currency;
    if (!selectedTicker || !next || hasPriceData) return;
    await db.prices
      .where('portfolioId')
      .equals(currentPortfolioId)
      .and(p => p.ticker === selectedTicker)
      .modify({ currency: next });
  };

  const parsePriceImport = async (file: File) => {
    const text = await file.text();
    const errors: string[] = [];
    const rows: PricePoint[] = [];
    try {
      const json = JSON.parse(text);
      if (Array.isArray(json)) {
        json.forEach((row: any, idx: number) => {
          const date = row.date;
          const close = Number(row.close);
          const currency = row.currency || Currency.CHF;
          const ticker = row.ticker || selectedTicker;
          if (!ticker) errors.push(`Riga ${idx + 1}: ticker mancante`);
          if (!isValidDate(date)) errors.push(`Riga ${idx + 1}: data non valida`);
          if (!Number.isFinite(close) || close <= 0) errors.push(`Riga ${idx + 1}: close non valido`);
          if (ticker && isValidDate(date) && Number.isFinite(close) && close > 0) {
            rows.push({ ticker, date, close, currency, portfolioId: currentPortfolioId } as PricePoint);
          }
        });
        const deduped = dedupeByKey(rows, row => `${row.ticker}|${row.date}`);
        return { rows: deduped, errors };
      }
    } catch {
      // fall back to CSV
    }

    const lines = text.trim().split(/\r?\n/);
    const dataLines = lines[0]?.toLowerCase().includes('date') ? lines.slice(1) : lines;
    dataLines.forEach((line, idx) => {
      const parts = line.split(',').map(p => p.trim());
      const date = parts[0];
      const close = Number(parts[1]);
      const currency = (parts[2] as Currency) || Currency.CHF;
      const ticker = parts[3] || selectedTicker;
      if (!ticker) errors.push(`Riga ${idx + 1}: ticker mancante`);
      if (!isValidDate(date)) errors.push(`Riga ${idx + 1}: data non valida`);
      if (!Number.isFinite(close) || close <= 0) errors.push(`Riga ${idx + 1}: close non valido`);
      if (ticker && isValidDate(date) && Number.isFinite(close) && close > 0) {
        rows.push({ ticker, date, close, currency, portfolioId: currentPortfolioId } as PricePoint);
      }
    });
    const deduped = dedupeByKey(rows, row => `${row.ticker}|${row.date}`);
    return { rows: deduped, errors };
  };

  const parseFxImport = async (file: File) => {
    const text = await file.text();
    const errors: string[] = [];
    const rows: FxRatePoint[] = [];
    try {
      const json = JSON.parse(text);
      if (Array.isArray(json)) {
        json.forEach((row: any, idx: number) => {
          const date = row.date;
          const rate = Number(row.rate);
          const base = row.baseCurrency;
          const quote = row.quoteCurrency;
          if (!base || !quote) errors.push(`Riga ${idx + 1}: coppia mancante`);
          if (!isValidDate(date)) errors.push(`Riga ${idx + 1}: data non valida`);
          if (!Number.isFinite(rate) || rate <= 0) errors.push(`Riga ${idx + 1}: rate non valido`);
          if (base && quote && isValidDate(date) && Number.isFinite(rate) && rate > 0) {
            rows.push({ baseCurrency: base, quoteCurrency: quote, date, rate });
          }
        });
        const deduped = dedupeByKey(rows, row => `${row.baseCurrency}/${row.quoteCurrency}|${row.date}`);
        return { rows: deduped, errors };
      }
    } catch {
      // fall back to CSV
    }

    const lines = text.trim().split(/\r?\n/);
    const dataLines = lines[0]?.toLowerCase().includes('date') ? lines.slice(1) : lines;
    dataLines.forEach((line, idx) => {
      const parts = line.split(',').map(p => p.trim());
      const date = parts[0];
      const rate = Number(parts[1]);
      const base = parts[2] as Currency;
      const quote = parts[3] as Currency;
      if (!base || !quote) errors.push(`Riga ${idx + 1}: coppia mancante`);
      if (!isValidDate(date)) errors.push(`Riga ${idx + 1}: data non valida`);
      if (!Number.isFinite(rate) || rate <= 0) errors.push(`Riga ${idx + 1}: rate non valido`);
      if (base && quote && isValidDate(date) && Number.isFinite(rate) && rate > 0) {
        rows.push({ baseCurrency: base, quoteCurrency: quote, date, rate });
      }
    });
    const deduped = dedupeByKey(rows, row => `${row.baseCurrency}/${row.quoteCurrency}|${row.date}`);
    return { rows: deduped, errors };
  };

  const handlePriceImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const { rows, errors } = await parsePriceImport(file);
    setImportPreview(rows);
    setImportErrors(errors);
  };

  const handleFxImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const { rows, errors } = await parseFxImport(file);
    setFxImportPreview(rows);
    setFxImportErrors(errors);
  };

  const confirmPriceImport = async () => {
    if (!importPreview.length) return;
    await db.prices.bulkPut(importPreview.map(p => ({ ...p, portfolioId: currentPortfolioId })));
    setImportPreview([]);
    setImportErrors([]);
  };

  const confirmFxImport = async () => {
    if (!fxImportPreview.length) return;
    await db.fxRates.bulkPut(fxImportPreview);
    setFxImportPreview([]);
    setFxImportErrors([]);
  };

  const removeDuplicatePrices = async () => {
    const rows = await db.prices.where('portfolioId').equals(currentPortfolioId).toArray();
    if (!rows || rows.length === 0) return;
    const byKey = new Map<string, PricePoint[]>();
    rows.forEach(row => {
      const key = `${row.ticker}|${row.date}`;
      const arr = byKey.get(key) || [];
      arr.push(row);
      byKey.set(key, arr);
    });
    const toDelete: number[] = [];
    byKey.forEach(rows => {
      if (rows.length <= 1) return;
      const sorted = rows
        .filter(r => typeof r.id === 'number')
        .sort((a, b) => (a.id! - b.id!));
      sorted.slice(0, -1).forEach(r => toDelete.push(r.id as number));
    });
    if (toDelete.length > 0) {
      await db.prices.bulkDelete(toDelete);
    }
  };

  const removeDuplicateFx = async () => {
    const rows = await db.fxRates.toArray();
    if (!rows || rows.length === 0) return;
    const byKey = new Map<string, { id?: number }[]>();
    rows.forEach(row => {
      const key = `${row.baseCurrency}/${row.quoteCurrency}|${row.date}`;
      const arr = byKey.get(key) || [];
      arr.push(row);
      byKey.set(key, arr);
    });
    const toDelete: number[] = [];
    byKey.forEach(rows => {
      if (rows.length <= 1) return;
      const sorted = rows
        .filter(r => typeof r.id === 'number')
        .sort((a, b) => (a.id! - b.id!));
      sorted.slice(0, -1).forEach(r => toDelete.push(r.id as number));
    });
    if (toDelete.length > 0) {
      await db.fxRates.bulkDelete(toDelete);
    }
  };

  const navChecks = useMemo(() => {
    if (checkRunId === 0) return null;
    if (!transactions || !instruments || !checkPrices) return null;
    const detailed = buildNavSeriesDetailed(transactions, instruments, checkPrices, 'daily', checkWindowStart, checkWindowEnd);
    const missingPriceDays = detailed.filter(p => p.missingPriceTickers.length > 0);
    const backfilledDays = detailed.filter(p => p.backfilledPriceTickers.length > 0);
    const dateIndex = detailed.map(point => point.date);
    const priceTickers = Array.from(new Set(instruments.map(instr => getCanonicalTicker(instr)).filter(Boolean)));
    const fillResult = fillMissingPrices(checkPrices, dateIndex, { tickers: priceTickers });
    const priceFillMeta = fillResult.meta;
    const warningsByTicker = new Map<string, { startDate: string; endDate: string; gapDays: number }[]>();
    priceFillMeta.warnings.forEach(w => {
      const arr = warningsByTicker.get(w.ticker) || [];
      arr.push(w);
      warningsByTicker.set(w.ticker, arr);
    });
    const tickerMeta = new Map<string, { isCrypto: boolean; group: string }>();
    priceTickers.forEach(ticker => {
      const instr = resolveInstrumentForTicker(instruments || [], ticker);
      const isCrypto = instr?.type === AssetType.Crypto;
      const parts = ticker.split('.');
      const group = isCrypto ? 'CRYPTO' : (parts.length > 1 ? (parts[parts.length - 1] || 'NO_SUFFIX').toUpperCase() : 'NO_SUFFIX');
      tickerMeta.set(ticker, { isCrypto, group });
    });
    const datesPresentByTicker = new Map<string, Set<string>>();
    const unionTradingDatesByGroup = new Map<string, Set<string>>();
    checkPrices.forEach(row => {
      if (!row?.ticker || !row?.date) return;
      const set = datesPresentByTicker.get(row.ticker) || new Set<string>();
      set.add(row.date);
      datesPresentByTicker.set(row.ticker, set);
      const meta = tickerMeta.get(row.ticker);
      if (!meta || meta.isCrypto) return;
      const groupSet = unionTradingDatesByGroup.get(meta.group) || new Set<string>();
      groupSet.add(row.date);
      unionTradingDatesByGroup.set(meta.group, groupSet);
    });

    let weekendTotal = 0;
    let closedTotal = 0;
    let realMissingTotal = 0;

    const backfillRows = priceTickers
      .map(ticker => {
        const meta = tickerMeta.get(ticker) || {
          isCrypto: false,
          group: (ticker.split('.').length > 1 ? ticker.split('.').pop() || 'NO_SUFFIX' : 'NO_SUFFIX')
        };
        const present = datesPresentByTicker.get(ticker) || new Set<string>();
        let weekendCount = 0;
        let closedCount = 0;
        let realMissing = 0;
        if (meta.isCrypto) {
          dateIndex.forEach(date => {
            if (!present.has(date)) realMissing += 1;
          });
        } else {
          const tradingDates = unionTradingDatesByGroup.get(meta.group) || new Set<string>();
          dateIndex.forEach(date => {
            if (present.has(date)) return;
            const day = new Date(`${date}T00:00:00Z`).getUTCDay();
            if (day === 0 || day === 6) {
              weekendCount += 1;
              return;
            }
            if (!tradingDates.has(date)) {
              closedCount += 1;
              return;
            }
            realMissing += 1;
          });
        }
        weekendTotal += weekendCount;
        closedTotal += closedCount;
        realMissingTotal += realMissing;
        let range: { start: string; end: string; gapDays?: number } | undefined;
        if (realMissing > 0) {
          const warn = warningsByTicker.get(ticker)?.[0];
          if (warn) {
            range = { start: warn.startDate, end: warn.endDate, gapDays: warn.gapDays };
          }
        }
        return {
          ticker,
          realMissingDays: realMissing,
          weekendDays: weekendCount,
          closedDays: closedCount,
          isCrypto: meta.isCrypto,
          range
        };
      })
      .sort((a, b) => b.realMissingDays - a.realMissingDays);

    const filteredWarnings = priceFillMeta.warnings.filter(w => {
      const row = backfillRows.find(r => r.ticker === w.ticker);
      return row ? row.realMissingDays > 0 : false;
    });
    return {
      missingPriceDays: missingPriceDays.length,
      examples: missingPriceDays.slice(0, 5),
      backfilledPriceDays: backfilledDays.length,
      backfillTotal: priceFillMeta.totalFilled,
      weekendTotal,
      closedTotal,
      realMissingTotal,
      backfillRows,
      backfillWarnings: filteredWarnings
    };
  }, [transactions, instruments, checkPrices, checkRunId, checkWindowStart, checkWindowEnd]);

  const rebalanceQuality = useMemo(() => {
    if (checkRunId === 0) return null;
    if (!transactions || !instruments || !latestPrices || !latestFxRates) return null;
    if (!valuationDate) return null;
    const holdings = calculateHoldings(transactions);
    return {
      valuationDate,
      summary: analyzeRebalanceQuality(holdings, instruments, latestPrices, latestFxRates, valuationDate, Currency.CHF)
    };
  }, [transactions, instruments, latestPrices, latestFxRates, valuationDate, checkRunId]);

  const navSummary = useMemo(() => {
    if (checkRunId === 0) return null;
    if (!transactions || !instruments || !checkPrices) return null;
    const detailed = buildNavSeriesDetailed(transactions, instruments, checkPrices, 'daily', checkWindowStart, checkWindowEnd);
    if (!detailed.length) return null;
    const start = detailed[0];
    const end = detailed[detailed.length - 1];
    const netExternalFlows = detailed.reduce((sum, p) => sum + p.externalFlow, 0);
    const pnl = end.navBaseCcy - start.navBaseCcy - netExternalFlows;
    const totalReturnPct = start.navBaseCcy > 0 ? (pnl / start.navBaseCcy) * 100 : 0;
    return {
      startDate: start.date,
      endDate: end.date,
      navStart: start.navBaseCcy,
      navEnd: end.navBaseCcy,
      netExternalFlows,
      pnl,
      totalReturnPct
    };
  }, [transactions, instruments, checkPrices, checkRunId, checkWindowStart, checkWindowEnd]);

  const priceChecksSummary = useMemo(() => {
    if (!checkPrices || checkTickers.length === 0) return [];
    return checkTickers.map(ticker => {
      const rows = checkPrices.filter(p => p.ticker === ticker);
      const instr = resolveInstrumentForTicker(instruments || [], ticker);
      const { stats, issues } = analyzePriceSeries(rows, {
        assetClass: instr?.assetClass,
        assetType: instr?.type
      });
      return { ticker, stats, issueCount: issues.length };
    });
  }, [checkPrices, checkTickers, instruments]);

  const fxChecksSummary = useMemo(() => {
    if (!checkFxRates || fxPairs.length === 0) return [];
    return fxPairs.map(pair => {
      const [base, quote] = pair.split('/');
      const rows = (checkFxRates as FxRatePoint[]).filter(r => r.baseCurrency === base && r.quoteCurrency === quote);
      const { stats, issues } = analyzeFxSeries(rows);
      return { pair, stats, issueCount: issues.length };
    });
  }, [checkFxRates, fxPairs]);

  const topIssues = useMemo(() => {
    const items: {
      key: string;
      title: string;
      detail: string;
      meaning: string;
      action: string;
      primary: { label: string; href: string };
      secondary?: { label: string; href: string };
    }[] = [];

    const pushItem = (item: typeof items[number]) => {
      if (items.length >= 3) return;
      if (items.some(existing => existing.key === item.key)) return;
      items.push(item);
    };

    const rebalanceIssues = (
      (rebalanceQuality as any)?.summary?.issues
      || (rebalanceQuality as any)?.issues
      || []
    ) as Array<{
      type?: string;
      ticker?: string;
      priceTicker?: string;
      fxBase?: string;
      fxQuote?: string;
    }>;
    const priceMissing = Array.from(new Set(rebalanceIssues.filter(i => i.type === 'priceMissing').map(i => i.priceTicker || i.ticker)));
    const priceStale = Array.from(new Set(rebalanceIssues.filter(i => i.type === 'priceStale').map(i => i.priceTicker || i.ticker)));
    const fxMissing = Array.from(new Set(rebalanceIssues.filter(i => i.type === 'fxMissing').map(i => `${i.fxBase || 'FX'}/${i.fxQuote || 'CHF'}`)));
    const fxStale = Array.from(new Set(rebalanceIssues.filter(i => i.type === 'fxStale').map(i => `${i.fxBase || 'FX'}/${i.fxQuote || 'CHF'}`)));
    const currencyMismatch = Array.from(new Set(rebalanceIssues.filter(i => i.type === 'currencyMismatch').map(i => i.priceTicker || i.ticker)));

    const gapTickers = priceChecksSummary.filter(row => row.stats.gaps > 0).map(row => row.ticker);
    const fxGapPairs = fxChecksSummary.filter(row => row.stats.gaps > 0).map(row => row.pair);

    if (priceMissing.length) {
      pushItem({
        key: 'priceMissing',
        title: 'Prezzi mancanti',
        detail: priceMissing.slice(0, 3).join(', '),
        meaning: 'Mancano prezzi alla valuation date per alcuni strumenti.',
        action: 'Aggiorna i prezzi o scarica lo storico.',
        primary: { label: 'Vai a Settings (Aggiorna/Storico)', href: '#/settings' },
        secondary: { label: 'Apri tab Prezzi', href: '#/data?tab=prices' }
      });
    }

    if (fxMissing.length) {
      pushItem({
        key: 'fxMissing',
        title: 'FX mancante',
        detail: fxMissing.slice(0, 3).join(', '),
        meaning: 'Mancano tassi FX necessari alla conversione in CHF.',
        action: 'Importa FX o aggiorna da Apps Script.',
        primary: { label: 'Vai a Settings (FX)', href: '#/settings' },
        secondary: { label: 'Apri tab FX', href: '#/data?tab=fx' }
      });
    }

    if (priceStale.length) {
      pushItem({
        key: 'priceStale',
        title: 'Prezzi datati',
        detail: priceStale.slice(0, 3).join(', '),
        meaning: 'Ultimo prezzo troppo vecchio per una valutazione affidabile.',
        action: 'Aggiorna i prezzi di oggi.',
        primary: { label: 'Vai a Settings (Aggiorna)', href: '#/settings' },
        secondary: { label: 'Apri tab Prezzi', href: '#/data?tab=prices' }
      });
    }

    if (fxStale.length) {
      pushItem({
        key: 'fxStale',
        title: 'FX datato',
        detail: fxStale.slice(0, 3).join(', '),
        meaning: 'I tassi FX sono vecchi rispetto alla valuation date.',
        action: 'Aggiorna i tassi FX.',
        primary: { label: 'Vai a Settings (FX)', href: '#/settings' },
        secondary: { label: 'Apri tab FX', href: '#/data?tab=fx' }
      });
    }

    if (currencyMismatch.length) {
      pushItem({
        key: 'currencyMismatch',
        title: 'Valuta non coerente',
        detail: currencyMismatch.slice(0, 3).join(', '),
        meaning: 'La valuta del prezzo non coincide con quella dello strumento.',
        action: 'Verifica il listing e reimporta i prezzi.',
        primary: { label: 'Apri tab Prezzi', href: '#/data?tab=prices' },
        secondary: { label: 'Vai a Settings', href: '#/settings' }
      });
    }

    if (gapTickers.length) {
      pushItem({
        key: 'priceGaps',
        title: 'Gap prezzi',
        detail: gapTickers.slice(0, 3).join(', '),
        meaning: 'La serie prezzi ha buchi significativi.',
        action: 'Scarica storico o importa prezzi mancanti.',
        primary: { label: 'Vai a Settings (Storico)', href: '#/settings' },
        secondary: { label: 'Apri tab Prezzi', href: '#/data?tab=prices' }
      });
    }

    if (fxGapPairs.length) {
      pushItem({
        key: 'fxGaps',
        title: 'Gap FX',
        detail: fxGapPairs.slice(0, 3).join(', '),
        meaning: 'La serie FX ha buchi che impattano il NAV.',
        action: 'Importa FX o aggiorna i tassi.',
        primary: { label: 'Vai a Settings (FX)', href: '#/settings' },
        secondary: { label: 'Apri tab FX', href: '#/data?tab=fx' }
      });
    }

    return items;
  }, [rebalanceQuality, priceChecksSummary, fxChecksSummary]);

  const hasTopIssues = topIssues.length > 0;
  const technicalDetails = useMemo(() => {
    const rebalanceIssues = rebalanceQuality?.summary.issues || [];
    const rebalanceCount = rebalanceIssues.length;
    const priceIssueTotal = priceChecksSummary.reduce((sum, row) => sum + row.issueCount, 0);
    const fxIssueTotal = fxChecksSummary.reduce((sum, row) => sum + row.issueCount, 0);
    return {
      rebalanceCount,
      priceIssueTotal,
      fxIssueTotal,
      missingPriceDays: navChecks?.missingPriceDays ?? 0,
      backfillTotal: navChecks?.backfillTotal ?? 0,
      hasData: rebalanceCount > 0 || priceIssueTotal > 0 || fxIssueTotal > 0 || Boolean(navChecks)
    };
  }, [rebalanceQuality, priceChecksSummary, fxChecksSummary, navChecks]);

  const getStatusBadge = (issueCount: number, stats: { gaps: number; invalid: number }) => {
    if (issueCount === 0) return { label: 'OK', className: 'bg-emerald-100 text-emerald-800', title: 'OK: nessun problema rilevato' };
    if (stats.gaps > 0 || stats.invalid > 0) return { label: 'INCOMPLETO', className: 'bg-amber-100 text-amber-800', title: 'Incompleto: gap o dati invalidi' };
    return { label: 'PARZIALE', className: 'bg-slate-100 text-slate-700', title: 'Parziale: anomalie non bloccanti' };
  };

  const openTab = (next: TabKey) => {
    setTab(next);
    if (typeof window !== 'undefined') {
      window.location.hash = `/data?tab=${next}`;
    }
  };

  const openTabFromHref = (href: string) => {
    if (!href.includes('?')) {
      if (typeof window !== 'undefined') window.location.hash = href.replace(/^#/, '');
      return;
    }
    const query = href.split('?')[1] || '';
    const params = new URLSearchParams(query);
    const tabParam = params.get('tab');
    if (tabParam === 'prices' || tabParam === 'fx' || tabParam === 'checks') {
      openTab(tabParam);
      return;
    }
    if (typeof window !== 'undefined') window.location.hash = href.replace(/^#/, '');
  };

  return (
    <div className="space-y-6 pb-20 animate-fade-in text-textPrimary">
      <div className="ui-panel p-6">
        <div className="flex items-center gap-2">
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <span className="material-symbols-outlined text-[#0052a3]">science</span>
            Diagnostica dati
          </h2>
          <InfoPopover
            ariaLabel="Guida diagnostica dati"
            title="Come usare la diagnostica"
            popoverClassName="left-1/2 -translate-x-1/2 right-auto"
            renderContent={() => (
              <div className="text-sm space-y-2">
                <p>Seleziona un ticker o una coppia FX per vedere serie, statistiche e anomalie.</p>
                <p>Usa Export/Import per correggere i dati e validare prima di salvare.</p>
                <p>Tab Check: riepilogo qualità dati e NAV summary per verificare i KPI.</p>
              </div>
            )}
          />
        </div>
        <p className="text-xs text-slate-500 mt-1">Visibile solo in DEV. Controlla prezzi, FX e qualita dati.</p>

        <div className="mt-4">
          {hasTopIssues ? (
            <div className="ui-panel border-amber-200 bg-amber-50 p-4 space-y-3 text-xs text-amber-900">
              <div className="font-bold text-amber-900">Top 3 problemi</div>
              {topIssues.map(issue => (
                <div key={issue.key} className="ui-panel-subtle border-amber-200 p-3">
                  <div className="font-semibold text-amber-900">{issue.title}</div>
                  <div className="text-amber-800">{issue.detail}</div>
                  <div className="mt-2 text-amber-900">
                    <div><span className="font-semibold">Significato:</span> {issue.meaning}</div>
                    <div><span className="font-semibold">Azione:</span> {issue.action}</div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {issue.primary.href.startsWith('#/data?tab=') ? (
                      <button
                        type="button"
                        onClick={() => openTabFromHref(issue.primary.href)}
                        className="inline-flex items-center gap-2 bg-[#0052a3] text-white px-3 py-1.5 rounded-lg text-[11px] font-bold shadow-sm hover:bg-blue-600 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                      >
                        {issue.primary.label}
                      </button>
                    ) : (
                      <a
                        href={issue.primary.href}
                        className="inline-flex items-center gap-2 bg-[#0052a3] text-white px-3 py-1.5 rounded-lg text-[11px] font-bold shadow-sm hover:bg-blue-600 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                      >
                        {issue.primary.label}
                      </a>
                    )}
                    {issue.secondary && (
                      issue.secondary.href.startsWith('#/data?tab=') ? (
                        <button
                          type="button"
                          onClick={() => openTabFromHref(issue.secondary!.href)}
                          className="inline-flex items-center gap-2 bg-white border border-amber-200 text-amber-800 px-3 py-1.5 rounded-lg text-[11px] font-bold hover:bg-amber-100 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                        >
                          {issue.secondary.label}
                        </button>
                      ) : (
                        <a
                          href={issue.secondary.href}
                          className="inline-flex items-center gap-2 bg-white border border-amber-200 text-amber-800 px-3 py-1.5 rounded-lg text-[11px] font-bold hover:bg-amber-100 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                        >
                          {issue.secondary.label}
                        </a>
                      )
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="inline-flex items-center gap-2 text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-3 py-2 rounded-lg">
              <span className="material-symbols-outlined text-[16px]">check_circle</span>
              OK: nessun problema critico rilevato
            </div>
          )}

          {technicalDetails.hasData && (
            <details className="mt-3 text-xs text-slate-600">
              <summary className="cursor-pointer font-semibold text-slate-700">Dettagli tecnici</summary>
              <div className="mt-2 ui-panel-subtle p-3 space-y-1">
                <div>Issues rebalance: <span className="font-semibold">{technicalDetails.rebalanceCount}</span></div>
                <div>Issues prezzi: <span className="font-semibold">{technicalDetails.priceIssueTotal}</span></div>
                <div>Issues FX: <span className="font-semibold">{technicalDetails.fxIssueTotal}</span></div>
                <div>Missing price days: <span className="font-semibold">{technicalDetails.missingPriceDays}</span></div>
                <div>Backfill sintetici: <span className="font-semibold">{technicalDetails.backfillTotal}</span></div>
              </div>
            </details>
          )}
        </div>

        <div className="flex gap-2 mt-4">
          {(['prices', 'fx', 'checks'] as TabKey[]).map(key => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={clsx(
                'px-3 py-1.5 rounded-lg text-xs font-bold transition-all border',
                tab === key
                  ? 'bg-[#0052a3] text-white border-[#0052a3]'
                  : 'bg-white text-slate-500 border-borderSoft hover:bg-slate-50'
              )}
            >
              {key === 'prices' ? 'Prezzi' : key === 'fx' ? 'FX' : 'Check'}
            </button>
          ))}
        </div>
      </div>

      {tab === 'prices' && (
        <div className="ui-panel p-6 space-y-4">
          <div className="flex flex-wrap gap-4 items-end">
            <div className="flex-1 min-w-[220px]">
              <label className="block text-xs font-bold text-slate-400 uppercase mb-1">Ticker</label>
              <select
                value={selectedTicker}
                onChange={e => setSelectedTicker(e.target.value)}
                className="w-full border border-borderSoft bg-white p-2 rounded-lg text-sm text-slate-700"
                style={{ color: '#0f172a' }}
              >
                <option value="" className="text-slate-700" style={{ color: '#334155' }}>Seleziona ticker</option>
                {tickerOptions.map(opt => (
                  <option key={opt.value} value={opt.value} className="text-slate-900" style={{ color: '#0f172a' }}>
                    {opt.label}
                  </option>
                ))}
              </select>
              {selectedInstrument && (
                <div className="mt-1 text-[11px] text-slate-500">
                  Listing attivo: <span className="font-semibold text-slate-700">{selectedCanonicalTicker || 'N/D'}</span>
                  {!isSelectedPreferred && selectedCanonicalTicker && (
                    <span className="text-amber-600"> (selezione alternativa, non usata nei calcoli)</span>
                  )}
                </div>
              )}
              <label className="mt-2 inline-flex items-center gap-2 text-[11px] text-slate-500">
                <input
                  type="checkbox"
                  checked={showUnusedTickers}
                  onChange={e => setShowUnusedTickers(e.target.checked)}
                />
                Mostra anche non usati (debug)
              </label>
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-400 uppercase mb-1">Da</label>
              <input
                type="date"
                value={priceRange.from}
                onChange={e => setPriceRange(prev => ({ ...prev, from: e.target.value }))}
                className="border border-borderSoft bg-slate-50 p-2 rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-400 uppercase mb-1">A</label>
              <input
                type="date"
                value={priceRange.to}
                onChange={e => setPriceRange(prev => ({ ...prev, to: e.target.value }))}
                className="border border-borderSoft bg-slate-50 p-2 rounded-lg text-sm"
              />
            </div>
            <button
              type="button"
              onClick={handlePriceExport}
              className="px-3 py-2 rounded-lg text-xs font-bold bg-slate-900 text-white"
              disabled={!selectedTicker}
            >
              Export CSV
            </button>
            <button
              type="button"
              onClick={() => importInputRef.current?.click()}
              className="px-3 py-2 rounded-lg text-xs font-bold bg-slate-100 text-slate-700 border border-borderSoft"
            >
              Import
            </button>
            <button
              type="button"
              onClick={async () => {
                if (!selectedTicker) return;
                const first = window.confirm(`Vuoi eliminare tutti i prezzi per ${selectedTicker}?`);
                if (!first) return;
                const second = window.confirm('Conferma definitiva: questa operazione e irreversibile.');
                if (!second) return;
                await db.prices
                  .where('portfolioId')
                  .equals(currentPortfolioId)
                  .and(p => p.ticker === selectedTicker)
                  .delete();
                setImportPreview([]);
                setImportErrors([]);
              }}
              className={clsx(
                'px-3 py-2 rounded-lg text-xs font-bold border',
                selectedTicker && hasPriceData
                  ? 'bg-red-50 text-red-700 border-red-200'
                  : 'bg-slate-100 text-slate-400 border-borderSoft cursor-not-allowed'
              )}
              disabled={!selectedTicker || !hasPriceData}
            >
              Reset prezzi
            </button>
            <input ref={importInputRef} type="file" accept=".csv,.json" className="hidden" onChange={handlePriceImport} />
          </div>

          {selectedTicker && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs text-slate-700">
                <div className="ui-panel-subtle p-3 text-slate-800">
                  <div className="text-[10px] uppercase font-bold text-slate-600">Start</div>
                  <div className="font-semibold">{priceAnalysis.stats.startDate || 'N/D'}</div>
                </div>
                <div className="ui-panel-subtle p-3 text-slate-800">
                  <div className="text-[10px] uppercase font-bold text-slate-600">End</div>
                  <div className="font-semibold">{priceAnalysis.stats.endDate || 'N/D'}</div>
                </div>
                <div className="ui-panel-subtle p-3 text-slate-800">
                  <div className="text-[10px] uppercase font-bold text-slate-600">Count</div>
                  <div className="font-semibold">{priceAnalysis.stats.count}</div>
                </div>
                <div className="ui-panel-subtle p-3 text-slate-800">
                  <div className="text-[10px] uppercase font-bold text-slate-600">Currency</div>
                  <select
                    value={String(priceAnalysis.stats.currency || '')}
                    onChange={handlePriceCurrencyChange}
                    className="mt-1 w-full border border-borderSoft bg-white px-2 py-1.5 rounded text-xs font-semibold text-slate-700"
                    disabled={!selectedTicker || hasPriceData}
                  >
                    <option value="" disabled>Seleziona</option>
                    {Object.values(Currency).map(cur => (
                      <option key={cur} value={cur}>{cur}</option>
                    ))}
                  </select>
                  {hasPriceData && (
                    <div className="mt-1 text-[11px] text-amber-600">
                      Currency bloccata: per cambiarla reimporta lo storico corretto.
                    </div>
                  )}
                </div>
              </div>

              <div className="h-56 border border-borderSoft rounded-xl bg-slate-50">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={priceChartSeries}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                    <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} />
                    <Tooltip />
                    <Line type="monotone" dataKey="close" stroke="#0052a3" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="ui-panel-dense p-3 text-slate-800">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-xs font-bold text-slate-500 uppercase">Warnings</div>
                    <label className="inline-flex items-center gap-2 text-[11px] text-slate-500">
                      <input
                        type="checkbox"
                        checked={showPreTransactions}
                        onChange={e => setShowPreTransactions(e.target.checked)}
                      />
                      Mostra anche pre-transazioni
                    </label>
                  </div>
                  {!showPreTransactions && warningsFromDate && (
                    <div className="text-[11px] text-slate-500 mb-2">
                      Warning da: <span className="font-semibold text-slate-700">{warningsFromDate}</span>
                    </div>
                  )}
                  {visiblePriceIssues.length === 0 ? (
                    <div className="text-xs text-slate-500">Nessun problema rilevato.</div>
                  ) : (
                    <ul className="text-xs text-slate-600 space-y-1 max-h-48 overflow-auto">
                      {visiblePriceIssues.slice(0, 30).map((issue, idx) => (
                        <li key={`${issue.type}-${idx}`} className="flex items-center gap-2">
                          <span className={clsx(
                            'px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider',
                            issue.severity === 'error' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
                          )}>
                            {issue.severity === 'error' ? 'ERROR' : 'WARN'}
                          </span>
                          <span>{issue.message}{issue.date ? ` (${issue.date})` : ''}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="ui-panel-dense p-3 overflow-auto max-h-56 text-slate-800">
                  <div className="text-xs font-bold text-slate-500 uppercase mb-2">Prezzi</div>
                  <table className="w-full text-xs text-slate-800">
                    <thead className="text-[10px] uppercase text-slate-600 sticky top-0 bg-slate-50">
                      <tr>
                        <th className="text-left py-1">Date</th>
                        <th className="text-right py-1">Close</th>
                      </tr>
                    </thead>
                    <tbody>
                      {priceChartData.slice(-40).map((row, idx) => (
                        <tr key={`${row.date}-${idx}`}>
                          <td className="py-1">{row.date}</td>
                          <td className="py-1 text-right font-mono text-slate-800">{row.close}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {importPreview.length > 0 && (
                <div className="ui-panel-subtle border-amber-200 bg-amber-50 p-3 text-xs">
                  <div className="font-bold text-amber-800">Preview import</div>
                  <div className="text-amber-700">Righe valide: {importPreview.length}</div>
                  {importErrors.length > 0 && (
                    <div className="text-amber-700 mt-1">Errori: {importErrors.slice(0, 5).join('; ')}</div>
                  )}
                  <button
                    onClick={confirmPriceImport}
                    className="mt-2 px-3 py-1 rounded bg-amber-600 text-white text-xs font-bold"
                  >
                    Conferma import
                  </button>
                </div>
              )}
            </>
          )}

          <div className="border-t border-borderSoft pt-4">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-xs font-bold text-slate-500 uppercase">Pulizia listing</div>
                <div className="text-xs text-slate-500">Nascondi listing non canonici senza transazioni.</div>
              </div>
              <button
                type="button"
                onClick={() => persistHiddenTickers([])}
                className="px-3 py-2 rounded-lg text-xs font-bold bg-slate-100 text-slate-700 border border-borderSoft"
                disabled={hiddenTickers.length === 0}
              >
                Ripristina nascosti
              </button>
            </div>
            {cleanupCandidates.length === 0 ? (
              <div className="text-xs text-slate-500 mt-2">Nessun listing da nascondere.</div>
            ) : (
              <div className="mt-3 space-y-2">
                {cleanupCandidates.map(candidate => (
                  <div key={candidate.ticker} className="flex items-center justify-between text-xs bg-slate-50 border border-borderSoft rounded-lg px-3 py-2">
                    <div>
                      <div className="font-semibold text-slate-700">{candidate.ticker}</div>
                      <div className="text-slate-500">{candidate.reason}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          if (hiddenTickers.includes(candidate.ticker)) return;
                          if (cleanupMeta?.canonicalSet.has(candidate.ticker)) return;
                          persistHiddenTickers([...hiddenTickers, candidate.ticker]);
                        }}
                        className="px-2 py-1 rounded text-[11px] font-bold bg-amber-100 text-amber-700"
                      >
                        Nascondi
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          if (!cleanupMeta) return;
                          const isCanonical = cleanupMeta.canonicalSet.has(candidate.ticker);
                          const hasTx = cleanupMeta.txSet.has(candidate.ticker);
                          const priceCount = cleanupMeta.priceCount.get(candidate.ticker);
                          const hasPriceCount = cleanupMeta.priceCount.has(candidate.ticker);
                          if (!hasPriceCount || isCanonical || hasTx || (priceCount ?? 0) > 0) return;
                          const ok = window.confirm(`Eliminare definitivamente il listing ${candidate.ticker}? Questa azione e irreversibile.`);
                          if (!ok) return;
                          await db.prices
                            .where('portfolioId')
                            .equals(currentPortfolioId)
                            .and(p => p.ticker === candidate.ticker)
                            .delete();
                          persistHiddenTickers(hiddenTickers.filter(t => t !== candidate.ticker));
                          if (selectedTicker === candidate.ticker) setSelectedTicker('');
                        }}
                        className={clsx(
                          'px-2 py-1 rounded text-[11px] font-bold border',
                            cleanupMeta
                              && cleanupMeta.priceCount.has(candidate.ticker)
                              && !cleanupMeta.canonicalSet.has(candidate.ticker)
                              && !cleanupMeta.txSet.has(candidate.ticker)
                              && (cleanupMeta.priceCount.get(candidate.ticker) || 0) === 0
                              ? 'bg-red-50 text-red-700 border-red-200'
                              : 'bg-slate-100 text-slate-400 border-borderSoft cursor-not-allowed'
                          )}
                          disabled={
                            !cleanupMeta
                            || !cleanupMeta.priceCount.has(candidate.ticker)
                            || cleanupMeta.canonicalSet.has(candidate.ticker)
                            || cleanupMeta.txSet.has(candidate.ticker)
                            || (cleanupMeta.priceCount.get(candidate.ticker) || 0) > 0
                          }
                      >
                        Elimina
                      </button>
                    </div>
                  </div>
                ))}
                {!showUnusedTickers && cleanupCandidates.length >= 15 && (
                  <div className="text-xs text-slate-500">Mostrati i primi 15. Attiva debug per vedere tutti i ticker.</div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'fx' && (
        <div className="ui-panel p-6 space-y-4">
          <div className="flex flex-wrap gap-4 items-end">
            <div className="flex-1 min-w-[220px]">
              <label className="block text-xs font-bold text-slate-400 uppercase mb-1">Coppia FX</label>
              <select
                value={selectedFxPair}
                onChange={e => setSelectedFxPair(e.target.value)}
                className="w-full border border-borderSoft bg-white p-2 rounded-lg text-sm text-slate-700"
                style={{ color: '#0f172a' }}
              >
                <option value="" className="text-slate-700" style={{ color: '#334155' }}>Seleziona coppia</option>
                {fxPairs.map(p => <option key={p} value={p} className="text-slate-900" style={{ color: '#0f172a' }}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-400 uppercase mb-1">Da</label>
              <input
                type="date"
                value={fxRange.from}
                onChange={e => setFxRange(prev => ({ ...prev, from: e.target.value }))}
                className="border border-borderSoft bg-slate-50 p-2 rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-400 uppercase mb-1">A</label>
              <input
                type="date"
                value={fxRange.to}
                onChange={e => setFxRange(prev => ({ ...prev, to: e.target.value }))}
                className="border border-borderSoft bg-slate-50 p-2 rounded-lg text-sm"
              />
            </div>
            <button
              type="button"
              onClick={handleFxExport}
              className="px-3 py-2 rounded-lg text-xs font-bold bg-slate-900 text-white"
              disabled={!selectedFxPair}
            >
              Export CSV
            </button>
            <button
              type="button"
              onClick={() => fxImportInputRef.current?.click()}
              className="px-3 py-2 rounded-lg text-xs font-bold bg-slate-100 text-slate-700 border border-borderSoft"
            >
              Import
            </button>
            <input ref={fxImportInputRef} type="file" accept=".csv,.json" className="hidden" onChange={handleFxImport} />
          </div>

          {selectedFxPair && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs text-slate-600">
                <div className="ui-panel-subtle p-3">
                  <div className="text-[10px] uppercase font-bold text-slate-400">Start</div>
                  <div className="font-semibold">{fxAnalysis.stats.startDate || 'N/D'}</div>
                </div>
                <div className="ui-panel-subtle p-3">
                  <div className="text-[10px] uppercase font-bold text-slate-400">End</div>
                  <div className="font-semibold">{fxAnalysis.stats.endDate || 'N/D'}</div>
                </div>
                <div className="ui-panel-subtle p-3">
                  <div className="text-[10px] uppercase font-bold text-slate-400">Count</div>
                  <div className="font-semibold">{fxAnalysis.stats.count}</div>
                </div>
                <div className="ui-panel-subtle p-3">
                  <div className="text-[10px] uppercase font-bold text-slate-400">Currency</div>
                  <div className="font-semibold">{String(fxAnalysis.stats.currency || 'N/D')}</div>
                </div>
              </div>

              <div className="h-56 border border-borderSoft rounded-xl bg-slate-50">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={fxChartSeries}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                    <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} />
                    <Tooltip />
                    <Line type="monotone" dataKey="close" stroke="#0f766e" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <div className="ui-panel-dense rounded-xl overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 border-b border-borderSoft bg-slate-50 text-xs text-slate-600">
                  <span className="font-bold uppercase text-slate-500">Righe FX</span>
                  <div className="flex items-center gap-3">
                    <span>
                      {fxTableRows.length > fxTableMaxRows
                        ? `Mostrati ${showAllFxRows ? 'tutti' : `ultimi ${fxTableMaxRows}`} / ${fxTableRows.length}`
                        : `Totale: ${fxTableRows.length}`}
                    </span>
                    {fxTableRows.length > fxTableMaxRows && (
                      <button
                        type="button"
                        onClick={() => setShowAllFxRows(prev => !prev)}
                        className="text-[11px] font-bold text-[#0052a3] hover:text-blue-600"
                      >
                        {showAllFxRows ? 'Limita a 200' : 'Mostra tutte'}
                      </button>
                    )}
                  </div>
                </div>
                <div className="max-h-64 overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-white border-b border-borderSoft text-slate-500">
                      <tr>
                        <th className="text-left px-3 py-2 font-semibold">Data</th>
                        <th className="text-right px-3 py-2 font-semibold">Rate</th>
                        <th className="text-left px-3 py-2 font-semibold">Base</th>
                        <th className="text-left px-3 py-2 font-semibold">Quote</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fxTableVisible.map((row, idx) => (
                        <tr key={`${row.date}-${idx}`} className="border-b border-borderSoft last:border-0">
                          <td className="px-3 py-2 text-slate-700">{row.date}</td>
                          <td className="px-3 py-2 text-right text-slate-700">{Number.isFinite(row.rate) ? row.rate : 'N/D'}</td>
                          <td className="px-3 py-2 text-slate-500">{row.baseCurrency}</td>
                          <td className="px-3 py-2 text-slate-500">{row.quoteCurrency}</td>
                        </tr>
                      ))}
                      {fxTableVisible.length === 0 && (
                        <tr>
                          <td className="px-3 py-3 text-slate-500" colSpan={4}>Nessuna riga FX disponibile.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="ui-panel-dense p-3">
                <div className="text-xs font-bold text-slate-500 uppercase mb-2">Warnings</div>
                {fxAnalysis.issues.length === 0 ? (
                  <div className="text-xs text-slate-500">Nessun problema rilevato.</div>
                ) : (
                  <div className="text-xs text-slate-600 space-y-2 max-h-56 overflow-auto">
                    {fxGapDetails.length > 0 && (
                      <div className="ui-panel-subtle p-2">
                        <div className="font-semibold text-slate-700 mb-1">Gap rilevati</div>
                        <ul className="space-y-1">
                          {fxGapDetails.slice(0, 5).map((gap, idx) => (
                            <li key={`${gap.from}-${idx}`}>
                              Gap di {gap.days} giorni: {gap.from} → {gap.to}
                            </li>
                          ))}
                        </ul>
                        {fxGapDetails.length > 5 && (
                          <div className="text-[11px] text-slate-500 mt-1">Mostrati i 5 gap più grandi.</div>
                        )}
                      </div>
                    )}
                    <ul className="space-y-1">
                      {fxAnalysis.issues.slice(0, 30).map((issue, idx) => (
                        <li key={`${issue.type}-${idx}`}>{issue.message}{issue.date ? ` (${issue.date})` : ''}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {fxImportPreview.length > 0 && (
                <div className="ui-panel-subtle border-amber-200 bg-amber-50 p-3 text-xs">
                  <div className="font-bold text-amber-800">Preview import</div>
                  <div className="text-amber-700">Righe valide: {fxImportPreview.length}</div>
                  {fxImportErrors.length > 0 && (
                    <div className="text-amber-700 mt-1">Errori: {fxImportErrors.slice(0, 5).join('; ')}</div>
                  )}
                  <button
                    onClick={confirmFxImport}
                    className="mt-2 px-3 py-1 rounded bg-amber-600 text-white text-xs font-bold"
                  >
                    Conferma import
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'checks' && (
        <div className="ui-panel p-6 space-y-4">
          <div className="text-sm text-slate-600">Report sintetico su dati prezzi/FX e impatto sul NAV.</div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-slate-100 text-slate-600 border border-borderSoft">
              Mostrati: primi 40 ticker
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
              Finestra analisi: ultimi 365 giorni
            </span>
            <details className="text-xs text-slate-500">
              <summary className="cursor-pointer hover:text-slate-700 font-semibold">Perché?</summary>
              <div className="mt-1 text-[11px] text-slate-500 max-w-[520px]">
                Per mantenere la pagina fluida con dataset grandi, i check sono sintetici e focalizzati sull’ultimo anno.
                I dati completi restano disponibili nelle tab Prezzi/FX.
              </div>
            </details>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setCheckRunId(prev => prev + 1)}
              className="px-3 py-2 rounded-lg text-xs font-bold bg-[#0052a3] text-white w-fit"
            >
              Esegui check
            </button>
            <button
              type="button"
              onClick={handleTxExport}
              className="px-3 py-2 rounded-lg text-xs font-bold bg-slate-100 text-slate-700 border border-borderSoft w-fit"
            >
              Esporta transazioni (JSON)
            </button>
            <button
              type="button"
              onClick={async () => {
                if (!window.confirm('Vuoi rimuovere automaticamente i duplicati (prezzi + FX)?')) return;
                await removeDuplicatePrices();
                await removeDuplicateFx();
                setCheckRunId(prev => prev + 1);
              }}
              className="px-3 py-2 rounded-lg text-xs font-bold bg-amber-50 text-amber-800 border border-amber-200 w-fit"
            >
              Rimuovi duplicati
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs text-slate-600">
            <div className="ui-panel-subtle p-3">
              <div className="text-[10px] uppercase font-bold text-slate-400">Tickers</div>
              <div className="font-semibold">{tickers.length}</div>
            </div>
            <div className="ui-panel-subtle p-3">
              <div className="text-[10px] uppercase font-bold text-slate-400">FX Pairs</div>
              <div className="font-semibold">{fxPairs.length}</div>
            </div>
            <div className="ui-panel-subtle p-3">
              <div className="text-[10px] uppercase font-bold text-slate-400">Missing Price Days</div>
              <div className="font-semibold">{navChecks?.missingPriceDays ?? 0}</div>
            </div>
          </div>

          {navSummary && (
            <div className="ui-panel-dense p-3 text-xs text-slate-600">
              <div className="font-bold text-slate-500 uppercase mb-2">NAV summary</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                <div>Start: <span className="font-semibold">{navSummary.startDate}</span></div>
                <div>End: <span className="font-semibold">{navSummary.endDate}</span></div>
                <div>NAV start: <span className="font-semibold">{navSummary.navStart.toFixed(2)}</span></div>
                <div>NAV end: <span className="font-semibold">{navSummary.navEnd.toFixed(2)}</span></div>
                <div>Net flows: <span className="font-semibold">{navSummary.netExternalFlows.toFixed(2)}</span></div>
                <div>PNL: <span className="font-semibold">{navSummary.pnl.toFixed(2)}</span></div>
                <div>Return: <span className="font-semibold">{navSummary.totalReturnPct.toFixed(2)}%</span></div>
              </div>
            </div>
          )}

          {navChecks?.examples?.length ? (
            <div className="ui-panel-dense p-3 text-xs text-slate-600">
              <div className="font-bold text-slate-500 uppercase mb-2">Esempi missing price</div>
              <ul className="space-y-1">
                {navChecks.examples.map((row, idx) => (
                  <li key={`${row.date}-${idx}`}>
                    {row.date} - {row.missingPriceTickers.join(', ')}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="text-xs text-slate-500">Nessun missing price tickers rilevato.</div>
          )}

          {navChecks && navChecks.backfillTotal > 0 ? (
            <div className="ui-panel-subtle border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              <div className="font-bold text-amber-800 uppercase mb-2">Backfill prezzi</div>
              <div className="text-amber-800">
                Weekend/festivi (normali): <span className="font-semibold">{navChecks.weekendTotal}</span>
              </div>
              <div className="text-amber-800">
                Giorni borsa chiusa (inferiti): <span className="font-semibold">{navChecks.closedTotal}</span>
              </div>
              <div className="text-amber-800">
                Buchi REALI su giorni di trading: <span className="font-semibold">{navChecks.realMissingTotal}</span>
              </div>
              <div className="text-amber-700 mt-1">
                Significato: mancano prezzi in alcuni giorni nel periodo NAV. Se ti serve continuita/backtest, usa Settings -&gt; "Scarica storico prezzi".
              </div>
              <div className="text-amber-700 mt-1">
                Nota: per ETF/azioni e normale non avere prezzi nei weekend; l'app usa l'ultimo close disponibile per continuita NAV.
              </div>
              {navChecks.backfillRows.length > 0 && (
                <div className="mt-2 space-y-1">
                  {navChecks.backfillRows.slice(0, 8).map(row => (
                    <div key={`backfill-${row.ticker}`} className="flex items-center justify-between">
                      <span className="font-semibold">{row.ticker}</span>
                      <span>
                        Buchi reali{row.isCrypto ? ' (crypto)' : ''}: {row.realMissingDays}
                        {row.realMissingDays > 0 && row.range ? ` (${row.range.start} -> ${row.range.end}${row.range.gapDays ? ", " + row.range.gapDays + "g" : ""})` : ""}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {navChecks.backfillWarnings.length > 0 && (
                <div className="mt-2 text-amber-800">
                  <div className="font-semibold">Gap lunghi rilevati</div>
                  <ul className="space-y-1">
                    {navChecks.backfillWarnings.slice(0, 5).map((warning, idx) => (
                      <li key={`gap-${warning.ticker}-${idx}`}>
                        {warning.ticker}: {warning.startDate} -&gt; {warning.endDate} ({warning.gapDays}g)
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <div className="text-xs text-slate-500">Nessun backfill prezzi rilevato.</div>
          )}

          {rebalanceQuality && (
            <div className="ui-panel-dense p-3 text-xs text-slate-600">
              <div className="font-bold text-slate-500 uppercase mb-2">Rebalance FX/Price checks</div>
              <div className="mb-2">Snapshot (comune): <span className="font-semibold">{rebalanceQuality.valuationDate}</span></div>
              {rebalanceQuality.summary.issues.length === 0 ? (
                <div className="text-xs text-slate-500">Nessun problema rilevato.</div>
              ) : (
                <ul className="space-y-1 max-h-48 overflow-auto">
                  {rebalanceQuality.summary.issues.slice(0, 30).map((issue, idx) => (
                    <li key={`${issue.ticker}-${issue.type}-${idx}`}>
                      {issue.ticker}: {issue.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="ui-panel-dense p-3 text-xs text-slate-800">
              <div className="font-bold text-slate-500 uppercase mb-2">Price checks</div>
              <div className="max-h-64 overflow-auto">
                <table className="w-full text-slate-800">
                  <thead className="text-[10px] uppercase text-slate-600 sticky top-0 bg-slate-50">
                    <tr>
                      <th className="text-left py-1">Ticker</th>
                      <th className="text-right py-1">Issues</th>
                      <th className="text-right py-1">Gaps</th>
                      <th className="text-right py-1">Outliers</th>
                      <th className="text-right py-1">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {priceChecksSummary.slice(0, 20).map(row => {
                      const status = getStatusBadge(row.issueCount, row.stats);
                      return (
                        <tr key={row.ticker}>
                          <td className="py-1">{row.ticker}</td>
                          <td className="py-1 text-right">{row.issueCount}</td>
                          <td className="py-1 text-right">{row.stats.gaps}</td>
                          <td className="py-1 text-right">{row.stats.outliers}</td>
                          <td className="py-1 text-right">
                            <span
                              className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${status.className}`}
                              title={status.title}
                            >
                              {status.label}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="ui-panel-dense p-3 text-xs text-slate-800">
              <div className="font-bold text-slate-500 uppercase mb-2">FX checks</div>
              <div className="max-h-64 overflow-auto">
                <table className="w-full text-slate-800">
                  <thead className="text-[10px] uppercase text-slate-600 sticky top-0 bg-slate-50">
                    <tr>
                      <th className="text-left py-1">Pair</th>
                      <th className="text-right py-1">Issues</th>
                      <th className="text-right py-1">Gaps</th>
                      <th className="text-right py-1">Outliers</th>
                      <th className="text-right py-1">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fxChecksSummary.slice(0, 20).map(row => {
                      const status = getStatusBadge(row.issueCount, row.stats);
                      return (
                        <tr key={row.pair}>
                          <td className="py-1">{row.pair}</td>
                          <td className="py-1 text-right">{row.issueCount}</td>
                          <td className="py-1 text-right">{row.stats.gaps}</td>
                          <td className="py-1 text-right">{row.stats.outliers}</td>
                          <td className="py-1 text-right">
                            <span
                              className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${status.className}`}
                              title={status.title}
                            >
                              {status.label}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};


