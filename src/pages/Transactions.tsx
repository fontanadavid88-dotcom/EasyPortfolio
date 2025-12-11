import React, { useState, useMemo, useEffect } from 'react';
import { db } from '../db';
import { useLiveQuery } from 'dexie-react-hooks';
import { TransactionType, Currency, Transaction, AssetType } from '../types';

interface GroupedAsset {
  ticker: string;
  transactions: Transaction[];
  quantity: number;
  avgPrice: number;
  currentPrice: number;
  currentValue: number;
  currency: Currency;
  pnl: number;
  pnlPercent: number;
}

export const Transactions: React.FC = () => {
  const transactions = useLiveQuery(() => db.transactions.orderBy('date').reverse().toArray());
  const prices = useLiveQuery(() => db.prices.toArray());
  
  const [expandedTicker, setExpandedTicker] = useState<string | null>(null);
  const [isAssetModalOpen, setAssetModalOpen] = useState(false);
  const [assetForm, setAssetForm] = useState({
    ticker: '',
    name: '',
    type: AssetType.Stock,
    quantity: 0,
    price: 0,
    fees: 0,
    date: new Date().toISOString().split('T')[0],
    currency: Currency.USD
  });
  const [tickerSearchResults, setTickerSearchResults] = useState<{t: string, ex: string}[]>([]);
  const [isTxModalOpen, setTxModalOpen] = useState(false);
  const [activeAssetForTx, setActiveAssetForTx] = useState<string | null>(null);
  const [txForm, setTxForm] = useState({
    date: new Date().toISOString().split('T')[0],
    type: TransactionType.Buy,
    qty: 0,
    price: 0,
    fees: 0,
    currency: Currency.CHF
  });

  useEffect(() => {
    if (assetForm.ticker.length < 2) {
        setTickerSearchResults([]);
        return;
    }
    const base = assetForm.ticker.toUpperCase().split('.')[0];
    setTickerSearchResults([
        { t: `${base}.US`, ex: 'US Market (Nasdaq/NYSE)' },
        { t: `${base}.MI`, ex: 'Borsa Italiana' },
        { t: `${base}.DE`, ex: 'Xetra (Germany)' },
        { t: `${base}.L`, ex: 'London Stock Exchange' },
        { t: `${base}.PA`, ex: 'Euronext Paris' },
        { t: `${base}.SW`, ex: 'SIX Swiss Exchange' },
    ]);
  }, [assetForm.ticker]);

  const groupedAssets = useMemo(() => {
    if (!transactions) return [];

    const groups: Record<string, GroupedAsset> = {};
    const sortedTx = [...transactions].sort((a, b) => a.date.getTime() - b.date.getTime());

    sortedTx.forEach(t => {
      const ticker = t.instrumentTicker || 'CASH';
      if (!groups[ticker]) {
        groups[ticker] = {
          ticker,
          transactions: [],
          quantity: 0,
          avgPrice: 0,
          currentPrice: 0,
          currentValue: 0,
          currency: t.currency,
          pnl: 0,
          pnlPercent: 0
        };
      }
      groups[ticker].transactions.push(t);

      if (t.type === TransactionType.Buy) {
        const totalValue = (groups[ticker].quantity * groups[ticker].avgPrice) + (t.quantity * t.price);
        const newQty = groups[ticker].quantity + t.quantity;
        groups[ticker].avgPrice = totalValue / newQty;
        groups[ticker].quantity = newQty;
      } else if (t.type === TransactionType.Sell) {
        groups[ticker].quantity -= t.quantity;
      }
    });

    return Object.values(groups).map(g => {
        const latestPriceObj = prices
            ?.filter(p => p.ticker === g.ticker)
            .sort((a,b) => b.date.localeCompare(a.date))[0];
        
        g.currentPrice = latestPriceObj?.close || g.avgPrice;
        g.currentValue = g.quantity * g.currentPrice;
        g.pnl = (g.currentPrice - g.avgPrice) * g.quantity;
        g.pnlPercent = g.avgPrice > 0 ? (g.pnl / (g.quantity * g.avgPrice)) * 100 : 0;
        g.transactions.reverse();
        
        return g;
    }).sort((a, b) => b.currentValue - a.currentValue);

  }, [transactions, prices]);

  const handleOpenTxModal = (ticker: string) => {
    setActiveAssetForTx(ticker);
    setTxForm({
        date: new Date().toISOString().split('T')[0],
        type: TransactionType.Buy,
        qty: 0,
        price: 0,
        fees: 0,
        currency: Currency.CHF 
    });
    setTxModalOpen(true);
  };

  const handleSaveTransaction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeAssetForTx) return;

    await db.transactions.add({
      date: new Date(txForm.date),
      type: txForm.type,
      instrumentTicker: activeAssetForTx,
      quantity: Number(txForm.qty),
      price: Number(txForm.price),
      currency: txForm.currency,
      fees: Number(txForm.fees),
      account: 'Default'
    });
    setTxModalOpen(false);
  };

  const handleSaveAsset = async (e: React.FormEvent) => {
    e.preventDefault();
    const tickerUpper = assetForm.ticker.toUpperCase();

    await db.instruments.add({
        ticker: tickerUpper,
        name: assetForm.name,
        type: assetForm.type,
        currency: assetForm.currency,
        targetAllocation: 0 
    });

    if (assetForm.quantity > 0) {
        await db.transactions.add({
            date: new Date(assetForm.date),
            type: TransactionType.Buy,
            instrumentTicker: tickerUpper,
            quantity: Number(assetForm.quantity),
            price: Number(assetForm.price),
            fees: Number(assetForm.fees),
            currency: assetForm.currency,
            account: 'Default'
        });
    }

    setAssetForm({ 
        ticker: '', 
        name: '', 
        type: AssetType.Stock, 
        quantity: 0, 
        price: 0, 
        fees: 0,
        date: new Date().toISOString().split('T')[0],
        currency: Currency.USD
    });
    setAssetModalOpen(false);
  };

  const toggleGroup = (ticker: string) => {
    setExpandedTicker(expandedTicker === ticker ? null : ticker);
  };

  const selectTickerSuggestion = (suggestion: string) => {
    setAssetForm({...assetForm, ticker: suggestion});
    setTickerSearchResults([]); 
  };

  return (
    <div className="space-y-6 relative">
      {/* Header & Add Asset Button */}
      <div className="flex justify-between items-center bg-panel p-6 rounded-xl shadow-card border border-panel-border sticky top-4 z-10 backdrop-blur-md bg-opacity-90">
        <h2 className="text-xl font-bold text-panel-text flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">receipt_long</span>
            Registro Transazioni
        </h2>
        <button 
          onClick={() => setAssetModalOpen(true)}
          className="bg-primary text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:bg-primary/90 transition-colors shadow-lg shadow-primary/20 flex items-center gap-2"
        >
          <span className="material-symbols-outlined text-[20px]">add_circle</span>
          Nuovo Asset
        </button>
      </div>

      {/* --- MODAL: ADD ASSET & INITIAL BUY --- */}
      {isAssetModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-shell/80 backdrop-blur-sm animate-fade-in">
            <div className="bg-panel rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden max-h-[90vh] overflow-y-auto border border-panel-border">
                <div className="p-6 border-b border-panel-border flex justify-between items-center sticky top-0 bg-panel z-10">
                    <h3 className="text-lg font-bold text-panel-text">Aggiungi Strumento</h3>
                    <button onClick={() => setAssetModalOpen(false)} className="text-panel-muted hover:text-panel-text">
                        <span className="material-symbols-outlined">close</span>
                    </button>
                </div>
                <form onSubmit={handleSaveAsset} className="p-6 space-y-5">
                    {/* Ticker Section */}
                    <div className="relative">
                        <label className="block text-xs font-bold text-panel-muted uppercase mb-1.5">Ticker / ISIN</label>
                        <input 
                            placeholder="Es. AAPL" required 
                            value={assetForm.ticker}
                            onChange={e => setAssetForm({...assetForm, ticker: e.target.value})}
                            className="w-full border border-panel-border bg-gray-50 p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none uppercase font-mono text-sm text-panel-text"
                            autoComplete="off"
                        />
                        {/* Search Preview Dropdown */}
                        {tickerSearchResults.length > 0 && (
                            <div className="absolute top-full left-0 right-0 bg-panel border border-panel-border rounded-xl shadow-lg mt-1 z-20 max-h-48 overflow-y-auto">
                                <div className="p-2 text-xs text-panel-muted font-medium bg-gray-50">Suggerimenti Borsa</div>
                                {tickerSearchResults.map((res) => (
                                    <div 
                                        key={res.t}
                                        onClick={() => selectTickerSuggestion(res.t)}
                                        className="px-4 py-2 hover:bg-primary/5 cursor-pointer flex justify-between items-center group"
                                    >
                                        <span className="font-bold text-panel-text">{res.t}</span>
                                        <span className="text-xs text-panel-muted group-hover:text-primary">{res.ex}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                    
                    <div>
                        <label className="block text-xs font-bold text-panel-muted uppercase mb-1.5">Nome Strumento</label>
                        <input 
                            placeholder="Nome completo" required 
                            value={assetForm.name}
                            onChange={e => setAssetForm({...assetForm, name: e.target.value})}
                            className="w-full border border-panel-border bg-gray-50 p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none text-sm text-panel-text"
                        />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-xs font-bold text-panel-muted uppercase mb-1.5">Tipo</label>
                            <select 
                                value={assetForm.type}
                                onChange={e => setAssetForm({...assetForm, type: e.target.value as AssetType})}
                                className="w-full border border-panel-border bg-gray-50 p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none text-sm text-panel-text"
                            >
                                {Object.values(AssetType).map(t => <option key={t} value={t}>{t}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-panel-muted uppercase mb-1.5">Valuta</label>
                            <select 
                                value={assetForm.currency}
                                onChange={e => setAssetForm({...assetForm, currency: e.target.value as Currency})}
                                className="w-full border border-panel-border bg-gray-50 p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none text-sm text-panel-text"
                            >
                                {Object.values(Currency).map(c => <option key={c} value={c}>{c}</option>)}
                            </select>
                        </div>
                    </div>

                    {/* Initial Transaction Section */}
                    <div className="border-t border-panel-border pt-3 mt-2">
                        <p className="text-xs font-bold text-primary uppercase mb-3 flex items-center gap-1">
                            <span className="material-symbols-outlined text-sm">shopping_cart</span>
                            Dettagli Primo Acquisto
                        </p>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-xs font-bold text-panel-muted uppercase mb-1.5">Data</label>
                            <input 
                                type="date" required
                                value={assetForm.date}
                                onChange={e => setAssetForm({...assetForm, date: e.target.value})}
                                className="w-full border border-panel-border bg-gray-50 p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none text-sm text-panel-text"
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-panel-muted uppercase mb-1.5">Quantità</label>
                            <input 
                                type="number" placeholder="0" step="0.0001" required
                                value={assetForm.quantity}
                                onChange={e => setAssetForm({...assetForm, quantity: parseFloat(e.target.value)})}
                                className="w-full border border-panel-border bg-gray-50 p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none text-sm font-mono text-panel-text"
                            />
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-xs font-bold text-panel-muted uppercase mb-1.5">Prezzo Acquisto</label>
                            <input 
                                type="number" placeholder="0.00" step="0.01" required
                                value={assetForm.price}
                                onChange={e => setAssetForm({...assetForm, price: parseFloat(e.target.value)})}
                                className="w-full border border-panel-border bg-gray-50 p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none text-sm font-mono text-panel-text"
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-panel-muted uppercase mb-1.5">Commissioni</label>
                            <input 
                                type="number" placeholder="0.00" step="0.01"
                                value={assetForm.fees}
                                onChange={e => setAssetForm({...assetForm, fees: parseFloat(e.target.value)})}
                                className="w-full border border-panel-border bg-gray-50 p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none text-sm font-mono text-panel-text"
                            />
                        </div>
                    </div>

                    <div className="pt-4">
                        <button type="submit" className="w-full bg-shell-elevated text-white py-3.5 rounded-xl font-medium hover:bg-black transition shadow-lg text-sm">
                            Salva Strumento e Transazione
                        </button>
                    </div>
                </form>
            </div>
        </div>
      )}

      {/* --- MODAL: ADD TRANSACTION (Specific Asset) --- */}
      {isTxModalOpen && activeAssetForTx && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-shell/80 backdrop-blur-sm animate-fade-in">
             <div className="bg-panel rounded-2xl shadow-xl w-full max-w-lg overflow-hidden border border-panel-border">
                <div className="p-6 border-b border-panel-border flex justify-between items-center bg-gray-50">
                    <div>
                        <h3 className="text-lg font-bold text-panel-text">Nuova Operazione</h3>
                        <p className="text-xs text-primary font-bold uppercase tracking-wider mt-0.5">{activeAssetForTx}</p>
                    </div>
                    <button onClick={() => setTxModalOpen(false)} className="text-panel-muted hover:text-panel-text">
                        <span className="material-symbols-outlined">close</span>
                    </button>
                </div>
                <form onSubmit={handleSaveTransaction} className="p-6 space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-xs font-bold text-panel-muted uppercase mb-1.5">Data</label>
                            <input 
                                type="date" 
                                className="w-full border border-panel-border bg-white p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none text-sm text-panel-text"
                                value={txForm.date}
                                onChange={e => setTxForm({...txForm, date: e.target.value})}
                                required
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-panel-muted uppercase mb-1.5">Tipo</label>
                            <select 
                                className="w-full border border-panel-border bg-white p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none text-sm text-panel-text"
                                value={txForm.type}
                                onChange={e => setTxForm({...txForm, type: e.target.value as TransactionType})}
                            >
                                {Object.values(TransactionType).map(t => <option key={t} value={t}>{t}</option>)}
                            </select>
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-xs font-bold text-panel-muted uppercase mb-1.5">Prezzo Unitario</label>
                            <input 
                                type="number" placeholder="0.00" 
                                className="w-full border border-panel-border bg-white p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none text-sm font-mono text-panel-text"
                                step="0.01"
                                value={txForm.price}
                                onChange={e => setTxForm({...txForm, price: parseFloat(e.target.value)})}
                                required
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-panel-muted uppercase mb-1.5">Quantità</label>
                            <input 
                                type="number" placeholder="0" 
                                className="w-full border border-panel-border bg-white p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none text-sm font-mono text-panel-text"
                                step="0.0001"
                                value={txForm.qty}
                                onChange={e => setTxForm({...txForm, qty: parseFloat(e.target.value)})}
                                required
                            />
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-xs font-bold text-panel-muted uppercase mb-1.5">Commissioni</label>
                            <input 
                                type="number" placeholder="0.00" 
                                className="w-full border border-panel-border bg-white p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none text-sm font-mono text-panel-text"
                                step="0.01"
                                value={txForm.fees}
                                onChange={e => setTxForm({...txForm, fees: parseFloat(e.target.value)})}
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-panel-muted uppercase mb-1.5">Valuta</label>
                            <select 
                                className="w-full border border-panel-border bg-white p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none text-sm text-panel-text"
                                value={txForm.currency}
                                onChange={e => setTxForm({...txForm, currency: e.target.value as Currency})}
                            >
                                {Object.values(Currency).map(c => <option key={c} value={c}>{c}</option>)}
                            </select>
                        </div>
                    </div>

                    <div className="pt-4">
                        <button type="submit" className="w-full bg-primary text-white py-3.5 rounded-xl font-medium hover:bg-primary/90 transition shadow-lg text-sm">
                            Registra Movimento
                        </button>
                    </div>
                </form>
             </div>
        </div>
      )}

      {/* Accordion List */}
      <div className="space-y-3">
        {groupedAssets.map(group => (
            <div key={group.ticker} className="bg-panel rounded-xl shadow-sm border border-panel-border overflow-hidden transition-all hover:shadow-card hover:border-primary/20">
                
                {/* Summary Header */}
                <div 
                    onClick={() => toggleGroup(group.ticker)}
                    className="p-4 flex items-center justify-between cursor-pointer hover:bg-gray-50 select-none"
                >
                    <div className="flex items-center gap-4">
                        <div className={`p-2.5 rounded-full ${expandedTicker === group.ticker ? 'bg-primary/10 text-primary' : 'bg-gray-100 text-panel-muted'}`}>
                             {group.ticker === 'CASH' 
                                ? <span className="material-symbols-outlined text-[20px]">payments</span> 
                                : <span className="material-symbols-outlined text-[20px]">candlestick_chart</span>
                             }
                        </div>
                        <div>
                            <h3 className="font-bold text-panel-text text-sm">{group.ticker}</h3>
                            <p className="text-xs text-panel-muted">{group.quantity.toLocaleString()} quote • Avg: {group.avgPrice.toFixed(2)} {group.currency}</p>
                        </div>
                    </div>

                    <div className="flex items-center gap-6">
                        <div className="text-right hidden sm:block">
                            <p className="text-sm font-bold text-panel-text tracking-tight">{group.currentValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {group.currency}</p>
                            <p className={`text-xs font-bold ${group.pnl >= 0 ? 'text-positive' : 'text-negative'}`}>
                                {group.pnl >= 0 ? '+' : ''}{group.pnl.toLocaleString(undefined, {maximumFractionDigits: 0})} ({group.pnlPercent.toFixed(1)}%)
                            </p>
                        </div>
                        <span className={`material-symbols-outlined text-panel-muted transition-transform duration-300 ${expandedTicker === group.ticker ? 'rotate-180' : ''}`}>
                            expand_more
                        </span>
                    </div>
                </div>

                {/* Expanded Transactions Table */}
                {expandedTicker === group.ticker && (
                    <div className="bg-gray-50 border-t border-panel-border animate-fade-in">
                        <table className="w-full text-sm text-left">
                            <thead className="text-xs text-panel-muted uppercase bg-gray-100/50 border-b border-panel-border">
                                <tr>
                                    <th className="px-6 py-2">Data</th>
                                    <th className="px-6 py-2">Tipo</th>
                                    <th className="px-6 py-2 text-right">Prezzo</th>
                                    <th className="px-6 py-2 text-right">Qtà</th>
                                    <th className="px-6 py-2 text-right">Comm.</th>
                                    <th className="px-6 py-2 text-right">Totale</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200/50">
                                {group.transactions.map(t => (
                                    <tr key={t.id} className="hover:bg-gray-100 transition-colors">
                                        <td className="px-6 py-3 font-medium text-panel-text">{new Date(t.date).toLocaleDateString('it-IT')}</td>
                                        <td className="px-6 py-3">
                                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                                                t.type === TransactionType.Buy ? 'bg-positive/10 text-positive' : 
                                                t.type === TransactionType.Sell ? 'bg-negative/10 text-negative' : 
                                                'bg-primary/10 text-primary'
                                            }`}>
                                                {t.type === TransactionType.Buy ? 'Acquisto' : t.type === TransactionType.Sell ? 'Vendita' : t.type}
                                            </span>
                                        </td>
                                        <td className="px-6 py-3 text-right text-panel-text font-mono">{t.price.toFixed(2)}</td>
                                        <td className="px-6 py-3 text-right text-panel-text font-mono">{t.quantity}</td>
                                        <td className="px-6 py-3 text-right text-panel-muted text-xs font-mono">{t.fees > 0 ? t.fees.toFixed(2) : '-'}</td>
                                        <td className="px-6 py-3 text-right font-semibold text-panel-text font-mono">{(t.quantity * t.price).toFixed(2)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        <div className="p-2 text-center border-t border-panel-border">
                            <button 
                                onClick={() => handleOpenTxModal(group.ticker)}
                                className="text-xs text-primary font-bold uppercase tracking-wide hover:underline flex items-center justify-center gap-1 w-full py-2 hover:bg-primary/5 rounded transition-colors"
                            >
                                <span className="material-symbols-outlined text-[18px]">add</span> Registra acquisto / vendita
                            </button>
                        </div>
                    </div>
                )}
            </div>
        ))}

        {!transactions?.length && (
            <div className="text-center py-16 text-panel-muted bg-panel rounded-2xl border border-dashed border-panel-border">
                <span className="material-symbols-outlined text-4xl mb-3 opacity-30">receipt_long</span>
                <p>Nessuna transazione presente.</p>
                <p className="text-sm">Inizia aggiungendo il tuo primo strumento con il tasto in alto.</p>
            </div>
        )}
      </div>
    </div>
  );
};