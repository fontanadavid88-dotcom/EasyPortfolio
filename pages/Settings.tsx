import React, { useEffect, useMemo, useRef, useState } from 'react';
import { db, getCurrentPortfolioId, setCurrentPortfolioId } from '../db';
import { syncPrices, getTickersForBackfill, getPriceCoverage, backfillPricesForPortfolio, CoverageRow, SyncPricesSummary, resolvePriceSyncConfig, testSheetLatestPrice, SheetTestResult, getResolvedSymbol, getEodhdQuotaInfo, EodhdQuotaInfo, getEodhdDailyBudgetStatus } from '../services/priceService';
import { AutoGapScope, getAutoGapFillEnabled, setAutoGapFillEnabled, getAutoGapFillScope, setAutoGapFillScope, getAutoSyncMeta, setAutoSyncMeta } from '../services/autoSyncService';
import { fetchJsonWithDiagnostics, toNum, FetchJsonDiagnostics } from '../services/diagnostics';
import { resolveListingsByIsin } from '../services/eodhdSearchService';
import { pickDefaultListing, pickRecommendedListings } from '../services/listingService';
import { importFxCsv, FxRateRow } from '../services/fxService';
import { fetchAppsScriptPing, fetchAssetsMap, fetchMacro, applyAssetsMapToSettings, applyMacroRowsToDexie, syncFxRates, AppsScriptFxRow } from '../services/appsScriptService';
import { isIsin, normalizeTicker, resolveEodhdSymbol, hasExchangeSuffix } from '../services/symbolUtils';
import { AppSettings, Currency, InstrumentListing, Instrument, PriceProviderType, PriceTickerConfig, RegionKey, AssetType, Transaction } from '../types';
import { createUuid } from '../services/idUtils';
import { InfoPopover } from '../components/InfoPopover';
import { useLiveQuery } from 'dexie-react-hooks';
import { format, subDays } from 'date-fns';
import { useLocation } from 'react-router-dom';
import { resetSymbolMigrationFlag, runSymbolMigrationOnce } from '../services/symbolMigration';
import clsx from 'clsx';

type InstrumentListingRow = {
  id?: number;
  isin: string;
  exchangeCode: string;
  symbol: string;
  currency: Currency;
  name?: string;
  portfolioId?: string;
};

type FxRateRowWithId = FxRateRow & { id?: number };

