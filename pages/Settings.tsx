import React, { useEffect, useRef, useState } from 'react';
import { db, getCurrentPortfolioId, setCurrentPortfolioId } from '../db';
import { syncPrices, getTickersForBackfill, getPriceCoverage, backfillPricesForPortfolio, CoverageRow } from '../services/priceService';
import { resolveListingsByIsin } from '../services/eodhdSearchService';
import { pickDefaultListing, pickRecommendedListings } from '../services/listingService';
import { importFxCsv } from '../services/fxService';
import { Currency, InstrumentListing, Instrument, RegionKey } from '../types';
import { InfoPopover } from '../components/InfoPopover';

export const Settings: React.FC = () => {
  const [config, setConfig] = useState({
    eodhdApiKey: '',
    googleSheetUrl: '',
    baseCurrency: Currency.CHF,
    minHistoryDate: '2020-01-01',
    priceBackfillScope: 'current' as 'current' | 'all',
    preferredExchangesOrder: ['SW', 'US', 'LSE', 'XETRA', 'MI', 'PA'] as string[]
  });
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const listingsSectionRef = useRef<HTMLDivElement | null>(null);
  const listingSelectRef = useRef<HTMLSelectElement | null>(null);
  const [settingsId, setSettingsId] = useState<number | undefined>(undefined);
  const currentPortfolioId = getCurrentPortfolioId();
  const [portfolios, setPortfolios] = useState<{ id?: number; portfolioId: string; name: string }[]>([]);
  const [newPortfolioName, setNewPortfolioName] = useState('');
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [selectedInstrumentId, setSelectedInstrumentId] = useState<number | undefined>(undefined);
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
  const [regionAllocation, setRegionAllocation] = useState<Partial<Record<RegionKey, number>>>({});

  useEffect(() => {
    db.settings.where('portfolioId').equals(currentPortfolioId).first().then(s => {
      if (s) {
        setConfig(prev => ({
          ...prev,
          ...s,
          minHistoryDate: s.minHistoryDate || '2020-01-01',
          priceBackfillScope: (s.priceBackfillScope as any) || 'current',
          preferredExchangesOrder: s.preferredExchangesOrder || prev.preferredExchangesOrder
        }));
        setSettingsId(s.id);
        if (s.baseCurrency) setFxBase(s.baseCurrency);
      }
    });
    db.portfolios.toArray().then(setPortfolios);
    db.instruments.where('portfolioId').equals(currentPortfolioId).toArray().then(res => {
      setInstruments(res as Instrument[]);
      if (res.length > 0) setSelectedInstrumentId(res[0].id);
      if (res.length > 0 && res[0].regionAllocation) setRegionAllocation(res[0].regionAllocation);
    });
  }, [currentPortfolioId]);

  const handleSave = async () => {
    await db.settings.put({ ...config, id: settingsId, portfolioId: currentPortfolioId });
    alert('Impostazioni salvate');
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

  const handleSync = async () => {
    setLoading(true);
    try {
      await syncPrices();
      alert('Prezzi aggiornati con successo!');
    } catch (e) {
      alert('Errore aggiornamento prezzi.');
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
      await backfillPricesForPortfolio(
        currentPortfolioId,
        tickers,
        minDate,
        (p) => {
          if (p.phase === 'done') {
            setBfStatus('Completato');
          } else {
            setBfStatus(`${p.phase === 'backfill' ? 'Backfill' : 'Forward'} ${p.index}/${p.total} ${p.ticker}${p.error ? ' - ' + p.error : ''}`);
          }
        }
      );
      await loadCoverage();
      alert('Storico aggiornato');
    } catch (e: any) {
      alert(e?.message || e);
    } finally {
      setBfLoading(false);
    }
  };

  const handleReset = async () => {
    if (confirm('ATTENZIONE: Stai per cancellare tutti i dati (Transazioni, Strumenti, Prezzi). L\'azione è irreversibile. Vuoi procedere?')) {
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

      if (!confirm('Importare il backup sovrascriverà i dati attuali. Procedere?')) return;

      const txs = (json.transactions || []).map((t: any) => ({
        ...t,
        date: t.date ? new Date(t.date) : new Date()
      }));

      await db.transaction('rw', db.portfolios, db.settings, db.instruments, db.transactions, db.prices, db.macro, async () => {
        await db.portfolios.clear();
        await db.settings.clear();
        await db.instruments.clear();
        await db.transactions.clear();
        await db.prices.clear();
        await db.macro.clear();

        if (json.portfolios) await db.portfolios.bulkAdd(json.portfolios);
        if (json.settings) await db.settings.bulkAdd(json.settings);
        if (json.instruments) await db.instruments.bulkAdd(json.instruments);
        if (txs) await db.transactions.bulkAdd(txs);
        if (json.prices) await db.prices.bulkAdd(json.prices);
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
      minHistoryDate: '2020-01-01',
      priceBackfillScope: 'current',
      preferredExchangesOrder: config.preferredExchangesOrder,
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
    if (!config.eodhdApiKey) {
      setListingMessage('Configura prima la API key EODHD');
      return;
    }
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
    const instrument = await db.instruments.get(selectedInstrumentId);
    if (!instrument) {
      setListingMessage('Strumento non trovato');
      return;
    }
    const mergedListings = Array.from(
      new Map(
        ([...(instrument.listings || []), selectedListing] as InstrumentListing[]).map(l => [l.symbol, l])
      ).values()
    );
    await db.instruments.update(selectedInstrumentId, {
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
        const ticker = tickerCol || selectedListing?.symbol || instruments.find(i => i.id === selectedInstrumentId)?.ticker;
        const currency = (currencyCol as Currency) || selectedListing?.currency || Currency.USD;
        if (!ticker) continue;
        await db.prices.put({
          ticker,
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
      const inst = await db.instruments.get(selectedInstrumentId);
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
      if (!confirm('La somma delle percentuali non è 100%. Procedere lo stesso?')) return;
    }
    await db.instruments.update(selectedInstrumentId, { regionAllocation });
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

  const resolveInstrumentForRow = (row: CoverageRow) => {
    if (row.instrumentId != null) {
      return instruments.find(i => i.id === Number(row.instrumentId));
    }
    return instruments.find(i => i.preferredListing?.symbol === row.ticker)
      || instruments.find(i => i.ticker === row.ticker)
      || instruments.find(i => i.listings?.some(l => l.symbol === row.ticker))
      || (row.isin ? instruments.find(i => i.isin === row.isin) : undefined);
  };

  const handleOpenListingsFromCoverage = (row: CoverageRow) => {
    const instrument = resolveInstrumentForRow(row);
    if (instrument?.id) {
      setSelectedInstrumentId(instrument.id);
    }
    const nextIsin = instrument?.isin || row.isin;
    if (nextIsin) {
      setIsinInput(nextIsin);
    }
    listingsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    requestAnimationFrame(() => listingSelectRef.current?.focus());
  };

  return (
    <div className="space-y-8 max-w-4xl animate-fade-in text-textPrimary">
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
              {portfolios.map(p => (
                <option key={p.portfolioId} value={p.portfolioId}>{p.name}</option>
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

      <div className="bg-white p-8 rounded-2xl shadow-lg border border-borderSoft">
        <h2 className="text-xl font-bold mb-6 flex items-center gap-2 text-slate-900">
          <span className="material-symbols-outlined text-primary">database</span>
          Fonti Dati
        </h2>
        <div className="space-y-6">
          <div>
            <label className="block text-sm font-bold text-slate-500 mb-2">EODHD API Key</label>
            <input
              type="password"
              className="w-full border border-borderSoft bg-slate-50 p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none transition-all text-slate-900"
              value={config.eodhdApiKey}
              onChange={e => setConfig({ ...config, eodhdApiKey: e.target.value })}
            />
          </div>
          <div>
            <label className="block text-sm font-bold text-slate-500 mb-2">Price Sheet URL (JSON output)</label>
            <input
              className="w-full border border-borderSoft bg-slate-50 p-3 rounded-xl text-sm text-slate-900 focus:ring-2 focus:ring-primary focus:outline-none transition-all"
              value={config.googleSheetUrl}
              onChange={e => setConfig({ ...config, googleSheetUrl: e.target.value })}
            />
            <p className="text-xs text-gray-500 mt-2 ml-1">L'URL deve puntare a un endpoint pubblico JSON o Google Viz API.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-bold text-slate-500 mb-2">Valuta base</label>
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
              <label className="block text-sm font-bold text-slate-500 mb-2">Ordine exchange preferiti (comma)</label>
              <input
                className="w-full border border-borderSoft bg-slate-50 p-3 rounded-xl text-sm text-slate-900 focus:ring-2 focus:ring-primary focus:outline-none transition-all"
                value={(config.preferredExchangesOrder || ['SW','US','LSE','XETRA','MI','PA']).join(',')}
                onChange={e => setConfig({ ...config, preferredExchangesOrder: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
              />
              <p className="text-xs text-gray-500 mt-2 ml-1">Usato per proporre il listing migliore (SW prioritario con base CHF).</p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-bold text-slate-500 mb-2">Backfill da data</label>
              <input
                type="date"
                className="w-full border border-borderSoft bg-slate-50 p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none transition-all text-slate-900"
                value={config.minHistoryDate || '2020-01-01'}
                onChange={e => setConfig({ ...config, minHistoryDate: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-bold text-slate-500 mb-2">Ambito backfill</label>
              <div className="flex gap-4 text-sm text-slate-700">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="scope"
                    checked={(config.priceBackfillScope || 'current') === 'current'}
                    onChange={() => setConfig({ ...config, priceBackfillScope: 'current' })}
                  />
                  Solo tickers in portafoglio (più veloce)
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="scope"
                    checked={(config.priceBackfillScope || 'current') === 'all'}
                    onChange={() => setConfig({ ...config, priceBackfillScope: 'all' })}
                  />
                  Includi storici venduti (copertura completa)
                </label>
              </div>
            </div>
          </div>
          <div className="bg-slate-50 border border-borderSoft rounded-xl p-4 space-y-3 relative">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-bold text-slate-900">Copertura prezzi (portafoglio attivo)</div>
                <div className="text-xs text-slate-600">
                  Dal {coverage.earliestCoveredDate || 'N/D'} al {coverage.latestCoveredDate || 'N/D'} - Ticker coperti: {coverage.okCount}/{coverage.total}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {coverage.okCount < (coverage.total || 1) && (
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
                        <li>Per estendere lo storico: usa “Scarica storico prezzi” oppure importa un CSV prezzi dal tuo provider.</li>
                        <li>Lo strumento mostrato (ticker) è il listing usato per i prezzi; se è sbagliato, correggilo in “Listings & FX”.</li>
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
            <div className="overflow-auto max-h-56 border border-borderSoft rounded-lg bg-white">
              <table className="w-full text-sm">
                <thead className="bg-slate-100 text-xs text-slate-600 uppercase">
                  <tr>
                    <th className="px-3 py-2 text-left">Strumento</th>
                    <th className="px-3 py-2 text-left">Dal</th>
                    <th className="px-3 py-2 text-left">Al</th>
                    <th className="px-3 py-2 text-left">Stato</th>
                    <th className="px-3 py-2 text-left">Azioni</th>
                  </tr>
                </thead>
                <tbody>
                  {coverage.perTicker.map((row, index) => (
                    <tr key={`${row.ticker}-${row.instrumentId ?? index}`} className="border-t border-borderSoft">
                      <td className="px-3 py-2">
                        <div className="flex flex-col">
                          <span className="font-semibold text-slate-900">{row.ticker}</span>
                          <span className="text-xs text-slate-600">
                            ISIN: {row.isin || '—'}{row.name ? ` - ${row.name}` : ''}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-slate-700">{row.from}</td>
                      <td className="px-3 py-2 text-slate-700">{row.to}</td>
                      <td className="px-3 py-2">
                        <span className={`text-xs font-bold px-2 py-1 rounded-lg ${
                          row.status === 'OK'
                            ? 'bg-green-100 text-green-700'
                            : row.status === 'PARZIALE'
                              ? 'bg-amber-100 text-amber-700'
                              : 'bg-red-100 text-red-700'
                        }`}>
                          {row.status}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        {row.status !== 'OK' && (
                          <button
                            type="button"
                            className="text-xs font-bold text-[#0052a3] hover:text-blue-500"
                            onClick={() => handleOpenListingsFromCoverage(row)}
                            aria-label={`Apri in Listings & FX per ${row.ticker}`}
                          >
                            Apri in Listings &amp; FX
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {coverage.perTicker.length === 0 && (
                    <tr>
                      <td className="px-3 py-2 text-slate-500 text-sm" colSpan={5}>Nessun ticker da mostrare.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap gap-3 pt-2">
              <button
                onClick={handleBackfill}
                disabled={bfLoading}
                className="bg-[#0052a3] text-white px-6 py-3 rounded-xl text-sm font-bold disabled:opacity-50 hover:bg-blue-600 transition shadow-lg hover:shadow-primary/30 flex items-center gap-2"
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
              {bfStatus && <div className="text-xs text-slate-600 font-medium">{bfStatus}</div>}
            </div>
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
                          ? 'Il listing selezionato è in valuta estera. Per mostrare valori in CHF servono tassi FX (USD→CHF, EUR→CHF, GBP→CHF).'
                          : 'Listing OK'
                    }
                  >
                    <span className="material-symbols-outlined text-[16px]">
                      {isSixFirst ? 'check_circle' : needsFx ? 'warning' : 'info'}
                    </span>
                    {isSixFirst ? 'SIX-first attivo ✅' : needsFx ? 'Listing estero (serve FX) ⚠️' : 'Listing OK'}
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
                      <li>Salva sempre il listing preferito prima di importare prezzi, così l'import finisce sul ticker corretto.</li>
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
                          <summary className="cursor-pointer text-[#0052a3] font-bold">Cos’è SIX-first?</summary>
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
                  onChange={e => setSelectedInstrumentId(e.target.value ? Number(e.target.value) : undefined)}
                >
                  {instruments.map((i, idx) => {
                    const key = i.id ?? `${i.ticker || 'inst'}-${idx}`;
                    return (
                      <option key={key} value={i.id ?? ''}>{i.ticker}{i.name ? ` - ${i.name}` : ''}</option>
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
                      <p>Se non definite, la Dashboard mostrerà “Non definito”.</p>
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
                      <span className="text-xs text-slate-600">{l.exchangeCode} • {l.currency}</span>
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
          <div className="flex flex-wrap gap-3 pt-4">
            <button onClick={handleSave} className="bg-[#0052a3] text-white px-6 py-3 rounded-xl text-sm font-bold hover:bg-blue-600 transition shadow-lg hover:shadow-primary/30">
              Salva Configurazione
            </button>
            <button
              onClick={handleSync}
              disabled={loading}
              className="bg-[#0052a3] text-white px-6 py-3 rounded-xl text-sm font-bold disabled:opacity-50 hover:bg-blue-600 transition shadow-lg hover:shadow-primary/30 flex items-center gap-2"
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
              onClick={handleExport}
              className="bg-slate-100 text-slate-700 px-6 py-3 rounded-xl text-sm font-bold hover:bg-slate-200 transition border border-borderSoft"
            >
              Export Backup
            </button>
            <button
              onClick={handleImportClick}
              className="bg-white text-slate-700 px-6 py-3 rounded-xl text-sm font-bold hover:bg-slate-50 transition border border-borderSoft"
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

      {/* DANGER ZONE */}
      <div className="bg-red-50 p-8 rounded-2xl shadow-sm border border-red-200">
        <h2 className="text-lg font-bold text-red-700 mb-2 flex items-center gap-2">
          <span className="material-symbols-outlined">warning</span>
          Zona Pericolo
        </h2>
        <p className="text-sm text-red-700/70 mb-6 leading-relaxed">
          Se l'applicazione non visualizza i dati corretti o hai conflitti con versioni precedenti, puoi resettare il database.
          Questo cancellerà tutto e ricaricherà i dati demo.
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

