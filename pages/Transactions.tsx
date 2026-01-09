import React, { useState, useMemo, useEffect, useRef } from 'react';
import { db, getCurrentPortfolioId } from '../db';
import { useLiveQuery } from 'dexie-react-hooks';
import { TransactionType, Currency, Transaction, AssetType, AssetClass } from '../types';
import {
    PRIMARY_BLUE,
    ACCENT_ORANGE,
    POSITIVE_GREEN,
    NEGATIVE_RED,
    NEUTRAL_TEXT,
    NEUTRAL_MUTED,
    CARD_BG,
    BORDER_COLOR,
    PAGE_BG
} from '../constants';
import clsx from 'clsx';

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
    const currentPortfolioId = getCurrentPortfolioId();
    const transactions = useLiveQuery(
        () => db.transactions
            .where('portfolioId')
            .equals(currentPortfolioId)
            .sortBy('date')
            .then(list => list.reverse()),
        [currentPortfolioId],
        []
    );
    const prices = useLiveQuery(
        () => db.prices.where('portfolioId').equals(currentPortfolioId).toArray(),
        [currentPortfolioId],
        []
    );

    // -- Global State --
    const [expandedTicker, setExpandedTicker] = useState<string | null>(null);

    // -- Add Asset Modal State --
    const [isAssetModalOpen, setAssetModalOpen] = useState(false);
    const [assetForm, setAssetForm] = useState({
        ticker: '',
        name: '',
        type: AssetType.Stock,
        assetClass: AssetClass.STOCK,
        quantity: 0,
        price: 0,
        fees: 0,
        date: new Date().toISOString().split('T')[0],
        currency: Currency.USD
    });
    const [tickerSearchResults, setTickerSearchResults] = useState<{ t: string, ex: string }[]>([]);
    const [suppressSuggestions, setSuppressSuggestions] = useState(false);
    const [isTickerDropdownOpen, setTickerDropdownOpen] = useState(false);
    const tickerInputRef = useRef<HTMLInputElement | null>(null);
    const tickerDropdownRef = useRef<HTMLDivElement | null>(null);
    const assetDateRef = useRef<HTMLInputElement | null>(null);

    // -- Add/Edit Transaction Modal State --
    const [isTxModalOpen, setTxModalOpen] = useState(false);
    const [activeAssetForTx, setActiveAssetForTx] = useState<string | null>(null);
    const [editingTxId, setEditingTxId] = useState<number | null>(null); // If null -> New Mode, else -> Edit Mode
    const [txForm, setTxForm] = useState({
        date: new Date().toISOString().split('T')[0],
        type: TransactionType.Buy,
        qty: 0,
        price: 0,
        fees: 0,
        currency: Currency.CHF
    });

    // -- Helpers for Asset Search --
    useEffect(() => {
        if (suppressSuggestions) {
            setSuppressSuggestions(false);
            setTickerDropdownOpen(false);
            return;
        }
        if (assetForm.ticker.length < 2) {
            setTickerSearchResults([]);
            setTickerDropdownOpen(false);
            return;
        }
        const base = assetForm.ticker.toUpperCase().split('.')[0];
        const results = [
            { t: `${base}.US`, ex: 'US Market (Nasdaq/NYSE)' },
            { t: `${base}.MI`, ex: 'Borsa Italiana' },
            { t: `${base}.DE`, ex: 'Xetra (Germany)' },
            { t: `${base}.L`, ex: 'London Stock Exchange' },
            { t: `${base}.PA`, ex: 'Euronext Paris' },
            { t: `${base}.SW`, ex: 'SIX Swiss Exchange' },
        ];
        setTickerSearchResults(results);
        setTickerDropdownOpen(results.length > 0);
    }, [assetForm.ticker, suppressSuggestions]);

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as Node;
            if (!tickerDropdownRef.current || !tickerInputRef.current) return;
            if (!tickerDropdownRef.current.contains(target) && !tickerInputRef.current.contains(target)) {
                setTickerDropdownOpen(false);
            }
        };
        const handleKeydown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' || e.key === 'Tab') {
                setTickerDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('keydown', handleKeydown);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('keydown', handleKeydown);
        };
    }, []);

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as Node;
            if (!tickerDropdownRef.current || !tickerInputRef.current) return;
            if (!tickerDropdownRef.current.contains(target) && !tickerInputRef.current.contains(target)) {
                setTickerDropdownOpen(false);
            }
        };
        const handleKeydown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' || e.key === 'Tab') {
                setTickerDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('keydown', handleKeydown);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('keydown', handleKeydown);
        };
    }, []);

    // -- Grouping Logic --
    const groupedAssets = useMemo(() => {
        if (!transactions) return [];

        const groups: Record<string, GroupedAsset> = {};
        // Sort logic remains valid
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
                groups[ticker].avgPrice = newQty > 0 ? totalValue / newQty : 0;
                groups[ticker].quantity = newQty;
            } else if (t.type === TransactionType.Sell) {
                groups[ticker].quantity -= t.quantity;
            }
        });

        return Object.values(groups).map(g => {
            const latestPriceObj = (prices ?? [])
                .filter(p => p.ticker === g.ticker && p.date)
                .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0];

            g.currentPrice = latestPriceObj?.close || g.avgPrice;
            g.currentValue = g.quantity * g.currentPrice;
            g.pnl = (g.currentPrice - g.avgPrice) * g.quantity;
            g.pnlPercent = (g.quantity * g.avgPrice) !== 0 ? (g.pnl / (g.quantity * g.avgPrice)) * 100 : 0;
            g.transactions.reverse(); // Show newest first in the list

            return g;
        }).sort((a, b) => b.currentValue - a.currentValue);

    }, [transactions, prices]);

    // -- Handlers --

    const handleOpenTxModal = (ticker: string, txToEdit?: Transaction) => {
        setActiveAssetForTx(ticker);

        if (txToEdit) {
            // Edit Mode
            setEditingTxId(txToEdit.id || null);
            setTxForm({
                date: txToEdit.date.toISOString().split('T')[0],
                type: txToEdit.type,
                qty: txToEdit.quantity,
                price: txToEdit.price,
                fees: txToEdit.fees,
                currency: txToEdit.currency
            });
        } else {
            // New Mode
            setEditingTxId(null);
            setTxForm({
                date: new Date().toISOString().split('T')[0],
                type: TransactionType.Buy,
                qty: 0,
                price: 0,
                fees: 0,
                currency: Currency.CHF
            });
        }
        setTxModalOpen(true);
    };

    const handleDeleteTransaction = async (id?: number) => {
        if (!id) return;
        if (window.confirm("Sei sicuro di voler eliminare questa transazione? Questa azione è irreversibile.")) {
            await db.transactions.delete(id);
        }
    };

    const handleSaveTransaction = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!activeAssetForTx) return;

        if (editingTxId) {
            // Update existing
            await db.transactions.update(editingTxId, {
                date: new Date(txForm.date),
                type: txForm.type,
                instrumentTicker: activeAssetForTx,
                quantity: Number(txForm.qty),
                price: Number(txForm.price),
                currency: txForm.currency,
                fees: Number(txForm.fees),
                account: 'Default',
                portfolioId: currentPortfolioId
            });
        } else {
            // Create new
            await db.transactions.add({
                date: new Date(txForm.date),
                type: txForm.type,
                instrumentTicker: activeAssetForTx,
                quantity: Number(txForm.qty),
                price: Number(txForm.price),
                currency: txForm.currency,
                fees: Number(txForm.fees),
                account: 'Default',
                portfolioId: currentPortfolioId
            });
        }
        setTxModalOpen(false);
        setEditingTxId(null);
    };

    const handleSaveAsset = async (e: React.FormEvent) => {
        e.preventDefault();
        const tickerUpper = assetForm.ticker.toUpperCase();

        // 1. Create Instrument
        await db.instruments.add({
            ticker: tickerUpper,
            name: assetForm.name,
            type: assetForm.type,
            assetClass: assetForm.assetClass,
            currency: assetForm.currency,
            targetAllocation: 0,
            portfolioId: currentPortfolioId
        });

        // 2. Create Initial Transaction (if quantity provided)
        if (assetForm.quantity > 0) {
            await db.transactions.add({
                date: new Date(assetForm.date),
                type: TransactionType.Buy,
                instrumentTicker: tickerUpper,
                quantity: Number(assetForm.quantity),
                price: Number(assetForm.price),
                fees: Number(assetForm.fees),
                currency: assetForm.currency,
                account: 'Default',
                portfolioId: currentPortfolioId
            });
        }

        setAssetForm({
            ticker: '',
            name: '',
            type: AssetType.Stock,
            assetClass: AssetClass.STOCK,
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
        setAssetForm({ ...assetForm, ticker: suggestion });
        setTickerSearchResults([]);
        setSuppressSuggestions(true);
        setTickerDropdownOpen(false);
        assetDateRef.current?.focus();
    };

    const handleTickerBlur = () => {
        setTimeout(() => {
            const active = document.activeElement;
            if (tickerDropdownRef.current && active && tickerDropdownRef.current.contains(active)) return;
            if (tickerInputRef.current && active === tickerInputRef.current) return;
            setTickerDropdownOpen(false);
        }, 0);
    };

    return (
        <div className="space-y-6 relative animate-fade-in text-textPrimary">
            {/* Header & Add Asset Button */}
            <div className="flex justify-between items-center bg-white p-6 rounded-2xl shadow-lg border border-borderSoft sticky top-0 z-10 transition-colors">
                <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
                    <span className="material-symbols-outlined text-[#0052a3]">receipt_long</span>
                    Registro Transazioni
                </h2>
                <button
                    onClick={() => setAssetModalOpen(true)}
                    className="text-slate-900 px-5 py-2.5 rounded-xl text-sm font-bold hover:bg-blue-600 transition-all shadow-lg hover:shadow-primary/30 flex items-center gap-2"
                    style={{ backgroundColor: '#0052a3' }}
                >
                    <span className="material-symbols-outlined text-[20px]">add_circle</span>
                    Nuovo Asset
                </button>
            </div>

            {/* --- MODAL: ADD ASSET & INITIAL BUY --- */}
            {isAssetModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
                    <div className="bg-backgroundElevated rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden max-h-[90vh] overflow-y-auto border border-borderSoft">
                        <div className="p-6 border-b border-borderSoft flex justify-between items-center sticky top-0 bg-backgroundElevated z-10">
                            <h3 className="text-lg font-bold text-textPrimary">Aggiungi Strumento</h3>
                            <button onClick={() => setAssetModalOpen(false)} className="text-gray-400 hover:text-slate-900 transition-colors">
                                <span className="material-symbols-outlined">close</span>
                            </button>
                        </div>
                        <form onSubmit={handleSaveAsset} className="p-6 space-y-5">
                            {/* Ticker Section */}
                            <div className="relative">
                                <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">Ticker / ISIN</label>
                                <input
                                    ref={tickerInputRef}
                                    placeholder="Es. AAPL" required
                                    value={assetForm.ticker}
                                    onChange={e => setAssetForm({ ...assetForm, ticker: e.target.value })}
                                    onFocus={() => setTickerDropdownOpen(tickerSearchResults.length > 0 && !suppressSuggestions)}
                                    onBlur={handleTickerBlur}
                                    onKeyDown={e => {
                                        if (e.key === 'Escape' || e.key === 'Tab') {
                                            setTickerDropdownOpen(false);
                                        }
                                    }}
                                    className="w-full border border-borderSoft bg-slate-50 p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none uppercase font-mono text-sm text-slate-900"
                                    autoComplete="off"
                                />
                                {/* Search Preview Dropdown */}
                                {isTickerDropdownOpen && tickerSearchResults.length > 0 && (
                                    <div
                                        ref={tickerDropdownRef}
                                        className="absolute top-full left-0 right-0 bg-backgroundElevated border border-borderSoft rounded-xl shadow-xl mt-1 z-20 max-h-48 overflow-y-auto"
                                    >
                                        <div className="p-2 text-xs text-gray-500 font-medium bg-slate-50/50">Suggerimenti Borsa</div>
                                        {tickerSearchResults.map((res) => (
                                            <div
                                                key={res.t}
                                                onMouseDown={() => selectTickerSuggestion(res.t)}
                                                className="px-4 py-2 hover:bg-white/5 cursor-pointer flex justify-between items-center group transition-colors"
                                            >
                                                <span className="font-bold text-gray-200">{res.t}</span>
                                                <span className="text-xs text-gray-500 group-hover:text-primary">{res.ex}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div>
                                <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">Nome Strumento</label>
                                <input
                                    placeholder="Nome completo" required
                                    value={assetForm.name}
                                    onChange={e => setAssetForm({ ...assetForm, name: e.target.value })}
                                    className="w-full border border-borderSoft bg-slate-50 p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none text-sm text-slate-900"
                                />
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">Tipo</label>
                                    <select
                                        value={assetForm.type}
                                        onChange={e => setAssetForm({ ...assetForm, type: e.target.value as AssetType })}
                                        className="w-full border border-borderSoft bg-slate-50 p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none text-sm text-slate-900"
                                    >
                                        {Object.values(AssetType).map(t => <option key={t} value={t}>{t}</option>)}
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">Valuta</label>
                                    <select
                                        value={assetForm.currency}
                                        onChange={e => setAssetForm({ ...assetForm, currency: e.target.value as Currency })}
                                        className="w-full border border-borderSoft bg-slate-50 p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none text-sm text-slate-900"
                                    >
                                        {Object.values(Currency).map(c => <option key={c} value={c}>{c}</option>)}
                                    </select>
                                </div>
                            </div>

                            {/* Initial Transaction Section */}
                            <div className="border-t border-borderSoft pt-3 mt-2">
                                <p className="text-xs font-bold text-primary uppercase mb-3 flex items-center gap-1">
                                    <span className="material-symbols-outlined text-sm">shopping_cart</span>
                                    Dettagli Primo Acquisto
                                </p>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">Data</label>
                                    <input
                                        ref={assetDateRef}
                                        type="date" required
                                        value={assetForm.date}
                                        onChange={e => setAssetForm({ ...assetForm, date: e.target.value })}
                                        className="w-full border border-borderSoft bg-slate-50 p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none text-sm text-slate-900 dark-date-input"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">Quantità</label>
                                    <input
                                        type="number" placeholder="0" step="0.0001" required
                                        value={assetForm.quantity}
                                        onChange={e => setAssetForm({ ...assetForm, quantity: parseFloat(e.target.value) })}
                                        className="w-full border border-borderSoft bg-slate-50 p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none text-sm font-mono text-slate-900"
                                    />
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">Prezzo Acquisto</label>
                                    <input
                                        type="number" placeholder="0.00" step="0.01" required
                                        value={assetForm.price}
                                        onChange={e => setAssetForm({ ...assetForm, price: parseFloat(e.target.value) })}
                                        className="w-full border border-borderSoft bg-slate-50 p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none text-sm font-mono text-slate-900"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">Commissioni</label>
                                    <input
                                        type="number" placeholder="0.00" step="0.01"
                                        value={assetForm.fees}
                                        onChange={e => setAssetForm({ ...assetForm, fees: parseFloat(e.target.value) })}
                                        className="w-full border border-borderSoft bg-slate-50 p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none text-sm font-mono text-slate-900"
                                    />
                                </div>
                            </div>

                            <div className="pt-4">
                                <button type="submit" className="w-full bg-primary text-slate-900 py-3.5 rounded-xl font-bold hover:bg-blue-600 transition shadow-lg text-sm">
                                    Salva Strumento e Transazione
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* --- MODAL: ADD/EDIT TRANSACTION (Specific Asset) --- */}
            {isTxModalOpen && activeAssetForTx && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
                    <div className="bg-backgroundElevated rounded-2xl shadow-xl w-full max-w-lg overflow-hidden border border-borderSoft">
                        <div className="p-6 border-b border-borderSoft flex justify-between items-center bg-white/5">
                            <div>
                                <h3 className="text-lg font-bold text-textPrimary">
                                    {editingTxId ? 'Modifica Operazione' : 'Nuova Operazione'}
                                </h3>
                                <p className="text-xs text-primary font-bold uppercase tracking-wider mt-0.5">{activeAssetForTx}</p>
                            </div>
                            <button onClick={() => setTxModalOpen(false)} className="text-gray-400 hover:text-slate-900">
                                <span className="material-symbols-outlined">close</span>
                            </button>
                        </div>
                        <form onSubmit={handleSaveTransaction} className="p-6 space-y-4">
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">Data</label>
                                    <input
                                        type="date"
                                        className="w-full border border-borderSoft bg-slate-50 p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none text-sm text-slate-900 dark-date-input"
                                        value={txForm.date}
                                        onChange={e => setTxForm({ ...txForm, date: e.target.value })}
                                        required
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">Tipo</label>
                                    <select
                                        className="w-full border border-borderSoft bg-slate-50 p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none text-sm text-slate-900"
                                        value={txForm.type}
                                        onChange={e => setTxForm({ ...txForm, type: e.target.value as TransactionType })}
                                    >
                                        {Object.values(TransactionType).map(t => <option key={t} value={t}>{t}</option>)}
                                    </select>
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">Prezzo Unitario</label>
                                    <input
                                        type="number" placeholder="0.00"
                                        className="w-full border border-borderSoft bg-slate-50 p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none text-sm font-mono text-slate-900"
                                        step="0.01"
                                        value={txForm.price}
                                        onChange={e => setTxForm({ ...txForm, price: parseFloat(e.target.value) })}
                                        required
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">Quantità</label>
                                    <input
                                        type="number" placeholder="0"
                                        className="w-full border border-borderSoft bg-slate-50 p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none text-sm font-mono text-slate-900"
                                        step="0.0001"
                                        value={txForm.qty}
                                        onChange={e => setTxForm({ ...txForm, qty: parseFloat(e.target.value) })}
                                        required
                                    />
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">Commissioni</label>
                                    <input
                                        type="number" placeholder="0.00"
                                        className="w-full border border-borderSoft bg-slate-50 p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none text-sm font-mono text-slate-900"
                                        step="0.01"
                                        value={txForm.fees}
                                        onChange={e => setTxForm({ ...txForm, fees: parseFloat(e.target.value) })}
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">Valuta</label>
                                    <select
                                        className="w-full border border-borderSoft bg-slate-50 p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none text-sm text-slate-900"
                                        value={txForm.currency}
                                        onChange={e => setTxForm({ ...txForm, currency: e.target.value as Currency })}
                                    >
                                        {Object.values(Currency).map(c => <option key={c} value={c}>{c}</option>)}
                                    </select>
                                </div>
                            </div>

                            <div className="pt-4">
                                <button type="submit" className="w-full bg-primary text-slate-900 py-3.5 rounded-xl font-bold hover:bg-blue-600 transition shadow-lg text-sm">
                                    {editingTxId ? 'Aggiorna Transazione' : 'Registra Movimento'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Accordion List */}
            <div className="space-y-3">
                {groupedAssets.map(group => (
                    <div key={group.ticker} className="bg-white rounded-xl shadow-lg border border-borderSoft overflow-hidden transition-all hover:border-primary/30">

                        {/* Summary Header */}
                        <div
                            onClick={() => toggleGroup(group.ticker)}
                            className="p-4 flex items-center justify-between cursor-pointer hover:bg-slate-50 select-none transition-colors"
                        >
                            <div className="flex items-center gap-4">
                                <div className={clsx(
                                    "p-2.5 rounded-full transition-colors",
                                    expandedTicker === group.ticker ? "bg-[#0052a3]/20 text-[#0052a3]" : "bg-slate-100 text-slate-400"
                                )}>
                                    {group.ticker === 'CASH'
                                        ? <span className="material-symbols-outlined text-[20px]">payments</span>
                                        : <span className="material-symbols-outlined text-[20px]">candlestick_chart</span>
                                    }
                                </div>
                                <div>
                                    <h3 className="font-bold text-slate-900 text-sm">{group.ticker}</h3>
                                    <p className="text-xs text-slate-500">{group.quantity.toLocaleString()} quote • Avg: {group.avgPrice.toFixed(2)} {group.currency}</p>
                                </div>
                            </div>

                            <div className="flex items-center gap-6">
                                <div className="text-right hidden sm:block">
                                    <p className="text-sm font-bold text-slate-900 tracking-tight">{group.currentValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {group.currency}</p>
                                    <p className={clsx("text-xs font-bold", group.pnl >= 0 ? "text-positive" : "text-negative")}>
                                        {group.pnl >= 0 ? '+' : ''}{group.pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })} ({group.pnlPercent.toFixed(1)}%)
                                    </p>
                                </div>
                                <span className={`material-symbols-outlined text-slate-400 transition-transform duration-300 ${expandedTicker === group.ticker ? 'rotate-180' : ''}`}>
                                    expand_more
                                </span>
                            </div>
                        </div>

                        {/* Expanded Transactions Table */}
                        {expandedTicker === group.ticker && (
                            <div className="bg-slate-50 border-t border-borderSoft animate-fade-in">
                                <table className="w-full text-sm text-left">
                                    <thead className="text-xs text-slate-500 uppercase bg-black/5 border-b border-borderSoft">
                                        <tr>
                                            <th className="px-6 py-3 font-semibold">Data</th>
                                            <th className="px-6 py-3 font-semibold">Tipo</th>
                                            <th className="px-6 py-3 font-semibold text-right">Prezzo</th>
                                            <th className="px-6 py-3 font-semibold text-right">Qtà</th>
                                            <th className="px-6 py-3 font-semibold text-right">Comm.</th>
                                            <th className="px-6 py-3 font-semibold text-right">Totale</th>
                                            <th className="px-6 py-3 font-semibold text-center">Azioni</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-borderSoft">
                                        {group.transactions.map(t => (
                                            <tr key={t.id} className="hover:bg-white/60 transition-colors group/row">
                                                <td className="px-6 py-3 font-medium text-slate-900">{new Date(t.date).toLocaleDateString('it-IT')}</td>
                                                <td className="px-6 py-3">
                                                    <span className={clsx(
                                                        "px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider",
                                                        t.type === TransactionType.Buy ? "bg-green-100 text-green-700" :
                                                            t.type === TransactionType.Sell ? "bg-red-100 text-red-700" :
                                                                "bg-blue-100 text-blue-700"
                                                    )}>
                                                        {t.type === TransactionType.Buy ? 'Acquisto' : t.type === TransactionType.Sell ? 'Vendita' : t.type}
                                                    </span>
                                                </td>
                                                <td className="px-6 py-3 text-right text-slate-900 font-mono">{t.price.toFixed(2)}</td>
                                                <td className="px-6 py-3 text-right text-slate-900 font-mono">{t.quantity}</td>
                                                <td className="px-6 py-3 text-right text-slate-500 text-xs font-mono">{t.fees > 0 ? t.fees.toFixed(2) : '-'}</td>
                                                <td className="px-6 py-3 text-right font-bold text-slate-900 font-mono">{(t.quantity * t.price).toFixed(2)}</td>
                                                <td className="px-6 py-3 text-right">
                                                    <div className="flex items-center justify-center gap-1 opacity-100 transition-opacity">
                                                        <button
                                                            onClick={() => handleOpenTxModal(group.ticker, t)}
                                                            className="p-1.5 rounded-lg hover:bg-black/5 text-slate-400 hover:text-primary transition-colors"
                                                            title="Modifica"
                                                        >
                                                            <span className="material-symbols-outlined text-[18px]">edit</span>
                                                        </button>
                                                        <button
                                                            onClick={() => handleDeleteTransaction(t.id)}
                                                            className="p-1.5 rounded-lg hover:bg-black/5 text-slate-400 hover:text-negative transition-colors"
                                                            title="Elimina"
                                                        >
                                                            <span className="material-symbols-outlined text-[18px]">delete</span>
                                                        </button>
                                                    </div>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                                <div className="p-3 text-center border-t border-borderSoft">
                                    <button
                                        onClick={() => handleOpenTxModal(group.ticker)}
                                        className="text-xs text-[#0052a3] font-bold uppercase tracking-wide hover:text-blue-400 flex items-center justify-center gap-1 w-full py-2 hover:bg-white/5 rounded transition-colors"
                                    >
                                        <span className="material-symbols-outlined text-[18px]">add</span> Registra acquisto / vendita
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                ))}

                {!transactions?.length && (
                    <div className="text-center py-16 text-slate-500 bg-white rounded-2xl border border-dashed border-borderSoft">
                        <span className="material-symbols-outlined text-4xl mb-3 opacity-30">receipt_long</span>
                        <p>Nessuna transazione presente.</p>
                        <p className="text-sm">Inizia aggiungendo il tuo primo strumento con il tasto in alto.</p>
                    </div>
                )}
            </div>
        </div>
    );
};