export const Settings: React.FC = () => {
  const [config, setConfig] = useState<AppSettings>({
    eodhdApiKey: '',
    googleSheetUrl: '',
    appsScriptUrl: '',
    appsScriptApiKey: '',
    baseCurrency: Currency.CHF,
    minHistoryDate: '2020-01-01',
    priceBackfillScope: 'current',
    preferredExchangesOrder: ['SW', 'US', 'LSE', 'XETRA', 'MI', 'PA'],
    priceTickerConfig: {}
  });
  const location = useLocation();
  const [isConfigModalOpen, setConfigModalOpen] = useState(false);
  const [coverageExpanded, setCoverageExpanded] = useState(false);
  const [coverage, setCoverage] = useState<{
    earliestCoveredDate?: string;
    latestCoveredDate?: string;
    perTicker: CoverageRow[];
    okCount: number;
    total: number;
  }>({ perTicker: [], okCount: 0, total: 0 });
  const [bfLoading, setBfLoading] = useState(false);
  const [bfStatus, setBfStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [syncSummary, setSyncSummary] = useState<SyncPricesSummary | null>(null);
  const [saveNotice, setSaveNotice] = useState('');
  const [eodhdTests, setEodhdTests] = useState<Record<string, { status: string; symbol?: string; message?: string; httpStatus?: number; sample?: string; contentType?: string; rawPreview?: string; parseError?: string; url?: string }>>({});
  const [eodhdSymbolErrors, setEodhdSymbolErrors] = useState<Record<string, string>>({});
  const [isTestingAll, setIsTestingAll] = useState(false);
  const [testAllProgress, setTestAllProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [sheetTests, setSheetTests] = useState<Record<string, SheetTestResult & { symbol?: string }>>({});
  const [eodhdTesting, setEodhdTesting] = useState<Record<string, boolean>>({});
  const [sheetTesting, setSheetTesting] = useState<Record<string, boolean>>({});
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const listingsSectionRef = useRef<HTMLDivElement | null>(null);
  const listingSelectRef = useRef<HTMLSelectElement | null>(null);
  const focusHandledRef = useRef<string | null>(null);
  const [settingsId, setSettingsId] = useState<number | undefined>(undefined);
  const currentPortfolioId = getCurrentPortfolioId();
  const [portfolios, setPortfolios] = useState<{ id?: number; portfolioId: string; name: string }[]>([]);
  const [newPortfolioName, setNewPortfolioName] = useState('');
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [selectedInstrumentId, setSelectedInstrumentId] = useState<string | undefined>(undefined);
  const [isinInput, setIsinInput] = useState('');
  const [recommendedListings, setRecommendedListings] = useState<InstrumentListing[]>([]);
  const [otherListings, setOtherListings] = useState<InstrumentListing[]>([]);
  const [selectedListing, setSelectedListing] = useState<InstrumentListing | null>(null);
  const [listingMessage, setListingMessage] = useState('');
  const priceCsvRef = useRef<HTMLInputElement | null>(null);
  const importPriceButtonRef = useRef<HTMLButtonElement | null>(null);
  const fxCsvRef = useRef<HTMLInputElement | null>(null);
  const importFxButtonRef = useRef<HTMLButtonElement | null>(null);
  const [fxBase, setFxBase] = useState<Currency>(Currency.CHF);
  const [fxQuote, setFxQuote] = useState<Currency>(Currency.USD);
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const [regionAllocation, setRegionAllocation] = useState<Partial<Record<RegionKey, number>>>({});
  const [proxyHealth, setProxyHealth] = useState<{ ok: boolean; hasEodhdKey: boolean; error?: string } | null>(null);
  const [proxyHealthLoading, setProxyHealthLoading] = useState(false);
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [quotaInfo, setQuotaInfo] = useState<EodhdQuotaInfo | null>(null);
  const [quotaError, setQuotaError] = useState('');
  const [quotaDiag, setQuotaDiag] = useState<FetchJsonDiagnostics | null>(null);
  const [quotaUpdatedAt, setQuotaUpdatedAt] = useState<string>('');
  const [appsScriptLoading, setAppsScriptLoading] = useState<{ ping?: boolean; assets?: boolean; macro?: boolean; fx?: boolean }>({});
  const [appsScriptTests, setAppsScriptTests] = useState<Record<string, { status: 'ok' | 'err' | 'disabled'; message?: string; count?: number; sample?: string; diag?: FetchJsonDiagnostics }>>({});
  const [fxSyncNotice, setFxSyncNotice] = useState<{ status: 'ok' | 'warn' | 'err'; message: string } | null>(null);
  const [autoGapEnabled, setAutoGapEnabled] = useState<boolean>(() => getAutoGapFillEnabled(currentPortfolioId));
  const [autoGapScope, setAutoGapScopeState] = useState<AutoGapScope>(() => getAutoGapFillScope());
  const [autoGapRunning, setAutoGapRunning] = useState(false);
  const [autoGapStatus, setAutoGapStatus] = useState('');
  const [autoSyncMeta, setAutoSyncMetaState] = useState(() => getAutoSyncMeta(currentPortfolioId));
  const [budgetStatus, setBudgetStatus] = useState(() => getEodhdDailyBudgetStatus());
  const instrumentListings = useLiveQuery(
    () => db.instrumentListings.where('portfolioId').equals(currentPortfolioId).toArray(),
    [currentPortfolioId],
    []
  ) as InstrumentListingRow[];
  const fxRates = useLiveQuery(() => db.fxRates.toArray(), [], []) as FxRateRowWithId[];
  const missingInstrumentTransactions = useLiveQuery(
    () => db.transactions
      .where('portfolioId')
      .equals(currentPortfolioId)
      .filter(tx => !tx.instrumentId)
      .toArray(),
    [currentPortfolioId],
    []
  ) as Transaction[];
  const [txRepairSelection, setTxRepairSelection] = useState<Record<number, string>>({});

  useEffect(() => {
    setAutoGapEnabled(getAutoGapFillEnabled(currentPortfolioId));
    setAutoSyncMetaState(getAutoSyncMeta(currentPortfolioId));
    setBudgetStatus(getEodhdDailyBudgetStatus());
    setAutoGapScopeState(getAutoGapFillScope());
    db.settings.where('portfolioId').equals(currentPortfolioId).first().then(s => {
      if (s) {
        setConfig(prev => ({
          ...prev,
          ...s,
          minHistoryDate: s.minHistoryDate || '2020-01-01',
          priceBackfillScope: (s.priceBackfillScope as any) || 'current',
          preferredExchangesOrder: s.preferredExchangesOrder || prev.preferredExchangesOrder,
          priceTickerConfig: s.priceTickerConfig || prev.priceTickerConfig || {}
        }));
        setSettingsId(s.id);
        if (s.baseCurrency) setFxBase(s.baseCurrency);
      }
    });
    db.portfolios.toArray().then(setPortfolios);
    db.instruments.where('portfolioId').equals(currentPortfolioId).toArray().then(res => {
      setInstruments(res as Instrument[]);
      if (res.length > 0) setSelectedInstrumentId(String(res[0].id));
      if (res.length > 0 && res[0].regionAllocation) setRegionAllocation(res[0].regionAllocation);
    });
  }, [currentPortfolioId]);

  const instrumentByKey = useMemo(() => {
    const map = new Map<string, Instrument>();
    instruments.forEach(inst => {
      if (inst.symbol) map.set(inst.symbol, inst);
      if (inst.ticker) map.set(inst.ticker, inst);
    });
    return map;
  }, [instruments]);
  const getInstrumentByIdString = (id?: string) => {
    if (!id) return undefined;
    return instruments.find(inst => String(inst.id) === id);
  };

  const missingTxRows = useMemo(() => {
    return (missingInstrumentTransactions || []).filter(tx => !tx.instrumentId);
  }, [missingInstrumentTransactions]);
  useEffect(() => {
    const params = new URLSearchParams(location.search || "");
    if (params.get("focus") !== "listing") return;
    const tickerParam = params.get("ticker") || "";
    const isinParam = params.get("isin") || "";
    const focusKey = `${tickerParam}|${isinParam}`;
    if (focusHandledRef.current === focusKey) return;
    if (!instruments || instruments.length === 0) return;
    const instrument = instruments.find(i => {
      if (isinParam && i.isin === isinParam) return true;
      if (!tickerParam) return false;
      return i.symbol === tickerParam
        || i.ticker === tickerParam
        || i.preferredListing?.symbol === tickerParam
        || i.listings?.some(l => l.symbol === tickerParam);
    });
    if (instrument?.id) setSelectedInstrumentId(String(instrument.id));
    const nextIsin = instrument?.isin || (isinParam ? isinParam : "");
    if (nextIsin) setIsinInput(nextIsin);
    listingsSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    requestAnimationFrame(() => listingSelectRef.current?.focus());
    focusHandledRef.current = focusKey;
  }, [location.search, instruments]);

  const loadProxyHealth = async (apiKey?: string) => {
    setProxyHealthLoading(true);
    try {
      const headers = apiKey?.trim() ? { 'x-eodhd-key': apiKey.trim() } : undefined;
      const res = await fetch('/api/health', headers ? { headers } : undefined);
      if (!res.ok) {
        setProxyHealth({ ok: false, hasEodhdKey: false, error: 'Proxy non raggiungibile' });
        return;
      }
      const data = await res.json();
      setProxyHealth({
        ok: Boolean(data?.ok),
        hasEodhdKey: Boolean(data?.hasEodhdKey)
      });
    } catch (e) {
      setProxyHealth({ ok: false, hasEodhdKey: false, error: 'Proxy non raggiungibile' });
    } finally {
      setProxyHealthLoading(false);
    }
  };

  useEffect(() => {
    const key = config.eodhdApiKey?.trim();
    const timeoutId = setTimeout(() => {
      loadProxyHealth(key);
    }, 300);
    return () => clearTimeout(timeoutId);
  }, [config.eodhdApiKey]);

  const handleQuotaCheck = async () => {
    if (quotaLoading) return;
    setQuotaLoading(true);
    setQuotaError('');
    try {
      const result = await getEodhdQuotaInfo(config);
      setQuotaDiag(result.diag);
      if (result.ok) {
        setQuotaInfo(result.info);
        setQuotaError('');
      } else {
        setQuotaInfo(null);
        setQuotaError(result.error);
      }
      setQuotaUpdatedAt(new Date().toISOString());
    } catch (e: any) {
      setQuotaInfo(null);
      setQuotaError(e?.message || 'Errore quota EODHD');
    } finally {
      setQuotaLoading(false);
    }
  };

  const setAppsScriptTestResult = (kind: string, result: { status: 'ok' | 'err' | 'disabled'; message?: string; count?: number; sample?: string; diag?: FetchJsonDiagnostics }) => {
    setAppsScriptTests(prev => ({ ...prev, [kind]: result }));
  };

  const handleAppsScriptPing = async () => {
    setAppsScriptLoading(prev => ({ ...prev, ping: true }));
    try {
      const result = await fetchAppsScriptPing(config);
      if (!result.ok) {
        setAppsScriptTestResult('ping', { status: result.error === 'DISABILITATO' ? 'disabled' : 'err', message: result.error, diag: result.diag.diag });
        return;
      }
      setAppsScriptTestResult('ping', { status: 'ok', message: 'OK', diag: result.diag.diag });
    } finally {
      setAppsScriptLoading(prev => ({ ...prev, ping: false }));
    }
  };

  const handleAppsScriptAssets = async () => {
    setAppsScriptLoading(prev => ({ ...prev, assets: true }));
    try {
      const result = await fetchAssetsMap(config);
      if (!result.ok) {
        setAppsScriptTestResult('assets', { status: result.error === 'DISABILITATO' ? 'disabled' : 'err', message: result.error, diag: result.diag.diag });
        return;
      }
      const sample = result.data.slice(0, 2).map(row => `${row.ticker} -> ${row.sheetSymbol || ''} ${row.currency || ''}`).join(' | ');
      setAppsScriptTestResult('assets', { status: 'ok', count: result.data.length, sample, diag: result.diag.diag });
      const updated = applyAssetsMapToSettings(config, result.data);
      if (updated.changed) {
        await db.settings.put({ ...updated.settings, id: settingsId, portfolioId: currentPortfolioId });
        setConfig(updated.settings);
      }
    } finally {
      setAppsScriptLoading(prev => ({ ...prev, assets: false }));
    }
  };

  const handleAppsScriptMacro = async () => {
    setAppsScriptLoading(prev => ({ ...prev, macro: true }));
    try {
      const result = await fetchMacro(config);
      if (!result.ok) {
        setAppsScriptTestResult('macro', { status: result.error === 'DISABILITATO' ? 'disabled' : 'err', message: result.error, diag: result.diag.diag });
        return;
      }
      const count = await applyMacroRowsToDexie(result.data, currentPortfolioId, db);
      const sample = result.data.slice(0, 2).map(row => `${row.id}: ${row.value}`).join(' | ');
      setAppsScriptTestResult('macro', { status: 'ok', count, sample, diag: result.diag.diag });
    } finally {
      setAppsScriptLoading(prev => ({ ...prev, macro: false }));
    }
  };

  const handleAppsScriptFx = async () => {
    setAppsScriptLoading(prev => ({ ...prev, fx: true }));
    try {
      const result = await syncFxRates(config, 'apps_script');
      if (!result.ok) {
        setAppsScriptTestResult('fx', { status: result.error === 'DISABILITATO' ? 'disabled' : 'err', message: result.error, diag: result.diag?.diag });
        return;
      }
      const sample = (result.rows || []).slice(0, 3).map((row: AppsScriptFxRow) => `${row.baseCurrency}/${row.quoteCurrency} ${row.date} ${row.rate}`).join(' | ');
      setAppsScriptTestResult('fx', { status: 'ok', count: result.count, sample, diag: result.diag?.diag });
    } finally {
      setAppsScriptLoading(prev => ({ ...prev, fx: false }));
    }
  };

  const handleSave = async () => {
    await db.settings.put({ ...config, id: settingsId, portfolioId: currentPortfolioId });
    if (config.eodhdApiKey?.trim()) {
      setSaveNotice('Key salvata');
    } else {
      setSaveNotice('Impostazioni salvate');
    }
    setTimeout(() => setSaveNotice(''), 2500);
    alert('Impostazioni salvate');
  };

  const handleSaveConfig = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    await handleSave();
    setConfigModalOpen(false);
  };

  const loadCoverage = async () => {
    const tickers = await getTickersForBackfill(currentPortfolioId, config.priceBackfillScope || 'current');
    const cov = await getPriceCoverage(currentPortfolioId, tickers, config.minHistoryDate || '2020-01-01');
    setCoverage({ ...cov, total: tickers.length });
  };

  useEffect(() => {
    loadCoverage();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.priceBackfillScope, config.minHistoryDate, currentPortfolioId]);

  const getRowConfig = (ticker: string) => resolvePriceSyncConfig(ticker, config);

  const updateTickerConfig = async (ticker: string, patch: Partial<PriceTickerConfig>) => {
    const nextConfig: AppSettings = {
      ...config,
      priceTickerConfig: {
        ...(config.priceTickerConfig || {}),
        [ticker]: {
          ...(config.priceTickerConfig?.[ticker] || {}),
          ...patch
        }
      }
    };
    setConfig(nextConfig);
    await db.settings.put({ ...nextConfig, id: settingsId, portfolioId: currentPortfolioId });
    if (patch.eodhdSymbol !== undefined || patch.provider !== undefined) {
      setEodhdTests(prev => {
        const copy = { ...prev };
        delete copy[ticker];
        return copy;
      });
    }
    if (patch.sheetSymbol !== undefined || patch.provider !== undefined) {
      setSheetTests(prev => {
        const copy = { ...prev };
        delete copy[ticker];
        return copy;
      });
    }
  };

    const handleTestEodhd = async (ticker: string) => {
      const cfg = getRowConfig(ticker);
      const instrument = resolveInstrumentForTicker(ticker);
      const symbol = getResolvedSymbol(ticker, config, 'EODHD', instrument?.type);
      if (!symbol) {
        setEodhdTests(prev => ({ ...prev, [ticker]: { status: 'MAP', symbol: cfg.eodhdSymbol, message: 'Symbol non valido' } }));
        return;
      }
      const from = format(subDays(new Date(), 10), 'yyyy-MM-dd');
      const to = format(new Date(), 'yyyy-MM-dd');
      const params = new URLSearchParams({ path: '/api/eod/' + symbol, from, to, fmt: 'json' });
      const headers = config.eodhdApiKey?.trim() ? { 'x-eodhd-key': config.eodhdApiKey.trim() } : undefined;
      const url = `/api/eodhd-proxy?${params.toString()}`;
      setEodhdTesting(prev => ({ ...prev, [ticker]: true }));
      try {
        const diag = await fetchJsonWithDiagnostics(url, headers ? { headers } : undefined);
        let status = 'ERR';
        let message = '';
        let sample = '';
        const rawPreview = diag.rawPreview;
        const parseError = diag.parseError;
        const contentType = diag.contentType;
        const httpStatus = diag.httpStatus;
        const rawTrim = diag.rawPreview.trimStart();

        if (diag.ok) {
          if (rawTrim.startsWith('<')) {
            status = 'ERR';
            message = 'HTML response';
          } else if (Array.isArray(diag.json)) {
            if (diag.json.length === 0) {
              status = 'NO_DATA';
              message = 'Nessun dato nel range';
            } else {
              const first = diag.json[0] as Record<string, unknown>;
              const keys = Object.keys(first || {});
              const closeType = typeof (first as Record<string, unknown>)?.close;
              const adjType = typeof (first as Record<string, unknown>)?.adjusted_close;
              const validRow = diag.json.find((row) => {
                const obj = row as Record<string, unknown>;
                const rowDate = String(obj?.date || '');
                const closeRaw = obj?.adjusted_close ?? obj?.close;
                const close = toNum(closeRaw);
                return rowDate && close !== null;
              });
              if (validRow) {
                status = 'OK';
                const preview = diag.json.slice(0, 2).map((row) => {
                  const obj = row as Record<string, unknown>;
                  const rowDate = String(obj?.date || '');
                  const closeRaw = obj?.adjusted_close ?? obj?.close;
                  const close = toNum(closeRaw);
                  return rowDate && close !== null ? `${rowDate}: ${close}` : null;
                }).filter(Boolean) as string[];
                sample = preview.join(' | ');
                message = `count=${diag.json.length}`;
              } else {
                status = 'ERR';
                message = `Validazione fallita: array=true length=${diag.json.length} keys=${keys.join(',')} closeType=${closeType} adjustedType=${adjType}`;
              }
            }
          } else if (diag.json && typeof diag.json === 'object') {
            const obj = diag.json as Record<string, unknown>;
            const candidate = obj.message || obj.error || obj.errors || obj.code || obj.status;
            message = typeof candidate === 'string' ? candidate : 'Payload oggetto (no array)';
            status = 'ERR';
          } else {
            status = 'ERR';
            message = `Validazione fallita: array=${Array.isArray(diag.json)} length=0`;
          }
        } else if (httpStatus === 400) {
          const text = typeof diag.json === 'object' && diag.json && 'error' in (diag.json as Record<string, unknown>)
            ? String((diag.json as Record<string, unknown>).error)
            : rawPreview;
          status = text.includes('Missing EODHD key') ? 'KEY' : 'ERR';
          message = text;
        } else if (httpStatus === 404) {
          status = '404';
        } else if (httpStatus === 429) {
          status = 'RATE';
        } else {
          status = 'ERR';
        }
        setEodhdTests(prev => ({
          ...prev,
          [ticker]: { status, symbol, message, httpStatus, sample, contentType, rawPreview, parseError, url }
        }));
      } catch (e: any) {
        setEodhdTests(prev => ({ ...prev, [ticker]: { status: 'ERR', symbol, message: e?.message || String(e) } }));
      } finally {
        setEodhdTesting(prev => ({ ...prev, [ticker]: false }));
      }
    };

  const handleTestEodhdAll = async () => {
    if (isTestingAll) return;
    const tickers = coverage.perTicker.map(row => row.ticker).filter(Boolean);
    setIsTestingAll(true);
    setTestAllProgress({ done: 0, total: tickers.length });
    try {
      let done = 0;
      for (const ticker of tickers) {
        try {
          await handleTestEodhd(ticker);
        } catch (e: any) {
          setEodhdTests(prev => ({ ...prev, [ticker]: { status: 'ERR', symbol: getRowConfig(ticker).eodhdSymbol, message: e?.message || String(e) } }));
        } finally {
          done += 1;
          setTestAllProgress({ done, total: tickers.length });
        }
        await sleep(150);
      }
    } finally {
      setIsTestingAll(false);
    }
  };
  const handleSetEodhdSymbol = async (ticker: string, symbol: string) => {
    await updateTickerConfig(ticker, { eodhdSymbol: symbol, provider: 'EODHD', needsMapping: false });
  };

  const handleTestSheet = async (ticker: string) => {
    const cfg = getRowConfig(ticker);
    const symbol = cfg.sheetSymbol;
    setSheetTesting(prev => ({ ...prev, [ticker]: true }));
    try {
      const result = await testSheetLatestPrice(config.googleSheetUrl, symbol);
      setSheetTests(prev => ({ ...prev, [ticker]: { ...result, symbol } }));
    } catch (e: any) {
      setSheetTests(prev => ({ ...prev, [ticker]: { status: 'error', reason: e?.message || String(e), symbol } }));
    } finally {
      setSheetTesting(prev => ({ ...prev, [ticker]: false }));
    }
  };

  const handleUseSheetLatest = async (ticker: string, symbol: string) => {
    await updateTickerConfig(ticker, { provider: 'SHEETS', sheetSymbol: symbol });
  };

    const handleResetTickerPrices = async (ticker: string) => {
      const first = window.confirm(`Vuoi eliminare tutti i prezzi per ${ticker}?`);
      if (!first) return;
      const second = window.confirm('Conferma definitiva: questa operazione e irreversibile.');
      if (!second) return;
      await db.prices
        .where('portfolioId')
        .equals(currentPortfolioId)
        .and(p => p.ticker === ticker)
        .delete();
      await loadCoverage();
    };

    const handleRerunSymbolMigration = async () => {
      const first = window.confirm('Vuoi rieseguire la migrazione symbol?');
      if (!first) return;
      resetSymbolMigrationFlag();
      await runSymbolMigrationOnce();
      await loadCoverage();
    };

  const handleSync = async () => {
    setLoading(true);
    setSyncSummary(null);
    setFxSyncNotice(null);
    try {
      const result = await syncPrices(config.eodhdApiKey);
      setSyncSummary(result);
      let fxNotice: { status: 'ok' | 'warn' | 'err'; message: string } | null = null;
      const appsScriptEnabled = Boolean(config.appsScriptUrl?.trim() && config.appsScriptApiKey?.trim());
      if (!appsScriptEnabled) {
        fxNotice = { status: 'warn', message: 'FX non aggiornato: Apps Script disabilitato.' };
      } else {
        try {
          const fxResult = await syncFxRates(config, 'apps_script');
          if (!fxResult.ok) {
            fxNotice = { status: fxResult.error === 'DISABILITATO' ? 'warn' : 'err', message: `FX non aggiornato: ${fxResult.error}.` };
          } else {
            fxNotice = { status: 'ok', message: `FX aggiornati: ${fxResult.count ?? 0} righe.` };
          }
        } catch (e: any) {
          fxNotice = { status: 'err', message: `FX non aggiornato: ${e?.message || 'errore Apps Script'}.` };
        }
      }
      setFxSyncNotice(fxNotice);
      const fxSuffix = fxNotice && fxNotice.status !== 'ok' ? `\n${fxNotice.message}` : '';
      if (result.status === 'ok') {
        alert(`Prezzi aggiornati con successo!${fxSuffix}`);
      } else if (result.status === 'partial') {
        alert(`Aggiornamento parziale: alcuni ticker non sono stati aggiornati.${fxSuffix}`);
      } else if (result.status === 'quota_exhausted') {
        alert(`Quota EODHD esaurita (402). Sync interrotta per evitare chiamate inutili.${fxSuffix}`);
      } else {
        alert(`Aggiornamento fallito: nessun ticker aggiornato.${fxSuffix}`);
      }
    } catch (e: any) {
      alert(e?.message || 'Errore aggiornamento prezzi.');
    } finally {
      setLoading(false);
    }
  };

  const handleBackfill = async () => {
    setBfLoading(true);
    setBfStatus('Avvio backfill...');
    try {
      const tickers = await getTickersForBackfill(currentPortfolioId, config.priceBackfillScope || 'current');
      const minDate = config.minHistoryDate || '2020-01-01';
      const result = await backfillPricesForPortfolio(
        currentPortfolioId,
        tickers,
        minDate,
        (p) => {
          if (p.phase === 'done') {
            setBfStatus('Completato');
          } else {
            setBfStatus(`${p.phase === 'backfill' ? 'Backfill' : 'Forward'} ${p.index}/${p.total} ${p.ticker}${p.error ? ' - ' + p.error : ''}`);
          }
        },
        config.eodhdApiKey,
        { mode: 'MANUAL_FULL' }
      );
      await loadCoverage();
      setBudgetStatus(getEodhdDailyBudgetStatus());
      if (result.status === 'quota_exhausted') {
        setBfStatus('Quota EODHD esaurita (402). Backfill interrotto.');
        alert('Quota EODHD esaurita (402). Backfill interrotto.');
      } else if (result.status === 'ok') {
        alert('Storico aggiornato');
      } else {
        alert(result.message || 'Backfill non completato');
      }
    } catch (e: any) {
      alert(e?.message || e);
    } finally {
      setBfLoading(false);
    }
  };

  type AutoSyncMetaState = ReturnType<typeof getAutoSyncMeta>;

  const updateAutoSyncMeta = (patch: Partial<AutoSyncMetaState>) => {
    const next = { ...getAutoSyncMeta(currentPortfolioId), ...patch };
    setAutoSyncMetaState(next);
    setAutoSyncMeta(currentPortfolioId, next);
  };

  const handleToggleAutoGap = (enabled: boolean) => {
    setAutoGapEnabled(enabled);
    setAutoGapFillEnabled(currentPortfolioId, enabled);
  };

  const handleAutoGapScopeChange = (scope: AutoGapScope) => {
    setAutoGapScopeState(scope);
    setAutoGapFillScope(scope);
  };

  const handleAutoGapNow = async () => {
    if (autoGapRunning) return;
    setAutoGapRunning(true);
    setAutoGapStatus('Avvio gap-fill...');
    try {
      const tickers = await getTickersForBackfill(currentPortfolioId, config.priceBackfillScope || 'current');
      const minDate = config.minHistoryDate || '2020-01-01';
      const result = await backfillPricesForPortfolio(
        currentPortfolioId,
        tickers,
        minDate,
        (p) => {
          if (p.phase === 'done') {
            setAutoGapStatus('Completato');
          } else {
            setAutoGapStatus(`${p.phase === 'backfill' ? 'Gap-fill' : 'Forward'} ${p.index}/${p.total} ${p.ticker}${p.error ? ' - ' + p.error : ''}`);
          }
        },
        config.eodhdApiKey,
        { mode: 'AUTO_GAPS', maxApiCallsPerRun: 10, maxLookbackDays: 30, staleThresholdDays: 7, sleepMs: 400 }
      );
      await loadCoverage();
      setBudgetStatus(getEodhdDailyBudgetStatus());
      updateAutoSyncMeta({
        lastRun: new Date().toISOString(),
        gapsUpdated: result.updatedTickers?.length || 0,
        gapsSkipped: result.skipped || 0,
        stoppedByBudget: result.stoppedByBudget,
        gapError: result.message
      });
      if (result.status === 'quota_exhausted') {
        setAutoGapStatus('Quota EODHD esaurita (402). Gap-fill interrotto.');
      } else if (result.status === 'error') {
        setAutoGapStatus(result.message || 'Gap-fill non completato');
      }
    } catch (e: any) {
      setAutoGapStatus(e?.message || 'Errore gap-fill');
    } finally {
      setAutoGapRunning(false);
    }
  };

  const handleReset = async () => {
    if (confirm('ATTENZIONE: Stai per cancellare tutti i dati (Transazioni, Strumenti, Prezzi). L\'azione ï¿½ irreversibile. Vuoi procedere?')) {
      await (db as any).delete();
      window.location.reload();
    }
  };

  const handleExport = async () => {
    const payload = {
      portfolios: await db.portfolios.toArray(),
      settings: await db.settings.toArray(),
      instruments: await db.instruments.toArray(),
      transactions: await db.transactions.toArray(),
      prices: await db.prices.toArray(),
      macro: await db.macro.toArray()
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `easyportfolio-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      if (!json || typeof json !== 'object') throw new Error('Formato JSON non valido');

      if (!confirm('Importare il backup sovrascriverï¿½ i dati attuali. Procedere?')) return;

      const rawInstruments = Array.isArray(json.instruments) ? json.instruments : [];
      const importedInstruments: Instrument[] = rawInstruments.map((inst: any) => {
        const symbol = String(inst.symbol || inst.ticker || '').trim();
        const ticker = String(inst.ticker || symbol || '').trim();
        return {
          ...inst,
          id: typeof inst.id === 'string' && inst.id ? inst.id : createUuid(),
          symbol,
          ticker
        } as Instrument;
      });
      const instrumentByKey = new Map<string, Instrument>();
      importedInstruments.forEach(inst => {
        if (inst.symbol) instrumentByKey.set(inst.symbol, inst);
        if (inst.ticker) instrumentByKey.set(inst.ticker, inst);
      });

      const txs = (json.transactions || []).map((t: any) => {
        const instrumentId = t.instrumentId ? String(t.instrumentId)
          : (t.instrumentTicker ? instrumentByKey.get(t.instrumentTicker)?.id : undefined);
        const instrument = instrumentId
          ? importedInstruments.find(inst => inst.id === instrumentId)
          : undefined;
        const instrumentTicker = instrument?.symbol || instrument?.ticker || t.instrumentTicker;
        return {
          ...t,
          date: t.date ? new Date(t.date) : new Date(),
          instrumentId,
          instrumentTicker
        };
      });
      const importedPrices = (json.prices || []).map((p: any) => {
        const instrumentId = p.instrumentId ? String(p.instrumentId)
          : (p.ticker ? instrumentByKey.get(p.ticker)?.id : undefined);
        return { ...p, instrumentId };
      });

      await db.transaction('rw', [db.portfolios, db.settings, db.instruments, db.transactions, db.prices, db.macro], async () => {
        await db.portfolios.clear();
        await db.settings.clear();
        await db.instruments.clear();
        await db.transactions.clear();
        await db.prices.clear();
        await db.macro.clear();

        if (json.portfolios) await db.portfolios.bulkAdd(json.portfolios);
        if (json.settings) await db.settings.bulkAdd(json.settings);
        if (importedInstruments.length) await db.instruments.bulkAdd(importedInstruments);
        if (txs) await db.transactions.bulkAdd(txs);
        if (importedPrices.length) await db.prices.bulkAdd(importedPrices);
        if (json.macro) await db.macro.bulkAdd(json.macro);
      });

      alert('Import completato. Ricarico la pagina.');
      window.location.reload();
    } catch (err: any) {
      console.error('Import error', err);
      alert(`Errore import: ${err.message || err}`);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleCreatePortfolio = async () => {
    const name = newPortfolioName.trim();
    if (!name) return;
    const id = `pf-${Date.now()}`;
    await db.portfolios.add({ portfolioId: id, name });
    await db.settings.add({
      baseCurrency: Currency.CHF,
      eodhdApiKey: '',
      googleSheetUrl: '',
      appsScriptUrl: '',
      appsScriptApiKey: '',
      minHistoryDate: '2020-01-01',
      priceBackfillScope: 'current',
      preferredExchangesOrder: config.preferredExchangesOrder,
      priceTickerConfig: {},
      portfolioId: id
    });
    setCurrentPortfolioId(id);
    setNewPortfolioName('');
    setPortfolios(await db.portfolios.toArray());
    window.location.reload();
  };

  const handleSwitchPortfolio = (id: string) => {
    setCurrentPortfolioId(id);
    window.location.reload();
  };

  const handleResolveIsin = async () => {
    setListingMessage('');
    if (!isinInput.trim()) {
      setListingMessage('Inserisci un ISIN');
      return;
    }
    try {
      const listings = await resolveListingsByIsin(isinInput.trim(), config.eodhdApiKey);
      if (listings.length === 0) {
        setListingMessage('Nessun listing trovato per questo ISIN');
        setRecommendedListings([]);
        setOtherListings([]);
        setSelectedListing(null);
        return;
      }
      const { recommended, others } = pickRecommendedListings(
        listings,
        isinInput.trim(),
        config.preferredExchangesOrder || ['SW', 'US', 'LSE', 'XETRA', 'MI', 'PA'],
        config.baseCurrency || Currency.CHF
      );
      const def = pickDefaultListing(
        listings,
        config.preferredExchangesOrder || ['SW', 'US', 'LSE', 'XETRA', 'MI', 'PA'],
        config.baseCurrency || Currency.CHF
      );
      setRecommendedListings(recommended);
      setOtherListings(others);
      setSelectedListing(def || recommended[0] || listings[0]);
      setListingMessage(`Trovati ${listings.length} listing`);
    } catch (e: any) {
      setListingMessage(e?.message || 'Errore lookup listing');
      setRecommendedListings([]);
      setOtherListings([]);
      setSelectedListing(null);
    }
  };

  const getRepairSelection = (tx: Transaction) => {
    if (!tx.id) return '';
    if (txRepairSelection[tx.id]) return txRepairSelection[tx.id];
    if (tx.instrumentTicker) {
      return instrumentByKey.get(tx.instrumentTicker)?.id || '';
    }
    return '';
  };

  const handleRepairTransaction = async (tx: Transaction) => {
    if (!tx.id) return;
    const selectedId = getRepairSelection(tx);
    if (!selectedId) return;
    const instrument = instruments.find(inst => String(inst.id) === selectedId);
    await db.transactions.update(tx.id, {
      instrumentId: selectedId,
      instrumentTicker: instrument?.symbol || instrument?.ticker || tx.instrumentTicker
    });
    setTxRepairSelection(prev => {
      const next = { ...prev };
      delete next[tx.id!];
      return next;
    });
  };

  const handleApplyListing = async () => {
    if (!selectedInstrumentId) {
      setListingMessage('Seleziona uno strumento');
      return;
    }
    if (!selectedListing) {
      setListingMessage('Seleziona un listing');
      return;
    }
    const instrument = getInstrumentByIdString(selectedInstrumentId);
    if (!instrument) {
      setListingMessage('Strumento non trovato');
      return;
    }
    const mergedListings = Array.from(
      new Map(
        ([...(instrument.listings || []), selectedListing] as InstrumentListing[]).map(l => [l.symbol, l])
      ).values()
    );
    await db.instruments.update(instrument.ticker, {
      isin: isinInput.trim() || instrument.isin,
      preferredListing: selectedListing,
      listings: mergedListings
    });
    await db.instrumentListings.put({
      isin: isinInput.trim() || instrument.isin || '',
      exchangeCode: selectedListing.exchangeCode,
      symbol: selectedListing.symbol,
      currency: selectedListing.currency,
      name: selectedListing.name,
      portfolioId: currentPortfolioId
    });
    setListingMessage('Listing applicato allo strumento');
  };

  const handlePriceCsvImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const lines = text.trim().split(/\r?\n/).filter(Boolean);
      let count = 0;
      for (const line of lines.slice(1)) {
        const [date, closeStr, currencyCol, tickerCol] = line.split(',').map(s => s.trim());
        const close = parseFloat(closeStr);
        if (!date || !isFinite(close)) continue;
        const ticker = tickerCol
          || selectedListing?.symbol
          || instruments.find(i => String(i.id) === selectedInstrumentId)?.symbol
          || instruments.find(i => String(i.id) === selectedInstrumentId)?.ticker;
        const currency = (currencyCol as Currency) || selectedListing?.currency || Currency.USD;
        if (!ticker) continue;
        const instrumentMatch = instruments.find(i => i.symbol === ticker || i.ticker === ticker);
        const instrumentId = selectedInstrumentId
          || (instrumentMatch?.id ? String(instrumentMatch.id) : undefined);
        await db.prices.put({
          ticker,
          instrumentId,
          date,
          close,
          currency,
          portfolioId: currentPortfolioId
        } as any);
        count++;
      }
      alert(`Importate ${count} righe di prezzi`);
    } catch (err: any) {
      alert(err?.message || String(err));
    } finally {
      if (priceCsvRef.current) priceCsvRef.current.value = '';
    }
  };

  const handleFxImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const imported = await importFxCsv(file, fxBase, fxQuote);
      alert(`Importati ${imported} tassi FX`);
    } catch (err: any) {
      alert(err?.message || String(err));
    } finally {
      if (fxCsvRef.current) fxCsvRef.current.value = '';
    }
  };

  useEffect(() => {
    const loadRegion = async () => {
      if (!selectedInstrumentId) {
        setRegionAllocation({});
        return;
      }
      const inst = getInstrumentByIdString(selectedInstrumentId);
      setRegionAllocation(inst?.regionAllocation || {});
    };
    loadRegion();
  }, [selectedInstrumentId]);

  const handleRegionChange = (key: RegionKey, value: number) => {
    setRegionAllocation(prev => ({ ...prev, [key]: Math.max(0, Math.min(100, value)) }));
  };

  const normalizeRegion = () => {
    const entries = Object.entries(regionAllocation || {}) as [RegionKey, number][];
    const sum = entries.reduce((s, [, v]) => s + (v || 0), 0);
    if (sum === 0) return;
    const scale = 100 / sum;
    const normalized: Partial<Record<RegionKey, number>> = {};
    entries.forEach(([k, v]) => {
      normalized[k] = parseFloat(((v || 0) * scale).toFixed(2));
    });
    setRegionAllocation(normalized);
  };

  const handleSaveRegion = async () => {
    if (!selectedInstrumentId) return;
    const sum = Object.values(regionAllocation || {}).reduce((s, v) => s + (v || 0), 0);
    if (sum < 99.5 || sum > 100.5) {
      if (!confirm('La somma delle percentuali non ï¿½ 100%. Procedere lo stesso?')) return;
    }
    const regionTarget = getInstrumentByIdString(selectedInstrumentId);
    if (!regionTarget?.ticker) return;
    await db.instruments.update(regionTarget.ticker, { regionAllocation });
    alert('Distribuzione geografica salvata');
  };

  const activeListing = selectedListing;
  const baseCurrency = config.baseCurrency || Currency.CHF;
  const isSixFirst = !!(activeListing && activeListing.exchangeCode === 'SW' && activeListing.currency === baseCurrency && baseCurrency === Currency.CHF);
  const needsFx = !!(activeListing?.currency && baseCurrency && activeListing.currency !== baseCurrency);

  const handleFxPillClick = () => {
    if (!needsFx) return;
    importFxButtonRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    requestAnimationFrame(() => importFxButtonRef.current?.focus());
  };

  const scrollAndFocus = (ref: React.RefObject<HTMLElement | null>) => {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => ref.current?.focus(), 200);
  };

  const resolveInstrumentForTicker = (ticker: string) => {
    return instruments.find(i => i.preferredListing?.symbol === ticker)
      || instruments.find(i => i.symbol === ticker)
      || instruments.find(i => i.ticker === ticker)
      || instruments.find(i => i.listings?.some(l => l.symbol === ticker));
  };

  const resolveInstrumentForRow = (row: CoverageRow) => {
    if (row.instrumentId != null) {
      return instruments.find(i => String(i.id) === row.instrumentId);
    }
    return resolveInstrumentForTicker(row.ticker)
      || (row.isin ? instruments.find(i => i.isin === row.isin) : undefined);
  };

  const handleOpenListingsFromCoverage = (row: CoverageRow) => {
    const instrument = resolveInstrumentForRow(row);
    if (instrument?.id) {
      setSelectedInstrumentId(String(instrument.id));
    }
    const nextIsin = instrument?.isin || row.isin;
    if (nextIsin) {
      setIsinInput(nextIsin);
    }
    listingsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    requestAnimationFrame(() => listingSelectRef.current?.focus());
  };

  const handleEodhdSymbolChange = (row: CoverageRow, value: string) => {
    const instrument = resolveInstrumentForRow(row);
    const normalized = normalizeTicker(value);
    if (!normalized) {
      setEodhdSymbolErrors(prev => ({ ...prev, [row.ticker]: "" }));
      updateTickerConfig(row.ticker, { eodhdSymbol: "", needsMapping: false });
      return;
    }
    if (isIsin(normalized)) {
      setEodhdSymbolErrors(prev => ({ ...prev, [row.ticker]: "Sembra un ISIN: spostalo nel campo ISIN." }));
      updateTickerConfig(row.ticker, { needsMapping: true });
      return;
    }
    const next = instrument?.type === AssetType.Crypto ? resolveEodhdSymbol(normalized, AssetType.Crypto) : normalized;
    const missingExchange = instrument?.type !== AssetType.Crypto && !hasExchangeSuffix(next);
    setEodhdSymbolErrors(prev => ({ ...prev, [row.ticker]: missingExchange ? "Manca exchange (es. .US, .SW)." : "" }));
    updateTickerConfig(row.ticker, { eodhdSymbol: next, needsMapping: missingExchange ? true : false });
  };

  const getEodhdBadge = (status?: string) => {
    if (!status) return null;
    if (status === 'OK') return { label: 'OK', className: 'bg-green-100 text-green-700' };
    if (status === 'NO_DATA') return { label: 'NO', className: 'bg-amber-100 text-amber-700' };
    if (status === '404') return { label: '404', className: 'bg-red-100 text-red-700' };
    if (status === 'KEY') return { label: 'KEY', className: 'bg-amber-100 text-amber-700' };
    if (status === 'RATE') return { label: 'RATE', className: 'bg-amber-100 text-amber-700' };
    if (status === 'MAP') return { label: 'MAP', className: 'bg-red-100 text-red-700' };
    if (status === 'ERR') return { label: 'ERR', className: 'bg-red-100 text-red-700' };
    return { label: status, className: 'bg-slate-100 text-slate-700' };
  };

  const getSheetBadge = (result?: SheetTestResult) => {
    if (!result) return null;
    if (result.status === 'ok') return { label: 'OK', className: 'bg-green-100 text-green-700' };
    if (result.status === 'not_found') return { label: 'Not found', className: 'bg-amber-100 text-amber-700' };
    if (result.status === 'disabled') return { label: 'URL', className: 'bg-red-100 text-red-700' };
    if (result.status === 'error') return { label: 'ERR', className: 'bg-red-100 text-red-700' };
    return { label: result.status, className: 'bg-slate-100 text-slate-700' };
  };

  const syncStatusLabel = syncSummary
    ? syncSummary.status === 'ok'
      ? 'OK'
      : syncSummary.status === 'partial'
        ? 'Parziale'
        : syncSummary.status === 'quota_exhausted'
          ? 'Quota'
          : 'Errore'
    : '';
  const syncStatusClass = syncSummary
    ? syncSummary.status === 'ok'
      ? 'bg-green-100 text-green-700'
      : syncSummary.status === 'partial'
        ? 'bg-amber-100 text-amber-700'
        : syncSummary.status === 'quota_exhausted'
          ? 'bg-red-100 text-red-700'
          : 'bg-red-100 text-red-700'
    : '';

  const autoSyncLabel = autoSyncMeta?.lastRun
    ? new Date(autoSyncMeta.lastRun).toLocaleString('it-IT')
    : 'N/D';
  const gapFillLabel = autoSyncMeta?.gapsUpdated !== undefined
    ? `${autoSyncMeta.gapsUpdated} upd${autoSyncMeta.gapsSkipped ? ` · skip ${autoSyncMeta.gapsSkipped}` : ''}${autoSyncMeta.stoppedByBudget ? ' · budget' : ''}${autoSyncMeta.gapError ? ' · err' : ''}`
    : 'N/D';

  const excludedTickers = useMemo(() => {
    const set = new Set<string>();
    Object.entries(config.priceTickerConfig || {}).forEach(([ticker, cfg]) => {
      if (cfg?.exclude || cfg?.provider === 'MANUAL' || cfg?.needsMapping) set.add(ticker);
    });
    return set;
  }, [config.priceTickerConfig]);

  const coverageSummary = useMemo(() => {
    const rows = coverage.perTicker.filter(row => !excludedTickers.has(row.ticker));
    const okCount = rows.filter(row => row.status === 'OK').length;
    let earliest: string | undefined;
    let latest: string | undefined;
    rows.forEach(row => {
      if (row.from === 'N/D' || row.to === 'N/D') return;
      earliest = earliest ? (row.from > earliest ? row.from : earliest) : row.from;
      latest = latest ? (row.to < latest ? row.to : latest) : row.to;
    });
    return {
      okCount,
      total: rows.length,
      earliest,
      latest
    };
  }, [coverage.perTicker, excludedTickers]);

  const sourcesStatus = useMemo(() => {
    const sheetsConfigured = Boolean(config.googleSheetUrl?.trim());
    const sheetsHasErrors = sheetsConfigured && Object.values(sheetTests).some(result => result.status === 'error' || result.status === 'disabled');
    const sheetsStatus: 'disabled' | 'ok' | 'err' = !sheetsConfigured ? 'disabled' : sheetsHasErrors ? 'err' : 'ok';
    const eodhdStatus: 'ok' | 'err' = proxyHealth?.ok && proxyHealth?.hasEodhdKey ? 'ok' : 'err';
    const appsScriptEnabled = Boolean(config.appsScriptUrl?.trim() && config.appsScriptApiKey?.trim());
    const appsScriptHasErrors = Object.values(appsScriptTests).some(result => result?.status === 'err');
    const appsScriptStatus: 'disabled' | 'ok' | 'err' = !appsScriptEnabled ? 'disabled' : appsScriptHasErrors ? 'err' : 'ok';
    const globalOk = eodhdStatus === 'ok'
      && (sheetsStatus === 'ok' || sheetsStatus === 'disabled')
      && (appsScriptStatus === 'ok' || appsScriptStatus === 'disabled');
    const globalStatus = globalOk ? 'OK' : 'PARZIALE';
    return { eodhdStatus, sheetsStatus, globalStatus, appsScriptStatus, appsScriptEnabled };
  }, [config.googleSheetUrl, sheetTests, proxyHealth, config.appsScriptUrl, config.appsScriptApiKey, appsScriptTests]);

  const listingUsage = useMemo(() => {
    const usage = new Map<string, { count: number; names: string[] }>();
    instruments.forEach(inst => {
      const symbols = new Set<string>();
      if (inst.ticker) symbols.add(inst.ticker);
      if (inst.preferredListing?.symbol) symbols.add(inst.preferredListing.symbol);
      (inst.listings || []).forEach(l => {
        if (l?.symbol) symbols.add(l.symbol);
      });
      symbols.forEach(symbol => {
        const entry = usage.get(symbol) || { count: 0, names: [] as string[] };
        entry.count += 1;
        entry.names.push(inst.name || inst.ticker || symbol);
        usage.set(symbol, entry);
      });
    });
    return usage;
  }, [instruments]);

  const listingRows = useMemo(() => {
    return [...(instrumentListings || [])].sort((a, b) => {
      if (a.symbol === b.symbol) return a.exchangeCode.localeCompare(b.exchangeCode);
      return a.symbol.localeCompare(b.symbol);
    });
  }, [instrumentListings]);

  const fxPairs = useMemo(() => {
    const map = new Map<string, { base: Currency; quote: Currency; count: number; from?: string; to?: string }>();
    (fxRates || []).forEach(row => {
      const key = `${row.baseCurrency}/${row.quoteCurrency}`;
      const entry = map.get(key) || { base: row.baseCurrency, quote: row.quoteCurrency, count: 0 };
      entry.count += 1;
      entry.from = entry.from ? (row.date < entry.from ? row.date : entry.from) : row.date;
      entry.to = entry.to ? (row.date > entry.to ? row.date : entry.to) : row.date;
      map.set(key, entry);
    });
    const instrumentCurrencies = new Set((instruments || []).map(i => i.currency).filter(Boolean));
    return Array.from(map.values())
      .map(entry => ({
        ...entry,
        key: `${entry.base}/${entry.quote}`,
        referenced: instrumentCurrencies.has(entry.base)
          || instrumentCurrencies.has(entry.quote)
          || config.baseCurrency === entry.base
          || config.baseCurrency === entry.quote
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }, [fxRates, instruments, config.baseCurrency]);

  const handleDeleteListing = async (row: InstrumentListingRow) => {
    const usage = listingUsage.get(row.symbol);
    const hasRefs = Boolean(usage?.count);
    const confirmMessage = hasRefs
      ? `Il listing ${row.symbol} ï¿½ ancora usato da ${usage?.count} strumento/i. Verrï¿½ rimosso dai riferimenti. Continuare?`
      : `Eliminare il listing ${row.symbol}?`;
    if (!confirm(confirmMessage)) return;
    await db.transaction('rw', [db.instrumentListings, db.instruments], async () => {
      if (row.id) await db.instrumentListings.delete(row.id);
      const related = instruments.filter(inst =>
        inst.ticker === row.symbol
        || inst.preferredListing?.symbol === row.symbol
        || inst.listings?.some(l => l.symbol === row.symbol)
      );
      for (const inst of related) {
        const nextListings = (inst.listings || []).filter(l => l.symbol !== row.symbol);
        const nextPreferred = inst.preferredListing?.symbol === row.symbol ? nextListings[0] : inst.preferredListing;
        if (inst.ticker) {
          await db.instruments.update(inst.ticker, {
            listings: nextListings.length > 0 ? nextListings : undefined,
            preferredListing: nextPreferred
          });
        }
      }
    });
    const refreshed = await db.instruments.where('portfolioId').equals(currentPortfolioId).toArray();
    setInstruments(refreshed as Instrument[]);
  };

  const handleDeleteFxPair = async (pair: { base: Currency; quote: Currency; key: string; referenced?: boolean }) => {
    const warn = pair.referenced
      ? 'Questa coppia FX potrebbe essere ancora usata. Vuoi eliminarla comunque?'
      : 'Eliminare tutti i tassi FX per questa coppia?';
    if (!confirm(warn)) return;
    const toDelete = (fxRates || [])
      .filter(row => row.baseCurrency === pair.base && row.quoteCurrency === pair.quote)
      .map(row => row.id)
      .filter((id): id is number => typeof id === 'number');
    if (toDelete.length > 0) {
      await db.fxRates.bulkDelete(toDelete);
    }
  };

  return (
    <div className="space-y-8 max-w-6xl animate-fade-in text-textPrimary">
      {isConfigModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
          <div className="bg-backgroundElevated rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden max-h-[90vh] overflow-y-auto border border-borderSoft">
            <div className="p-6 border-b border-borderSoft flex justify-between items-center sticky top-0 bg-backgroundElevated z-10">
              <h3 className="text-lg font-bold text-textPrimary">Impostazioni base</h3>
              <button onClick={() => setConfigModalOpen(false)} className="text-gray-400 hover:text-slate-900 transition-colors">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <form onSubmit={handleSaveConfig} className="p-6 space-y-5">
              <div>
                <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">EODHD API Key</label>
                <input
                  type="password"
                  className="w-full border border-borderSoft bg-slate-50 p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none transition-all text-slate-900"
                  value={config.eodhdApiKey}
                  onChange={e => setConfig({ ...config, eodhdApiKey: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">Price Sheet URL</label>
                <input
                  className="w-full border border-borderSoft bg-slate-50 p-3 rounded-xl text-sm text-slate-900 focus:ring-2 focus:ring-primary focus:outline-none transition-all"
                  value={config.googleSheetUrl}
                  onChange={e => setConfig({ ...config, googleSheetUrl: e.target.value })}
                />
                <p className="text-xs text-gray-500 mt-1">Endpoint pubblico JSON o Google Viz API.</p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">Valuta base</label>
                  <select
                    className="w-full border border-borderSoft bg-slate-50 p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none transition-all text-slate-900"
                    value={config.baseCurrency}
                    onChange={e => setConfig({ ...config, baseCurrency: e.target.value as Currency })}
                  >
                    {Object.values(Currency).map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">Ordine exchange</label>
                  <input
                    className="w-full border border-borderSoft bg-slate-50 p-3 rounded-xl text-sm text-slate-900 focus:ring-2 focus:ring-primary focus:outline-none transition-all"
                    value={(config.preferredExchangesOrder || ['SW','US','LSE','XETRA','MI','PA']).join(',')}
                    onChange={e => setConfig({ ...config, preferredExchangesOrder: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">Backfill da data</label>
                  <input
                    type="date"
                    className="w-full border border-borderSoft bg-slate-50 p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none transition-all text-slate-900"
                    value={config.minHistoryDate || '2020-01-01'}
                    onChange={e => setConfig({ ...config, minHistoryDate: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">Ambito backfill</label>
                  <div className="flex flex-col gap-2 text-sm text-slate-700">
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="scope"
                        checked={(config.priceBackfillScope || 'current') === 'current'}
                        onChange={() => setConfig({ ...config, priceBackfillScope: 'current' })}
                      />
                      Solo tickers in portafoglio
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="scope"
                        checked={(config.priceBackfillScope || 'current') === 'all'}
                        onChange={() => setConfig({ ...config, priceBackfillScope: 'all' })}
                      />
                      Includi storici venduti
                    </label>
                  </div>
                </div>
              </div>
              <div className="pt-4 flex gap-3">
                <button
                  type="button"
                  onClick={() => setConfigModalOpen(false)}
                  className="flex-1 border border-borderSoft text-slate-700 py-3 rounded-xl font-bold hover:bg-slate-50 transition"
                >
                  Annulla
                </button>
                <button
                  type="submit"
                  className="flex-1 bg-primary text-slate-900 py-3 rounded-xl font-bold hover:bg-blue-600 transition"
                >
                  Salva
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      <div className="bg-white p-6 rounded-2xl shadow-lg border border-borderSoft">
        <h2 className="text-lg font-bold mb-4 flex items-center gap-2 text-slate-900">
          <span className="material-symbols-outlined text-primary">layers</span>
          Portafogli
        </h2>
        <div className="flex flex-wrap gap-3 items-center">
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-600">Seleziona:</span>
            <select
              className="border border-borderSoft rounded-lg px-3 py-2 text-sm text-slate-800 bg-white shadow-inner"
              value={currentPortfolioId}
              onChange={e => handleSwitchPortfolio(e.target.value)}
            >
              {portfolios.map((p, idx) => (
                <option key={`${p.portfolioId}-${idx}`} value={p.portfolioId}>{p.name}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <input
              className="border border-borderSoft rounded-lg px-3 py-2 text-sm text-slate-800 bg-white"
              placeholder="Nuovo portafoglio"
              value={newPortfolioName}
              onChange={e => setNewPortfolioName(e.target.value)}
            />
            <button
              onClick={handleCreatePortfolio}
              className="bg-[#0052a3] text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-blue-600 transition shadow-sm"
            >
              Crea
            </button>
          </div>
        </div>
      </div>

      {import.meta.env.DEV && (
        <div className="bg-amber-50 p-4 rounded-2xl border border-amber-200 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-bold uppercase text-amber-700">Dev Tools</div>
              <div className="text-sm text-amber-800">Diagnostica dati e controlli qualita.</div>
            </div>
            <a
              href="#/data"
              className="px-3 py-2 rounded-lg text-xs font-bold bg-amber-600 text-white hover:bg-amber-700 transition"
            >
              Apri Data Inspector
            </a>
          </div>
        </div>
      )}

      <div className="bg-white p-8 rounded-2xl shadow-lg border border-borderSoft">
        <h2 className="text-xl font-bold mb-6 flex items-center gap-2 text-slate-900">
          <span className="material-symbols-outlined text-primary">database</span>
          Fonti Dati
        </h2>
        <div className="space-y-6">
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="bg-slate-50 border border-borderSoft rounded-xl p-4 text-sm text-slate-700">
              <div className="flex items-start justify-between gap-3">
                <div>
                    <div className="text-sm font-bold text-slate-900">Impostazioni base</div>
                    <div className="text-xs text-slate-600 mt-1">Key EODHD: {config.eodhdApiKey?.trim() ? 'Impostata' : 'Mancante'}</div>
                    <div className="text-xs text-slate-600">Sheet prezzi: {config.googleSheetUrl?.trim() ? 'Configurato' : 'Non configurato'}</div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px]">
                      <span className={`font-bold px-2 py-1 rounded-full ${sourcesStatus.eodhdStatus === 'ok' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                        EODHD {sourcesStatus.eodhdStatus === 'ok' ? 'OK' : 'ERR'}
                      </span>
                      <span className={`font-bold px-2 py-1 rounded-full ${sourcesStatus.sheetsStatus === 'disabled' ? 'bg-slate-100 text-slate-600' : sourcesStatus.sheetsStatus === 'ok' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                        Sheets {sourcesStatus.sheetsStatus === 'disabled' ? 'disabilitato' : sourcesStatus.sheetsStatus === 'ok' ? 'OK' : 'ERR'}
                      </span>
                      <span className={`font-bold px-2 py-1 rounded-full ${sourcesStatus.appsScriptStatus === 'disabled' ? 'bg-slate-100 text-slate-600' : sourcesStatus.appsScriptStatus === 'ok' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                        Apps Script {sourcesStatus.appsScriptStatus === 'disabled' ? 'disabilitato' : sourcesStatus.appsScriptStatus === 'ok' ? 'OK' : 'ERR'}
                      </span>
                      <span className={`font-bold px-2 py-1 rounded-full ${sourcesStatus.globalStatus === 'OK' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                        Stato: {sourcesStatus.globalStatus}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px]">
                      <button
                        type="button"
                        onClick={handleQuotaCheck}
                        className="font-bold text-[#0052a3] hover:text-blue-600"
                        disabled={quotaLoading}
                      >
                        {quotaLoading ? 'Controllo quota...' : 'Controlla quota EODHD'}
                      </button>
                      {quotaDiag && (
                        <button
                          type="button"
                          onClick={() => window.open('/api/eodhd-proxy?path=%2Fapi%2Fuser&fmt=json', '_blank')}
                          className="font-bold text-slate-600 underline"
                        >
                          Apri risposta raw
                        </button>
                      )}
                      {quotaUpdatedAt && (
                        <span className="text-slate-400">Aggiornato: {new Date(quotaUpdatedAt).toLocaleTimeString()}</span>
                      )}
                    </div>
                    {quotaInfo && (
                      <div className="text-xs text-slate-600 mt-1">
                        <span>Chiamate: {quotaInfo.apiRequests ?? 'N/D'}{quotaInfo.dailyRateLimit !== undefined ? `/${quotaInfo.dailyRateLimit}` : ''}</span>
                        {quotaInfo.remaining !== undefined && (
                          <span className={`ml-2 font-bold ${quotaInfo.remaining > 5 ? 'text-emerald-700' : quotaInfo.remaining > 0 ? 'text-amber-700' : 'text-red-700'}`}>
                            Restanti: {quotaInfo.remaining}
                          </span>
                        )}
                      </div>
                    )}
                    {!quotaInfo && quotaDiag && (
                      <div className="text-xs text-slate-600 mt-1">
                        HTTP {quotaDiag.httpStatus} · {quotaDiag.contentType || 'n/a'}
                      </div>
                    )}
                    {quotaError && (
                      <div className="text-xs text-red-700 mt-1">{quotaError}</div>
                    )}
                    {quotaDiag?.rawPreview && quotaError && (
                      <div className="text-[10px] text-amber-700 mt-1 whitespace-pre-wrap">{quotaDiag.rawPreview}</div>
                    )}
                    <div className="text-xs text-slate-600">Valuta base: {config.baseCurrency}</div>
                    <div className="text-xs text-slate-600">Exchange preferiti: {(config.preferredExchangesOrder || ['SW','US','LSE','XETRA','MI','PA']).join(', ')}</div>
                  <div className="text-xs text-slate-600">Backfill: dal {config.minHistoryDate || '2020-01-01'} ({(config.priceBackfillScope || 'current') === 'all' ? 'Completo' : 'Solo correnti'})</div>
                  {saveNotice && <div className="text-xs text-green-700 mt-2">{saveNotice}</div>}
                </div>
                <button
                  type="button"
                  onClick={() => setConfigModalOpen(true)}
                  className="text-xs font-bold text-[#0052a3] hover:text-blue-600"
                >
                  Modifica
                </button>
              </div>
            </div>

            <div className="bg-slate-50 border border-borderSoft rounded-xl p-4 text-sm text-slate-700">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold uppercase text-slate-500">Proxy &amp; API</span>
                  {proxyHealthLoading ? (
                    <span className="text-xs text-slate-400">Verifica...</span>
                  ) : proxyHealth?.ok ? (
                    <span className="text-xs font-bold text-green-600">OK</span>
                  ) : proxyHealth ? (
                    <span className="text-xs font-bold text-red-600">Non raggiungibile</span>
                  ) : (
                    <span className="text-xs font-bold text-slate-500">Non testato</span>
                  )}
                  {config.eodhdApiKey?.trim() && (
                    <span className="text-[10px] font-bold uppercase text-emerald-700 bg-emerald-100 px-2 py-1 rounded-full">
                      Key locale attiva
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="text-xs font-bold text-[#0052a3] hover:text-blue-600"
                  onClick={() => loadProxyHealth(config.eodhdApiKey)}
                >
                  Test connessione
                </button>
              </div>
              <div className="mt-2 flex flex-wrap gap-3 text-xs">
                <div>
                  <span className="text-slate-500">EODHD key:</span>{' '}
                  {proxyHealthLoading ? '...' : proxyHealth?.hasEodhdKey ? 'OK' : 'Mancante'}
                </div>
                {proxyHealth?.ok && !proxyHealth?.hasEodhdKey && (
                  <div className="text-amber-700">
                    Chiave EODHD non trovata nell’ambiente locale. Aggiungila in `.env.local` e riavvia il dev server.
                  </div>
                )}
                {proxyHealth == null && !proxyHealthLoading && (
                  <div className="text-slate-500">
                    Stato non testato: premi “Test connessione” per verificare.
                  </div>
                )}
                {proxyHealth && !proxyHealth.ok && (
                  <div className="space-y-1 text-slate-600">
                    <div><span className="font-semibold">Cosa significa:</span> il proxy `/api` non risponde e alcune funzioni (prezzi/FX) possono fallire.</div>
                    <div><span className="font-semibold">Cosa fare:</span> avvia `npm run dev:vercel` in locale oppure verifica la configurazione del proxy.</div>
                    <div>
                      <a href="#/data?tab=checks" className="text-[#0052a3] font-bold hover:underline">
                        Apri Data Inspector
                      </a>
                      <span className="mx-2 text-slate-400">·</span>
                      <span className="text-slate-500">Documentazione locale: usa `dev:vercel`</span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="bg-slate-50 border border-borderSoft rounded-xl p-4 space-y-3 text-sm text-slate-700">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold uppercase text-slate-500">Apps Script</span>
                  {sourcesStatus.appsScriptStatus === 'disabled' ? (
                    <span className="text-xs font-bold text-slate-500">Disabilitato</span>
                  ) : sourcesStatus.appsScriptStatus === 'ok' ? (
                    <span className="text-xs font-bold text-green-600">OK</span>
                  ) : (
                    <span className="text-xs font-bold text-red-600">Errore</span>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">Apps Script URL (exec)</label>
                  <input
                    type="text"
                    className="w-full border border-borderSoft bg-white p-2 rounded-lg text-sm text-slate-800"
                    placeholder="https://script.google.com/macros/s/.../exec"
                    value={config.appsScriptUrl || ''}
                    onChange={e => setConfig({ ...config, appsScriptUrl: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">Apps Script API key</label>
                  <input
                    type="password"
                    className="w-full border border-borderSoft bg-white p-2 rounded-lg text-sm text-slate-800"
                    placeholder="API key"
                    value={config.appsScriptApiKey || ''}
                    onChange={e => setConfig({ ...config, appsScriptApiKey: e.target.value })}
                  />
                </div>
              </div>
              <div className="flex flex-wrap gap-2 items-center text-xs">
                <button
                  type="button"
                  onClick={handleAppsScriptPing}
                  disabled={appsScriptLoading.ping}
                  className="text-xs font-bold text-[#0052a3] hover:text-blue-600"
                >
                  {appsScriptLoading.ping ? 'Test Ping...' : 'Test Ping'}
                </button>
                <button
                  type="button"
                  onClick={handleAppsScriptAssets}
                  disabled={appsScriptLoading.assets}
                  className="text-xs font-bold text-[#0052a3] hover:text-blue-600"
                >
                  {appsScriptLoading.assets ? 'Test Asset Map...' : 'Test Asset Map'}
                </button>
                <button
                  type="button"
                  onClick={handleAppsScriptMacro}
                  disabled={appsScriptLoading.macro}
                  className="text-xs font-bold text-[#0052a3] hover:text-blue-600"
                >
                  {appsScriptLoading.macro ? 'Test Macro...' : 'Test Macro'}
                </button>
                <button
                  type="button"
                  onClick={handleAppsScriptFx}
                  disabled={appsScriptLoading.fx}
                  className="text-xs font-bold text-[#0052a3] hover:text-blue-600"
                >
                  {appsScriptLoading.fx ? 'Test FX...' : 'Test FX'}
                </button>
              </div>
              {appsScriptTests.assets && (
                <div className="text-[11px] text-slate-600">
                  Asset Map: {appsScriptTests.assets.status.toUpperCase()}
                  {appsScriptTests.assets.count !== undefined ? ` · count=${appsScriptTests.assets.count}` : ''}
                  {appsScriptTests.assets.sample ? ` · ${appsScriptTests.assets.sample}` : ''}
                </div>
              )}
              {appsScriptTests.macro && (
                <div className="text-[11px] text-slate-600">
                  Macro: {appsScriptTests.macro.status.toUpperCase()}
                  {appsScriptTests.macro.count !== undefined ? ` · count=${appsScriptTests.macro.count}` : ''}
                  {appsScriptTests.macro.sample ? ` · ${appsScriptTests.macro.sample}` : ''}
                </div>
              )}
              {appsScriptTests.fx && (
                <div className="text-[11px] text-slate-600">
                  FX: {appsScriptTests.fx.status.toUpperCase()}
                  {appsScriptTests.fx.count !== undefined ? ` · count=${appsScriptTests.fx.count}` : ''}
                  {appsScriptTests.fx.sample ? ` · ${appsScriptTests.fx.sample}` : ''}
                </div>
              )}
              {appsScriptTests.ping && (
                <div className="text-[11px] text-slate-600">
                  Ping: {appsScriptTests.ping.status.toUpperCase()}
                  {appsScriptTests.ping.message ? ` · ${appsScriptTests.ping.message}` : ''}
                </div>
              )}
              {appsScriptTests.assets?.diag && appsScriptTests.assets.status === 'err' && (
                <div className="text-[10px] text-amber-700 whitespace-pre-wrap">
                  HTTP {appsScriptTests.assets.diag.httpStatus} · {appsScriptTests.assets.diag.contentType || 'n/a'}
                  {appsScriptTests.assets.diag.rawPreview ? ` · ${appsScriptTests.assets.diag.rawPreview}` : ''}
                </div>
              )}
              {appsScriptTests.macro?.diag && appsScriptTests.macro.status === 'err' && (
                <div className="text-[10px] text-amber-700 whitespace-pre-wrap">
                  HTTP {appsScriptTests.macro.diag.httpStatus} · {appsScriptTests.macro.diag.contentType || 'n/a'}
                  {appsScriptTests.macro.diag.rawPreview ? ` · ${appsScriptTests.macro.diag.rawPreview}` : ''}
                </div>
              )}
              {appsScriptTests.fx?.diag && appsScriptTests.fx.status === 'err' && (
                <div className="text-[10px] text-amber-700 whitespace-pre-wrap">
                  HTTP {appsScriptTests.fx.diag.httpStatus} · {appsScriptTests.fx.diag.contentType || 'n/a'}
                  {appsScriptTests.fx.diag.rawPreview ? ` · ${appsScriptTests.fx.diag.rawPreview}` : ''}
                </div>
              )}
              {appsScriptTests.fx && appsScriptTests.fx.status === 'err' && (
                <div className="text-xs text-amber-700">
                  <div><span className="font-semibold">Cosa significa:</span> Apps Script ha risposto con errore e i tassi FX non sono stati importati.</div>
                  <div><span className="font-semibold">Cosa fare:</span> verifica URL/API key in Settings e riprova.</div>
                  <div>
                    <a href="#/data?tab=fx" className="text-[#0052a3] font-bold hover:underline">Apri Data Inspector (FX)</a>
                  </div>
                </div>
              )}
            </div>

            <div className="bg-slate-50 border border-borderSoft rounded-xl p-4 space-y-3 text-sm text-slate-700">
              <div className="text-sm font-bold text-slate-900">Prezzi &amp; Backfill</div>
              <div className="text-xs text-slate-600">
                Copertura: {coverageSummary.okCount}/{coverageSummary.total} tickers - {coverageSummary.earliest || coverage.earliestCoveredDate || 'N/D'} - {coverageSummary.latest || coverage.latestCoveredDate || 'N/D'}
              </div>
              <div className="text-xs text-slate-600 space-y-1">
                <div><span className="font-semibold text-slate-700">Aggiorna prezzi:</span> aggiorna i valori di oggi (Sheets/EODHD) e rinfresca l’app.</div>
                <div><span className="font-semibold text-slate-700">Scarica storico:</span> usa quando mancano periodi o hai appena importato nuovi strumenti.</div>
              </div>
              <div className="flex flex-wrap gap-3">
                <button
                  onClick={handleSync}
                  disabled={loading}
                  className="bg-[#0052a3] text-white px-4 py-2 rounded-lg text-xs font-bold disabled:opacity-50 hover:bg-blue-600 transition shadow-sm flex items-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                >
                  {loading ? (
                    <>
                      <span className="material-symbols-outlined animate-spin text-sm">refresh</span>
                      Aggiornamento...
                    </>
                  ) : (
                    <>
                      <span className="material-symbols-outlined text-sm">sync</span>
                      Aggiorna Prezzi
                    </>
                  )}
                </button>
                <button
                  onClick={handleBackfill}
                  disabled={bfLoading}
                  className="bg-white border border-borderSoft text-slate-700 px-4 py-2 rounded-lg text-xs font-bold disabled:opacity-50 hover:bg-slate-50 transition shadow-sm flex items-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                >
                  {bfLoading ? (
                    <>
                      <span className="material-symbols-outlined animate-spin text-sm">refresh</span>
                      Scaricamento...
                    </>
                  ) : (
                    <>
                      <span className="material-symbols-outlined text-sm">download</span>
                      Scarica storico prezzi
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={handleTestEodhdAll}
                  disabled={!config.eodhdApiKey?.trim() || isTestingAll}
                  className="text-xs font-bold text-[#0052a3] hover:text-blue-600 disabled:opacity-60"
                >
                  {isTestingAll
                    ? `Test EODHD (tutti)... ${testAllProgress.done}/${testAllProgress.total}`
                    : 'Test EODHD (tutti)'}
                </button>
                <button
                  type="button"
                  onClick={handleRerunSymbolMigration}
                  className="text-xs font-bold text-[#0052a3] hover:text-blue-600"
                >
                  Riesegui migrazione symbol
                </button>
                <button
                  onClick={() => setCoverageExpanded(prev => !prev)}
                  className="text-xs font-bold text-[#0052a3] hover:text-blue-600"
                >
                  {coverageExpanded ? 'Nascondi copertura' : 'Dettagli copertura'}
                </button>
              </div>
              {bfStatus && <div className="text-xs text-slate-600 font-medium">{bfStatus}</div>}
              {bfStatus && (bfStatus.toLowerCase().includes('errore') || bfStatus.toLowerCase().includes('quota') || bfStatus.toLowerCase().includes('interrotto')) && (
                <div className="text-xs text-amber-700">
                  Suggerimento: verifica la chiave EODHD e riprova. Se il problema persiste, usa il Data Inspector per vedere quali ticker mancano.
                </div>
              )}
              {syncSummary && (
                <div className="text-xs text-slate-600 space-y-1">
                  <div>
                    <span className="text-slate-500">Sync:</span>{' '}
                    <span className={`px-2 py-0.5 rounded-full font-bold ${syncStatusClass}`}>{syncStatusLabel}</span>
                  </div>
                  {fxSyncNotice && (
                    <div className={fxSyncNotice.status === 'ok' ? 'text-emerald-700' : fxSyncNotice.status === 'warn' ? 'text-amber-700' : 'text-red-700'}>
                      FX: {fxSyncNotice.message}
                    </div>
                  )}
                  {syncSummary.failedTickers.length > 0 && (
                    <div className="text-amber-700">
                      Errori: {syncSummary.failedTickers.slice(0, 5).map(f => f.ticker).join(', ')}
                      {syncSummary.failedTickers.length > 5 ? 'ï¿½' : ''}
                    </div>
                  )}
                    {syncSummary.sheet.enabled ? null : (
                      <div className="text-slate-500">Sheets disabilitato: {syncSummary.sheet.reason}</div>
                    )}
                  {syncSummary.status === 'quota_exhausted' && (
                    <div className="text-red-700">
                      Quota EODHD esaurita (402). Sync interrotta per evitare chiamate inutili. Riprova dopo il reset o valuta upgrade.
                    </div>
                  )}
                </div>
              )}
              {syncSummary && syncSummary.status !== 'ok' && (
                <div className="text-xs text-amber-700">
                  Cosa fare ora: controlla impostazioni Sheet/EODHD/Apps Script, poi riprova. In alternativa apri il Data Inspector per i dettagli.
                </div>
              )}

              <div className="border-t border-borderSoft pt-3 mt-2 space-y-2 text-xs text-slate-600">
                <div className="flex flex-wrap gap-4 items-center">
                  <label className="flex items-center gap-2 text-xs font-bold text-slate-600">
                    <input
                      type="checkbox"
                      checked={autoGapEnabled}
                      onChange={e => handleToggleAutoGap(e.target.checked)}
                    />
                    Auto riempi buchi all’avvio
                  </label>
                  <div className="flex items-center gap-2">
                    <span className="text-slate-500">Scope:</span>
                    <select
                      value={autoGapScope}
                      onChange={e => handleAutoGapScopeChange(e.target.value as AutoGapScope)}
                      className="border border-borderSoft rounded-md px-2 py-1 text-xs bg-white text-slate-700"
                    >
                      <option value="current">Solo portafoglio attivo</option>
                      <option value="allPortfolios">Tutti i portafogli</option>
                    </select>
                  </div>
                  <button
                    type="button"
                    onClick={handleAutoGapNow}
                    disabled={autoGapRunning || !config.eodhdApiKey?.trim()}
                    className="text-xs font-bold text-[#0052a3] hover:text-blue-600 disabled:opacity-60"
                  >
                    {autoGapRunning ? 'Gap-fill in corso...' : 'Esegui gap-fill ora'}
                  </button>
                </div>
                <div className="text-[11px] text-slate-500">
                  Ultimo auto-sync: {autoSyncLabel} · Gap-fill: {gapFillLabel} · Budget oggi usato: {budgetStatus.used}
                </div>
                {autoGapStatus && (
                  <div className="text-[11px] text-slate-600">{autoGapStatus}</div>
                )}
              </div>
            </div>

            <div className="bg-slate-50 border border-borderSoft rounded-xl p-4 space-y-3 text-sm text-slate-700">
              <div className="text-sm font-bold text-slate-900">Backup &amp; Import</div>
              <div className="flex flex-wrap gap-3">
                <button
                  onClick={handleExport}
                  className="bg-slate-100 text-slate-700 px-4 py-2 rounded-lg text-xs font-bold hover:bg-slate-200 transition border border-borderSoft"
                >
                  Export Backup
                </button>
                <button
                  onClick={handleImportClick}
                  className="bg-white text-slate-700 px-4 py-2 rounded-lg text-xs font-bold hover:bg-slate-50 transition border border-borderSoft"
                >
                  Importa Backup
                </button>
                <input
                  type="file"
                  accept="application/json"
                  ref={fileInputRef}
                  onChange={handleImport}
                  className="hidden"
                />
              </div>
            </div>
          </div>

          <div className="bg-slate-50 border border-borderSoft rounded-xl p-4 space-y-3 relative">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-bold text-slate-900">Copertura prezzi (portafoglio attivo)</div>
                <div className="text-xs text-slate-600">
                  Dal {coverageSummary.earliest || coverage.earliestCoveredDate || 'N/D'} al {coverageSummary.latest || coverage.latestCoveredDate || 'N/D'} - Ticker coperti: {coverageSummary.okCount}/{coverageSummary.total}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {coverageSummary.okCount < (coverageSummary.total || 1) && (
                  <span className="text-xs font-bold text-amber-600 bg-amber-100 px-2 py-1 rounded-lg">Dati incompleti</span>
                )}
                <InfoPopover
                  ariaLabel="Info Copertura prezzi"
                  title="Come leggere la copertura prezzi"
                  renderContent={() => (
                    <div className="space-y-2 text-sm">
                      <ul className="list-disc list-inside space-y-1">
                        <li>La tabella mostra per ogni strumento il range di date per cui abbiamo prezzi salvati nel database.</li>
                        <li>Se vedi PARZIALE/INCOMPLETO, i grafici (ritorni annuali, drawdown, CAGR) possono risultare incompleti o N/D.</li>
                        <li>Per estendere lo storico: usa ï¿½Scarica storico prezziï¿½ oppure importa un CSV prezzi dal tuo provider.</li>
                        <li>Lo strumento mostrato (ticker) ï¿½ il listing usato per i prezzi; se ï¿½ sbagliato, correggilo in ï¿½Listings & FXï¿½.</li>
                        <li>Consiglio: per SIX/CHF usa un listing .SW e importa prezzi in CHF (SIX-first).</li>
                      </ul>
                      <div className="flex flex-wrap gap-2 pt-1 text-xs">
                        <button
                          type="button"
                          className="text-[#0052a3] underline font-bold"
                          onClick={() => scrollAndFocus(listingsSectionRef)}
                        >
                          Apri Listings &amp; FX
                        </button>
                        <button
                          type="button"
                          className="text-[#0052a3] underline font-bold"
                          onClick={() => scrollAndFocus(importPriceButtonRef)}
                        >
                          Vai a Importa Prezzi CSV
                        </button>
                      </div>
                    </div>
                  )}
                />
              </div>
            </div>
            {coverageExpanded ? (
              <div className="overflow-auto max-h-56 border border-borderSoft rounded-lg bg-white">
                <table className="w-full text-sm">
                  <thead className="bg-slate-100 text-xs text-slate-600 uppercase">
                    <tr>
                      <th className="px-3 py-2 text-left">Strumento</th>
                      <th className="px-3 py-2 text-left">Provider</th>
                      <th className="px-3 py-2 text-left">Symbol</th>
                      <th className="px-3 py-2 text-left">Copertura</th>
                      <th className="px-3 py-2 text-left">Stato</th>
                      <th className="px-3 py-2 text-left">Azioni</th>
                    </tr>
                  </thead>
                  <tbody>
                    {coverage.perTicker.map((row, index) => {
                                            const instrument = resolveInstrumentForRow(row);
                      const rowConfig = getRowConfig(row.ticker);
                      const rawConfig = config.priceTickerConfig?.[row.ticker] || {};
                      const provider = rowConfig.provider as PriceProviderType;
                      const isNeedsMapping = Boolean(rowConfig.needsMapping);
                      const isExcluded = !isNeedsMapping && (rowConfig.excluded || provider === 'MANUAL');
                      const effectiveSymbol = provider === 'SHEETS'
                        ? rowConfig.sheetSymbol
                        : provider === 'EODHD'
                          ? resolveEodhdSymbol(rowConfig.eodhdSymbol, instrument?.type)
                          : '--';
                      const statusLabel = isNeedsMapping ? 'MAPPING' : isExcluded ? (provider === 'MANUAL' ? 'MANUAL' : 'ESCLUSO') : row.status;
                      const statusClass = isNeedsMapping
                        ? 'bg-red-100 text-red-700'
                        : isExcluded
                          ? 'bg-slate-100 text-slate-600'
                          : row.status === 'OK'
                            ? 'bg-green-100 text-green-700'
                            : row.status === 'PARZIALE'
                              ? 'bg-amber-100 text-amber-700'
                              : 'bg-red-100 text-red-700';
                      const eodhdBadge = getEodhdBadge(eodhdTests[row.ticker]?.status);
                      const sheetBadge = getSheetBadge(sheetTests[row.ticker]);
                      const sheetReason = sheetTests[row.ticker]?.reason;

                      return (
                        <tr key={`${row.ticker}-${row.instrumentId ?? index}`} className="border-t border-borderSoft align-top">
                          <td className="px-3 py-2">
                            <div className="flex flex-col">
                              <span className="font-semibold text-slate-900">{row.ticker}</span>
                              <span className="text-xs text-slate-600">
                                ISIN: {row.isin || 'ï¿½'}{row.name ? ` - ${row.name}` : ''}
                              </span>
                              {!isExcluded && row.status !== 'OK' && (
                                <button
                                  type="button"
                                  className="text-xs font-bold text-[#0052a3] hover:text-blue-500 text-left mt-1"
                                  onClick={() => handleOpenListingsFromCoverage(row)}
                                  aria-label={`Apri in Listings & FX per ${row.ticker}`}
                                >
                                  Apri in Listings &amp; FX
                                </button>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex flex-col gap-2">
                              <select
                                className="border border-borderSoft rounded-lg px-2 py-1 text-xs text-slate-800 bg-white shadow-inner"
                                value={provider}
                                onChange={e => updateTickerConfig(row.ticker, { provider: e.target.value as PriceProviderType })}
                              >
                                <option value="EODHD">EODHD</option>
                                <option value="SHEETS">Sheets</option>
                                <option value="MANUAL">Manual (CSV)</option>
                              </select>
                              <label className="inline-flex items-center gap-2 text-[11px] text-slate-500">
                                <input
                                  type="checkbox"
                                  checked={Boolean(rawConfig.exclude)}
                                  onChange={() => updateTickerConfig(row.ticker, { exclude: !rawConfig.exclude })}
                                />
                                Escludi dal sync/backfill
                              </label>
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            {provider === 'EODHD' && (
                              <div className="space-y-1">
                                <input
                                  className="w-full border border-borderSoft rounded-lg px-2 py-1 text-xs text-slate-800 bg-white shadow-inner"
                                  placeholder={row.ticker}
                                  value={rawConfig.eodhdSymbol || ''}
                                  onChange={e => handleEodhdSymbolChange(row, e.target.value)}
                                />
                                <div className="text-[11px] text-slate-500">Usato: <span className="font-semibold">{effectiveSymbol}</span></div>
                                {eodhdSymbolErrors[row.ticker] && (
                                  <div className="text-[10px] text-red-600">{eodhdSymbolErrors[row.ticker]}</div>
                                )}
                              </div>
                            )}
                            {provider === 'SHEETS' && (
                              <div className="space-y-1">
                                <input
                                  className="w-full border border-borderSoft rounded-lg px-2 py-1 text-xs text-slate-800 bg-white shadow-inner"
                                  placeholder={row.ticker}
                                  value={rawConfig.sheetSymbol || ''}
                                  onChange={e => updateTickerConfig(row.ticker, { sheetSymbol: e.target.value })}
                                />
                                <div className="text-[11px] text-slate-500">Usato: <span className="font-semibold">{effectiveSymbol}</span></div>
                              </div>
                            )}
                            {provider === 'MANUAL' && (
                              <div className="text-xs text-slate-500">Manuale (CSV)</div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-slate-700">
                            <div className="text-xs">Dal {row.from}</div>
                            <div className="text-xs">Al {row.to}</div>
                          </td>
                          <td className="px-3 py-2">
                            <span className={`text-xs font-bold px-2 py-1 rounded-lg ${statusClass}`}>
                              {statusLabel}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex flex-col gap-2">
                              <div className="flex items-center gap-2 flex-wrap">
                                <button
                                  type="button"
                                  onClick={() => handleTestEodhd(row.ticker)}
                                  disabled={eodhdTesting[row.ticker]}
                                  className="text-xs font-bold text-[#0052a3] hover:text-blue-500"
                                >
                                  {eodhdTesting[row.ticker] ? 'Test EODHD...' : 'Test EODHD (singolo)'}
                                </button>
                                {eodhdTests[row.ticker]?.url && (
                                  <button
                                    type="button"
                                    onClick={() => window.open(eodhdTests[row.ticker]?.url, '_blank')}
                                    className="text-[10px] font-bold text-slate-600 underline"
                                  >
                                    Apri risposta raw
                                  </button>
                                )}
                                {eodhdBadge && (
                                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${eodhdBadge.className}`}>
                                    {eodhdBadge.label}
                                  </span>
                                )}
                                {eodhdTests[row.ticker]?.status === 'OK' && (
                                  <button
                                    type="button"
                                    className="text-[10px] font-bold text-emerald-700 underline"
                                    onClick={() => handleSetEodhdSymbol(row.ticker, eodhdTests[row.ticker]?.symbol || rowConfig.eodhdSymbol)}
                                  >
                                    Imposta come symbol EODHD
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => handleResetTickerPrices(row.ticker)}
                                  className="text-[10px] font-bold text-slate-600 underline"
                                >
                                  Svuota cache locale
                                </button>
                              </div>
                              {eodhdTests[row.ticker] && (
                                <div className="text-[10px] text-slate-500 mt-1">
                                  {eodhdTests[row.ticker]?.httpStatus ? `HTTP ${eodhdTests[row.ticker]?.httpStatus}` : ''}
                                  {eodhdTests[row.ticker]?.contentType ? ` · ${eodhdTests[row.ticker]?.contentType}` : ''}
                                  {eodhdTests[row.ticker]?.message ? ` · ${eodhdTests[row.ticker]?.message}` : ''}
                                  {eodhdTests[row.ticker]?.sample ? ` · ${eodhdTests[row.ticker]?.sample}` : ''}
                                  {eodhdTests[row.ticker]?.parseError ? ` · parseError: ${eodhdTests[row.ticker]?.parseError}` : ''}
                                </div>
                              )}
                              {eodhdTests[row.ticker]?.rawPreview && eodhdTests[row.ticker]?.status !== 'OK' && (
                                <div className="text-[10px] text-amber-700 mt-1 whitespace-pre-wrap">
                                  {eodhdTests[row.ticker]?.rawPreview}
                                </div>
                              )}
                              <div className="flex items-center gap-2 flex-wrap">
                                <button
                                  type="button"
                                  onClick={() => handleTestSheet(row.ticker)}
                                  disabled={sheetTesting[row.ticker]}
                                  className="text-xs font-bold text-[#0052a3] hover:text-blue-500"
                                >
                                  {sheetTesting[row.ticker] ? 'Test Sheet...' : 'Test Sheet'}
                                </button>
                                {sheetBadge && (
                                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${sheetBadge.className}`}>
                                    {sheetBadge.label}
                                  </span>
                                )}
                                {sheetTests[row.ticker]?.status === 'ok' && (
                                  <button
                                    type="button"
                                    className="text-[10px] font-bold text-emerald-700 underline"
                                    onClick={() => handleUseSheetLatest(row.ticker, sheetTests[row.ticker]?.symbol || rowConfig.sheetSymbol)}
                                  >
                                    Usa Sheet per latest
                                  </button>
                                )}
                              </div>
                              {sheetReason && (
                                <div className="text-[10px] text-amber-700">{sheetReason}</div>
                              )}
                              {sheetTests[row.ticker]?.status === 'ok' && sheetTests[row.ticker]?.price && (
                                <div className="text-[10px] text-slate-600">
                                  Sheet latest: {sheetTests[row.ticker]?.price?.close}{' '}
                                  {sheetTests[row.ticker]?.price?.currency || ''} {sheetTests[row.ticker]?.price?.date || ''}
                                </div>
                              )}
                              <button
                                type="button"
                                className="text-[10px] font-bold text-red-600 hover:text-red-700"
                                onClick={() => handleResetTickerPrices(row.ticker)}
                              >
                                Reset prezzi ticker
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {coverage.perTicker.length === 0 && (
                      <tr>
                        <td className="px-3 py-2 text-slate-500 text-sm" colSpan={6}>Nessun ticker da mostrare.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-xs text-slate-500">Apri i dettagli per vedere la tabella completa.</div>
            )}

          </div>

          <div ref={listingsSectionRef} className="bg-slate-50 border border-borderSoft rounded-xl p-4 space-y-4 relative">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <div className="text-sm font-bold text-slate-900">Listings &amp; FX</div>
                <div className="text-xs text-slate-600">Seleziona listing preferito, importa prezzi storici o tassi FX.</div>
              </div>
              <div className="flex items-center gap-2">
                {activeListing && (
                  <div
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold border ${
                      isSixFirst
                        ? 'bg-green-50 border-green-200 text-green-800'
                        : needsFx
                          ? 'bg-amber-50 border-amber-200 text-amber-800'
                          : 'bg-slate-100 border-borderSoft text-slate-700'
                    }`}
                    title={
                      isSixFirst
                        ? 'Stai usando il listing SIX in CHF. I prezzi devono essere importati/aggiornati in CHF. FX non necessario.'
                        : needsFx
                          ? 'Il listing selezionato ï¿½ in valuta estera. Per mostrare valori in CHF servono tassi FX (USD?CHF, EUR?CHF, GBP?CHF).'
                          : 'Listing OK'
                    }
                  >
                    <span className="material-symbols-outlined text-[16px]">
                      {isSixFirst ? 'check_circle' : needsFx ? 'warning' : 'info'}
                    </span>
                    {isSixFirst ? 'SIX-first attivo ?' : needsFx ? 'Listing estero (serve FX) ??' : 'Listing OK'}
                    {needsFx && (
                      <button
                        type="button"
                        className="underline text-xs font-bold text-[#0052a3] hover:text-blue-600"
                        onClick={handleFxPillClick}
                        aria-label="Importa FX per convertire in CHF"
                      >
                        Importa FX
                      </button>
                    )}
                  </div>
                )}
                <InfoPopover
                  ariaLabel="Info Listings & FX"
                  title="Regole pratiche (Listings & FX)"
                  renderContent={() => (
                    <div className="space-y-2 text-sm">
                      <ul className="list-disc list-inside space-y-1">
                      <li>Scegli il listing che userai per i prezzi e lo storico (es. SIX: .SW).</li>
                      <li>I prezzi importati devono avere la stessa valuta del listing selezionato (es. listing CHF -&gt; CSV CHF).</li>
                      <li>Se selezioni un listing estero (USD/EUR/GBP), per vedere tutto in CHF devi importare anche i tassi FX (USD-&gt;CHF, ecc.).</li>
                      <li>Salva sempre il listing preferito prima di importare prezzi, cosï¿½ l'import finisce sul ticker corretto.</li>
                      <li>Se la search non trova SIX, aggiungi manualmente un listing SW (.SW) in CHF (SIX-first).</li>
                      </ul>
                      <div className="flex flex-wrap gap-2 pt-1 text-xs">
                        <button
                          type="button"
                          className="text-[#0052a3] underline font-bold"
                          onClick={() => scrollAndFocus(importPriceButtonRef)}
                        >
                          Importa Prezzi (CSV)
                        </button>
                        <button
                          type="button"
                          className="text-[#0052a3] underline font-bold"
                          onClick={() => scrollAndFocus(importFxButtonRef)}
                        >
                          Importa FX (CSV)
                        </button>
                        <details className="text-slate-600 text-xs">
                          <summary className="cursor-pointer text-[#0052a3] font-bold">Cosï¿½ï¿½ SIX-first?</summary>
                          <div className="mt-1">
                            Usa un listing SIX (.SW) in CHF per evitare conversioni FX sui prezzi. Importa prezzi direttamente in CHF per allineare reporting e base currency.
                          </div>
                        </details>
                      </div>
                    </div>
                  )}
                />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-2">
                <label className="block text-sm font-bold text-slate-500">Strumento</label>
                <select
                  className="border border-borderSoft rounded-lg px-3 py-2 text-sm text-slate-800 bg-white shadow-inner"
                  ref={listingSelectRef}
                  value={selectedInstrumentId ?? ''}
                  onChange={e => setSelectedInstrumentId(e.target.value || undefined)}
                >
                  {instruments.map((i, idx) => {
                    const key = i.id ? String(i.id) : `${i.ticker || 'inst'}-${idx}`;
                    return (
                      <option key={key} value={i.id ? String(i.id) : ''}>{i.symbol || i.ticker}{i.name ? ` - ${i.name}` : ''}</option>
                    );
                  })}
                  {instruments.length === 0 && <option>Nessuno strumento</option>}
                </select>
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-bold text-slate-500">ISIN</label>
                <div className="flex gap-2">
                  <input
                    className="flex-1 border border-borderSoft rounded-lg px-3 py-2 text-sm text-slate-800 bg-white"
                    placeholder="IE00..."
                    value={isinInput}
                    onChange={e => setIsinInput(e.target.value)}
                  />
                  <button
                    type="button"
                    onClick={handleResolveIsin}
                    className="bg-[#0052a3] text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-blue-600 transition shadow-sm whitespace-nowrap"
                  >
                    Risolvi
                  </button>
                </div>
                {listingMessage && <div className="text-xs text-slate-600">{listingMessage}</div>}
              </div>
            </div>

            <div className="bg-slate-50 border border-borderSoft rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-bold text-slate-900">Distribuzione geografica (strumento)</div>
                <InfoPopover
                  ariaLabel="Info distribuzione geografica"
                  title="Come impostare le regioni"
                  renderContent={() => (
                    <div className="text-sm space-y-1">
                      <p>Inserisci le percentuali per area (somma ~100%).</p>
                      <p>Se non definite, la Dashboard mostrerï¿½ ï¿½Non definitoï¿½.</p>
                    </div>
                  )}
                />
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                {([
                  ['CH', 'Svizzera'],
                  ['NA', 'Nord America'],
                  ['EU', 'Europa'],
                  ['AS', 'Asia'],
                  ['OC', 'Oceania'],
                  ['LATAM', 'America Latina'],
                  ['AF', 'Africa'],
                  ['UNASSIGNED', 'Non definito']
                ] as [RegionKey, string][]).map(([key, label]) => (
                  <div key={key} className="space-y-1">
                    <label className="block text-[11px] font-bold text-slate-500 uppercase">{label}</label>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={0.1}
                      value={regionAllocation?.[key] ?? 0}
                      onChange={e => handleRegionChange(key, parseFloat(e.target.value))}
                      className="w-full border border-borderSoft rounded-lg px-2 py-2 text-sm text-slate-800 bg-white"
                    />
                  </div>
                ))}
              </div>
              <div className="flex gap-2 items-center">
                <button
                  type="button"
                  onClick={normalizeRegion}
                  className="bg-white border border-borderSoft text-slate-700 px-4 py-2 rounded-lg text-sm font-bold hover:bg-slate-50"
                >
                  Normalizza al 100%
                </button>
                <button
                  type="button"
                  onClick={handleSaveRegion}
                  className="bg-[#0052a3] text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-blue-600 transition shadow-sm"
                >
                  Salva distribuzione
                </button>
                <span className="text-[11px] text-slate-500">Somma attuale: {Object.values(regionAllocation || {}).reduce((s, v) => s + (v || 0), 0).toFixed(1)}%</span>
              </div>
            </div>
            {recommendedListings.length > 0 && (
              <div>
                <div className="text-xs font-bold text-slate-500 mb-2">Consigliati</div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                  {recommendedListings.map(l => (
                    <label
                      key={l.symbol}
                      className={`border rounded-lg p-3 cursor-pointer flex flex-col gap-1 ${selectedListing?.symbol === l.symbol ? 'border-primary shadow-primary/30 shadow-sm' : 'border-borderSoft'}`}
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="listing"
                          checked={selectedListing?.symbol === l.symbol}
                          onChange={() => setSelectedListing(l)}
                        />
                        <span className="text-sm font-bold text-slate-900">{l.symbol}</span>
                      </div>
                      <span className="text-xs text-slate-600">{l.exchangeCode} ï¿½ {l.currency}</span>
                      {l.name && <span className="text-xs text-slate-500">{l.name}</span>}
                    </label>
                  ))}
                </div>
              </div>
            )}
            {otherListings.length > 0 && (
              <div className="border border-borderSoft rounded-lg overflow-hidden">
                <div className="bg-slate-100 px-3 py-2 text-xs font-bold text-slate-600 uppercase">Altri risultati</div>
                <div className="max-h-40 overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-white text-xs text-slate-500">
                      <tr>
                        <th className="px-3 py-2 text-left">Ticker</th>
                        <th className="px-3 py-2 text-left">Exch.</th>
                        <th className="px-3 py-2 text-left">Cur</th>
                        <th className="px-3 py-2 text-left">Azione</th>
                      </tr>
                    </thead>
                    <tbody>
                      {otherListings.map(l => (
                        <tr key={`${l.exchangeCode}-${l.symbol}`} className="border-t border-borderSoft">
                          <td className="px-3 py-2 font-semibold">{l.symbol}</td>
                          <td className="px-3 py-2 text-slate-700">{l.exchangeCode}</td>
                          <td className="px-3 py-2 text-slate-700">{l.currency}</td>
                          <td className="px-3 py-2">
                            <button
                              className="text-xs text-primary font-bold"
                              onClick={() => setSelectedListing(l)}
                            >
                              Seleziona
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            <div className="flex flex-wrap gap-3 items-center">
              <button
                onClick={handleApplyListing}
                className="bg-[#0052a3] text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-blue-600 transition shadow-sm"
              >
                Salva listing preferito
              </button>
              <button
                type="button"
                className="bg-white border border-borderSoft text-slate-700 px-4 py-2 rounded-lg text-sm font-bold hover:bg-slate-50"
                onClick={() => priceCsvRef.current?.click()}
                ref={importPriceButtonRef}
              >
                Importa prezzi (CSV)
              </button>
              <input type="file" ref={priceCsvRef} className="hidden" accept=".csv,text/csv" onChange={handlePriceCsvImport} />
              <button
                type="button"
                className="bg-white border border-borderSoft text-slate-700 px-4 py-2 rounded-lg text-sm font-bold hover:bg-slate-50"
                onClick={() => fxCsvRef.current?.click()}
                ref={importFxButtonRef}
                >
                Importa FX (CSV)
              </button>
              <input type="file" ref={fxCsvRef} className="hidden" accept=".csv,text/csv" onChange={handleFxImport} />
              <div className="flex items-center gap-2 text-xs text-slate-600">
                <span>FX base</span>
                <select className="border border-borderSoft rounded px-2 py-1" value={fxBase} onChange={e => setFxBase(e.target.value as Currency)}>
                  {Object.values(Currency).map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <span>/</span>
                <select className="border border-borderSoft rounded px-2 py-1" value={fxQuote} onChange={e => setFxQuote(e.target.value as Currency)}>
                  {Object.values(Currency).map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-slate-50 border border-borderSoft rounded-xl p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-bold text-slate-900">Gestione Listings</div>
                  <div className="text-xs text-slate-600">Voci salvate: {listingRows.length}</div>
                </div>
              </div>
              <div className="mt-3 max-h-56 overflow-auto border border-borderSoft rounded-lg bg-white">
                <table className="w-full text-sm">
                  <thead className="bg-slate-100 text-xs text-slate-600 uppercase">
                    <tr>
                      <th className="px-3 py-2 text-left">Ticker</th>
                      <th className="px-3 py-2 text-left">Exch</th>
                      <th className="px-3 py-2 text-left">Cur</th>
                      <th className="px-3 py-2 text-left">Usato</th>
                      <th className="px-3 py-2 text-right">Azione</th>
                    </tr>
                  </thead>
                  <tbody>
                    {listingRows.map((row) => {
                      const usage = listingUsage.get(row.symbol);
                      const usedCount = usage?.count || 0;
                      const usageLabel = usedCount ? `${usedCount} str.` : '-';
                      return (
                        <tr key={`${row.symbol}-${row.exchangeCode}-${row.id ?? 'row'}`} className="border-t border-borderSoft">
                          <td className="px-3 py-2 font-bold text-slate-700">{row.symbol}</td>
                          <td className="px-3 py-2 text-slate-700">{row.exchangeCode}</td>
                          <td className="px-3 py-2 text-slate-700">{row.currency}</td>
                          <td className="px-3 py-2" title={usage?.names?.join(', ') || ''}>
                            <span className={usedCount ? 'text-amber-700 font-semibold' : 'text-slate-500'}>{usageLabel}</span>
                          </td>
                          <td className="px-3 py-2 text-right">
                            <button
                              type="button"
                              onClick={() => handleDeleteListing(row)}
                              className="text-xs font-bold text-red-600 hover:text-red-500 inline-flex items-center gap-1"
                              aria-label={`Elimina listing ${row.symbol}`}
                            >
                              <span className="material-symbols-outlined text-[14px]">delete</span>
                              Elimina
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                    {listingRows.length === 0 && (
                      <tr>
                        <td className="px-3 py-2 text-slate-500 text-sm" colSpan={5}>Nessun listing salvato.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="bg-slate-50 border border-borderSoft rounded-xl p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-bold text-slate-900">Gestione FX</div>
                  <div className="text-xs text-slate-600">Coppie: {fxPairs.length}</div>
                </div>
              </div>
              <div className="mt-3 max-h-56 overflow-auto border border-borderSoft rounded-lg bg-white">
                <table className="w-full text-sm">
                  <thead className="bg-slate-100 text-xs text-slate-600 uppercase">
                    <tr>
                      <th className="px-3 py-2 text-left">Coppia</th>
                      <th className="px-3 py-2 text-left">Range</th>
                      <th className="px-3 py-2 text-left">#</th>
                      <th className="px-3 py-2 text-left">Uso</th>
                      <th className="px-3 py-2 text-right">Azione</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fxPairs.map(pair => (
                      <tr key={pair.key} className="border-t border-borderSoft">
                        <td className="px-3 py-2 font-bold text-slate-700">{pair.key}</td>
                        <td className="px-3 py-2 text-slate-700">{pair.from || 'N/D'} - {pair.to || 'N/D'}</td>
                        <td className="px-3 py-2 text-slate-700">{pair.count}</td>
                        <td className="px-3 py-2">
                          <span className={pair.referenced ? 'text-amber-700 font-semibold' : 'text-slate-500'}>
                            {pair.referenced ? 'Usata' : '-'}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button
                            type="button"
                            onClick={() => handleDeleteFxPair(pair)}
                            className="text-xs font-bold text-red-600 hover:text-red-500 inline-flex items-center gap-1"
                            aria-label={`Elimina FX ${pair.key}`}
                          >
                            <span className="material-symbols-outlined text-[14px]">delete</span>
                            Elimina
                          </button>
                        </td>
                      </tr>
                    ))}
                    {fxPairs.length === 0 && (
                      <tr>
                        <td className="px-3 py-2 text-slate-500 text-sm" colSpan={5}>Nessuna coppia FX salvata.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* REPAIR IMPORTED TRANSACTIONS */}
      <div className="bg-slate-50 border border-borderSoft rounded-2xl p-6 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-bold text-slate-900">Ripara transazioni importate</div>
            <div className="text-xs text-slate-600">Senza strumento: {missingTxRows.length}</div>
          </div>
        </div>
        {missingTxRows.length === 0 ? (
          <div className="text-xs text-slate-500">Nessuna transazione da riparare.</div>
        ) : (
          <div className="border border-borderSoft rounded-xl overflow-auto bg-white">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 text-xs text-slate-600 uppercase">
                <tr>
                  <th className="px-3 py-2 text-left">Data</th>
                  <th className="px-3 py-2 text-left">Ticker import</th>
                  <th className="px-3 py-2 text-left">Tipo</th>
                  <th className="px-3 py-2 text-right">Qta</th>
                  <th className="px-3 py-2 text-left">Strumento</th>
                  <th className="px-3 py-2 text-right">Azione</th>
                </tr>
              </thead>
              <tbody>
                {missingTxRows.map(tx => {
                  const selection = getRepairSelection(tx);
                  const txDate = tx.date ? new Date(tx.date).toLocaleDateString('it-IT') : 'N/D';
                  return (
                    <tr key={tx.id ?? `${txDate}-${tx.instrumentTicker || 'no-ticker'}`} className="border-t border-borderSoft">
                      <td className="px-3 py-2 text-slate-700">{txDate}</td>
                      <td className="px-3 py-2 font-semibold">{tx.instrumentTicker || 'â€”'}</td>
                      <td className="px-3 py-2">{tx.type}</td>
                      <td className="px-3 py-2 text-right">{Number(tx.quantity || 0).toLocaleString('it-CH')}</td>
                      <td className="px-3 py-2">
                        <select
                          className="border border-borderSoft rounded-lg px-2 py-1 text-xs bg-white"
                          value={selection}
                          onChange={e => {
                            if (!tx.id) return;
                            setTxRepairSelection(prev => ({ ...prev, [tx.id!]: e.target.value }));
                          }}
                        >
                          <option value="">Seleziona...</option>
                          {instruments.map(inst => {
                            const label = `${inst.symbol || inst.ticker}${inst.name ? ` - ${inst.name}` : ''}${inst.isin ? ` · ${inst.isin}` : ''}`;
                            return (
                              <option key={String(inst.id)} value={String(inst.id)}>{label}</option>
                            );
                          })}
                        </select>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          className={clsx(
                            'px-3 py-1 rounded text-[11px] font-bold',
                            selection ? 'bg-[#0052a3] text-white' : 'bg-slate-100 text-slate-400 cursor-not-allowed'
                          )}
                          onClick={() => handleRepairTransaction(tx)}
                          disabled={!selection}
                        >
                          Assegna
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* DANGER ZONE */}
      <div className="bg-red-50 p-8 rounded-2xl shadow-sm border border-red-200">
        <h2 className="text-lg font-bold text-red-700 mb-2 flex items-center gap-2">
          <span className="material-symbols-outlined">warning</span>
          Zona Pericolo
        </h2>
        <p className="text-sm text-red-700/70 mb-6 leading-relaxed">
          Se l'applicazione non visualizza i dati corretti o hai conflitti con versioni precedenti, puoi resettare il database.
          Questo cancellerï¿½ tutto e ricaricherï¿½ i dati demo.
        </p>
        <button
          onClick={handleReset}
          className="bg-white border border-red-200 text-red-600 px-5 py-2.5 rounded-xl text-sm font-bold hover:bg-red-50 transition shadow-sm"
        >
          Resetta Database e Ricarica
        </button>
      </div>
    </div>
  );
};























