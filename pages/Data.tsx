import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useLocation } from 'react-router-dom';
import { db, getCurrentPortfolioId } from '../db';
import { Currency, Instrument, PricePoint } from '../types';
import { analyzeFxSeries, analyzePriceSeries, FxRatePoint, analyzeRebalanceQuality } from '../services/dataQuality';
import { buildNavSeriesDetailed, calculateHoldings, getCanonicalTicker, getValuationDateForHoldings } from '../services/financeUtils';
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
  const [importPreview, setImportPreview] = useState<PricePoint[]>([]);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [fxImportPreview, setFxImportPreview] = useState<FxRatePoint[]>([]);
  const [fxImportErrors, setFxImportErrors] = useState<string[]>([]);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const fxImportInputRef = useRef<HTMLInputElement | null>(null);

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
  const transactions = useLiveQuery(
    () => db.transactions.where('portfolioId').equals(currentPortfolioId).toArray(),
    [currentPortfolioId],
    []
  );
  const fxRates = useLiveQuery(() => db.fxRates.toArray(), [], []);

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
    const set = new Set((prices || []).map(p => p.ticker).filter(Boolean));
    return Array.from(set.values()).sort();
  }, [prices]);

  const usedTickers = useMemo(() => {
    const used = new Set<string>();
    (prices || []).forEach(p => {
      if (p.ticker) used.add(p.ticker);
    });
    (transactions || []).forEach(t => {
      if (t.instrumentTicker) used.add(t.instrumentTicker);
    });
    (instruments || []).forEach(instr => {
      const canonical = getCanonicalTicker(instr);
      if (canonical) used.add(canonical);
    });
    return used;
  }, [prices, transactions, instruments]);

  const tickerOptions = useMemo(() => {
    const options = new Map<string, { value: string; label: string; isPreferred: boolean; isAlternative: boolean; instrument?: Instrument }>();
    const instrumentsList = instruments || [];
    const priceTickers = new Set((prices || []).map(p => p.ticker).filter(Boolean));
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
  }, [prices, instruments, transactions, hiddenTickers, showUnusedTickers, usedTickers]);

  const selectedInstrument = useMemo(() => {
    if (!selectedTicker || !instruments) return undefined;
    return resolveInstrumentForTicker(instruments, selectedTicker);
  }, [selectedTicker, instruments]);

  const selectedCanonicalTicker = selectedInstrument ? getCanonicalTicker(selectedInstrument) : '';
  const isSelectedPreferred = !!selectedTicker && !!selectedCanonicalTicker && selectedTicker === selectedCanonicalTicker;
  const hasPriceData = useMemo(() => {
    if (!selectedTicker || !prices) return false;
    return prices.some(p => p.ticker === selectedTicker);
  }, [prices, selectedTicker]);

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
    if (!prices || !instruments || !transactions) return [];
    const canonicalSet = new Set(instruments.map(instr => getCanonicalTicker(instr)));
    const txSet = new Set(transactions.map(t => t.instrumentTicker).filter(Boolean) as string[]);
    const priceSet = new Set(prices.map(p => p.ticker).filter(Boolean));
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
  }, [prices, instruments, transactions, hiddenTickersSet, showUnusedTickers]);

  const cleanupMeta = useMemo(() => {
    if (!prices || !transactions || !instruments) return null;
    const canonicalSet = new Set(instruments.map(instr => getCanonicalTicker(instr)));
    const txSet = new Set(transactions.map(t => t.instrumentTicker).filter(Boolean) as string[]);
    const priceCount = new Map<string, number>();
    prices.forEach(p => {
      if (!p.ticker) return;
      priceCount.set(p.ticker, (priceCount.get(p.ticker) || 0) + 1);
    });
    return { canonicalSet, txSet, priceCount };
  }, [prices, transactions, instruments]);

  const fxPairs = useMemo(() => {
    const set = new Set((fxRates || []).map(r => `${r.baseCurrency}/${r.quoteCurrency}`));
    return Array.from(set.values()).sort();
  }, [fxRates]);

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

  const filteredPrices = useMemo(() => {
    const rows = (prices || []).filter(p => p.ticker === selectedTicker);
    if (!priceRange.from && !priceRange.to) return rows;
    return rows.filter(p => {
      if (priceRange.from && p.date < priceRange.from) return false;
      if (priceRange.to && p.date > priceRange.to) return false;
      return true;
    });
  }, [prices, selectedTicker, priceRange]);

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
    if (!selectedFxPair) return [];
    const [base, quote] = selectedFxPair.split('/');
    const rows = (fxRates || []).filter(r => r.baseCurrency === base && r.quoteCurrency === quote);
    if (!fxRange.from && !fxRange.to) return rows;
    return rows.filter(r => {
      if (fxRange.from && r.date < fxRange.from) return false;
      if (fxRange.to && r.date > fxRange.to) return false;
      return true;
    });
  }, [fxRates, selectedFxPair, fxRange]);

  const fxAnalysis = useMemo(() => analyzeFxSeries(fxFiltered), [fxFiltered]);

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
    if (!prices || prices.length === 0) return;
    const byKey = new Map<string, PricePoint[]>();
    prices.forEach(row => {
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
    if (!fxRates || fxRates.length === 0) return;
    const byKey = new Map<string, { id?: number }[]>();
    fxRates.forEach(row => {
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
    if (!transactions || !instruments || !prices) return null;
    const detailed = buildNavSeriesDetailed(transactions, instruments, prices, 'daily');
    const missingPriceDays = detailed.filter(p => p.missingPriceTickers.length > 0);
    return {
      missingPriceDays: missingPriceDays.length,
      examples: missingPriceDays.slice(0, 5)
    };
  }, [transactions, instruments, prices, checkRunId]);

  const rebalanceQuality = useMemo(() => {
    if (checkRunId === 0) return null;
    if (!transactions || !instruments || !prices || !fxRates) return null;
    const valuationDate = getValuationDateForHoldings(transactions, prices, instruments);
    if (!valuationDate) return null;
    const holdings = calculateHoldings(transactions);
    return {
      valuationDate,
      summary: analyzeRebalanceQuality(holdings, instruments, prices, fxRates, valuationDate, Currency.CHF)
    };
  }, [transactions, instruments, prices, fxRates, checkRunId]);

  const navSummary = useMemo(() => {
    if (checkRunId === 0) return null;
    if (!transactions || !instruments || !prices) return null;
    const detailed = buildNavSeriesDetailed(transactions, instruments, prices, 'daily');
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
  }, [transactions, instruments, prices, checkRunId]);

  const priceChecksSummary = useMemo(() => {
    if (!prices || tickers.length === 0) return [];
    return tickers.map(ticker => {
      const rows = prices.filter(p => p.ticker === ticker);
      const instr = resolveInstrumentForTicker(instruments || [], ticker);
      const { stats, issues } = analyzePriceSeries(rows, {
        assetClass: instr?.assetClass,
        assetType: instr?.type
      });
      return { ticker, stats, issueCount: issues.length };
    });
  }, [prices, tickers, instruments]);

  const fxChecksSummary = useMemo(() => {
    if (!fxRates || fxPairs.length === 0) return [];
    return fxPairs.map(pair => {
      const [base, quote] = pair.split('/');
      const rows = (fxRates as FxRatePoint[]).filter(r => r.baseCurrency === base && r.quoteCurrency === quote);
      const { stats, issues } = analyzeFxSeries(rows);
      return { pair, stats, issueCount: issues.length };
    });
  }, [fxRates, fxPairs]);

  return (
    <div className="space-y-6 pb-20 animate-fade-in text-textPrimary">
      <div className="bg-white p-6 rounded-2xl border border-borderSoft shadow-lg">
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
        <div className="bg-white p-6 rounded-2xl border border-borderSoft shadow-lg space-y-4">
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
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs text-slate-600">
                <div className="bg-slate-50 border border-borderSoft rounded-lg p-3">
                  <div className="text-[10px] uppercase font-bold text-slate-400">Start</div>
                  <div className="font-semibold">{priceAnalysis.stats.startDate || 'N/D'}</div>
                </div>
                <div className="bg-slate-50 border border-borderSoft rounded-lg p-3">
                  <div className="text-[10px] uppercase font-bold text-slate-400">End</div>
                  <div className="font-semibold">{priceAnalysis.stats.endDate || 'N/D'}</div>
                </div>
                <div className="bg-slate-50 border border-borderSoft rounded-lg p-3">
                  <div className="text-[10px] uppercase font-bold text-slate-400">Count</div>
                  <div className="font-semibold">{priceAnalysis.stats.count}</div>
                </div>
                <div className="bg-slate-50 border border-borderSoft rounded-lg p-3">
                  <div className="text-[10px] uppercase font-bold text-slate-400">Currency</div>
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
                  <LineChart data={priceChartData}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                    <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} />
                    <Tooltip />
                    <Line type="monotone" dataKey="close" stroke="#0052a3" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="bg-slate-50 border border-borderSoft rounded-xl p-3">
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
                <div className="bg-slate-50 border border-borderSoft rounded-xl p-3 overflow-auto max-h-56">
                  <div className="text-xs font-bold text-slate-500 uppercase mb-2">Prezzi</div>
                  <table className="w-full text-xs">
                    <thead className="text-slate-400 uppercase">
                      <tr>
                        <th className="text-left py-1">Date</th>
                        <th className="text-right py-1">Close</th>
                      </tr>
                    </thead>
                    <tbody>
                      {priceChartData.slice(-40).map((row, idx) => (
                        <tr key={`${row.date}-${idx}`}>
                          <td className="py-1">{row.date}</td>
                          <td className="py-1 text-right">{row.close}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {importPreview.length > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs">
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
                          const priceCount = cleanupMeta.priceCount.get(candidate.ticker) || 0;
                          if (isCanonical || hasTx || priceCount > 0) return;
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
                            && !cleanupMeta.canonicalSet.has(candidate.ticker)
                            && !cleanupMeta.txSet.has(candidate.ticker)
                            && (cleanupMeta.priceCount.get(candidate.ticker) || 0) === 0
                            ? 'bg-red-50 text-red-700 border-red-200'
                            : 'bg-slate-100 text-slate-400 border-borderSoft cursor-not-allowed'
                        )}
                        disabled={
                          !cleanupMeta
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
        <div className="bg-white p-6 rounded-2xl border border-borderSoft shadow-lg space-y-4">
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
                <div className="bg-slate-50 border border-borderSoft rounded-lg p-3">
                  <div className="text-[10px] uppercase font-bold text-slate-400">Start</div>
                  <div className="font-semibold">{fxAnalysis.stats.startDate || 'N/D'}</div>
                </div>
                <div className="bg-slate-50 border border-borderSoft rounded-lg p-3">
                  <div className="text-[10px] uppercase font-bold text-slate-400">End</div>
                  <div className="font-semibold">{fxAnalysis.stats.endDate || 'N/D'}</div>
                </div>
                <div className="bg-slate-50 border border-borderSoft rounded-lg p-3">
                  <div className="text-[10px] uppercase font-bold text-slate-400">Count</div>
                  <div className="font-semibold">{fxAnalysis.stats.count}</div>
                </div>
                <div className="bg-slate-50 border border-borderSoft rounded-lg p-3">
                  <div className="text-[10px] uppercase font-bold text-slate-400">Currency</div>
                  <div className="font-semibold">{String(fxAnalysis.stats.currency || 'N/D')}</div>
                </div>
              </div>

              <div className="h-56 border border-borderSoft rounded-xl bg-slate-50">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={fxChartData}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                    <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} />
                    <Tooltip />
                    <Line type="monotone" dataKey="close" stroke="#0f766e" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <div className="bg-slate-50 border border-borderSoft rounded-xl p-3">
                <div className="text-xs font-bold text-slate-500 uppercase mb-2">Warnings</div>
                {fxAnalysis.issues.length === 0 ? (
                  <div className="text-xs text-slate-500">Nessun problema rilevato.</div>
                ) : (
                  <ul className="text-xs text-slate-600 space-y-1 max-h-48 overflow-auto">
                    {fxAnalysis.issues.slice(0, 30).map((issue, idx) => (
                      <li key={`${issue.type}-${idx}`}>{issue.message}{issue.date ? ` (${issue.date})` : ''}</li>
                    ))}
                  </ul>
                )}
              </div>

              {fxImportPreview.length > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs">
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
        <div className="bg-white p-6 rounded-2xl border border-borderSoft shadow-lg space-y-4">
          <div className="text-sm text-slate-600">Report sintetico su dati prezzi/FX e impatto sul NAV.</div>
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
            <div className="bg-slate-50 border border-borderSoft rounded-lg p-3">
              <div className="text-[10px] uppercase font-bold text-slate-400">Tickers</div>
              <div className="font-semibold">{tickers.length}</div>
            </div>
            <div className="bg-slate-50 border border-borderSoft rounded-lg p-3">
              <div className="text-[10px] uppercase font-bold text-slate-400">FX Pairs</div>
              <div className="font-semibold">{fxPairs.length}</div>
            </div>
            <div className="bg-slate-50 border border-borderSoft rounded-lg p-3">
              <div className="text-[10px] uppercase font-bold text-slate-400">Missing Price Days</div>
              <div className="font-semibold">{navChecks?.missingPriceDays ?? 0}</div>
            </div>
          </div>

          {navSummary && (
            <div className="bg-slate-50 border border-borderSoft rounded-xl p-3 text-xs text-slate-600">
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
            <div className="bg-slate-50 border border-borderSoft rounded-xl p-3 text-xs text-slate-600">
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

          {rebalanceQuality && (
            <div className="bg-slate-50 border border-borderSoft rounded-xl p-3 text-xs text-slate-600">
              <div className="font-bold text-slate-500 uppercase mb-2">Rebalance FX/Price checks</div>
              <div className="mb-2">Valuation date: <span className="font-semibold">{rebalanceQuality.valuationDate}</span></div>
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
            <div className="bg-slate-50 border border-borderSoft rounded-xl p-3 text-xs">
              <div className="font-bold text-slate-500 uppercase mb-2">Price checks</div>
              <table className="w-full">
                <thead className="text-[10px] uppercase text-slate-400">
                  <tr>
                    <th className="text-left py-1">Ticker</th>
                    <th className="text-right py-1">Issues</th>
                    <th className="text-right py-1">Gaps</th>
                    <th className="text-right py-1">Outliers</th>
                  </tr>
                </thead>
                <tbody>
                  {priceChecksSummary.slice(0, 20).map(row => (
                    <tr key={row.ticker}>
                      <td className="py-1">{row.ticker}</td>
                      <td className="py-1 text-right">{row.issueCount}</td>
                      <td className="py-1 text-right">{row.stats.gaps}</td>
                      <td className="py-1 text-right">{row.stats.outliers}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="bg-slate-50 border border-borderSoft rounded-xl p-3 text-xs">
              <div className="font-bold text-slate-500 uppercase mb-2">FX checks</div>
              <table className="w-full">
                <thead className="text-[10px] uppercase text-slate-400">
                  <tr>
                    <th className="text-left py-1">Pair</th>
                    <th className="text-right py-1">Issues</th>
                    <th className="text-right py-1">Gaps</th>
                    <th className="text-right py-1">Outliers</th>
                  </tr>
                </thead>
                <tbody>
                  {fxChecksSummary.slice(0, 20).map(row => (
                    <tr key={row.pair}>
                      <td className="py-1">{row.pair}</td>
                      <td className="py-1 text-right">{row.issueCount}</td>
                      <td className="py-1 text-right">{row.stats.gaps}</td>
                      <td className="py-1 text-right">{row.stats.outliers}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
