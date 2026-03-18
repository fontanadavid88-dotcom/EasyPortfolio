import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { db, getCurrentPortfolioId } from '../db';
import { useLiveQuery } from 'dexie-react-hooks';
import { TransactionType, Currency, Transaction, AssetType, AssetClass, Instrument, RegionKey, InstrumentListing } from '../types';
import clsx from 'clsx';
import { getAssetClassLabel, getCanonicalTicker, inferAssetClass } from '../services/financeUtils';
import { resolveListingsByIsin } from '../services/eodhdSearchService';
import { getPriceCoverage, resolvePriceSyncConfig, CoverageRow, getMarketCloseAroundDate, MarketCloseAroundResult } from '../services/priceService';
import { buildPriceTickerConfigWithDefault, planAutoAttachListing } from '../services/priceAttach';
import { isIsin, normalizeIsin, normalizeTicker, resolveEodhdSymbol, hasExchangeSuffix } from '../services/symbolUtils';

interface GroupedAsset {
    ticker: string;
    transactions: Transaction[];
    quantity: number;
    avgPrice: number;
    invested: number;
    currentPrice: number;
    currentValue: number;
    currency: Currency;
    pnl: number;
    pnlPercent: number;
}

const ASSET_TYPE_LABELS: Record<AssetType, string> = {
    [AssetType.Stock]: 'Azioni',
    [AssetType.Bond]: 'Obbligazioni',
    [AssetType.ETF]: 'ETF',
    [AssetType.Crypto]: 'Cripto',
    [AssetType.Cash]: 'Liquidita',
    [AssetType.Commodity]: 'Oro'
};

const TRANSACTION_TYPE_LABELS: Record<TransactionType, string> = {
    [TransactionType.Buy]: 'Acquisto',
    [TransactionType.Sell]: 'Vendita',
    [TransactionType.Dividend]: 'Dividendo',
    [TransactionType.Deposit]: 'Versamento',
    [TransactionType.Withdrawal]: 'Prelievo',
    [TransactionType.Fee]: 'Commissione'
};

const REGION_OPTIONS: { key: RegionKey; label: string }[] = [
    { key: 'CH', label: 'Svizzera' },
    { key: 'NA', label: 'Nord America' },
    { key: 'EU', label: 'Europa' },
    { key: 'AS', label: 'Asia' },
    { key: 'OC', label: 'Oceania' },
    { key: 'LATAM', label: 'America Latina' },
    { key: 'AF', label: 'Africa' },
    { key: 'UNASSIGNED', label: 'Non definito' }
];

const getAssetTypeLabel = (type?: AssetType) => (type ? ASSET_TYPE_LABELS[type] || type : 'N/D');
const getTransactionTypeLabel = (type?: TransactionType) => (type ? TRANSACTION_TYPE_LABELS[type] || type : 'N/D');
const isRegionKey = (value?: string): value is RegionKey => {
    return !!value && REGION_OPTIONS.some(opt => opt.key === value);
};
const getPrimaryRegionInfo = (alloc?: Partial<Record<RegionKey, number>>) => {
    if (!alloc) return { key: '' as RegionKey | '', count: 0 };
    let topKey: RegionKey | '' = '';
    let topPct = -Infinity;
    let count = 0;
    (Object.entries(alloc) as [RegionKey, number][]).forEach(([key, pct]) => {
        if (pct === undefined || pct === null) return;
        count += 1;
        if (pct > topPct) {
            topPct = pct;
            topKey = key;
        }
    });
    return { key: topKey, count };
};

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
    const instruments = useLiveQuery(
        () => db.instruments.where('portfolioId').equals(currentPortfolioId).toArray(),
        [currentPortfolioId],
        []
    );

    const settings = useLiveQuery(
        () => db.settings.where('portfolioId').equals(currentPortfolioId).first(),
        [currentPortfolioId]
    );

    // -- Global State --
    const [expandedTicker, setExpandedTicker] = useState<string | null>(null);
    const [coverageRows, setCoverageRows] = useState<CoverageRow[]>([]);
    const [assetAttachNotice, setAssetAttachNotice] = useState<string>("");
    const [assetInputNotice, setAssetInputNotice] = useState<string>("");
    const navigate = useNavigate();

    const priceTickers = useMemo(() => {
        if (!instruments) return [];
        const unique = new Set<string>();
        instruments.forEach(inst => {
            if (inst.type === AssetType.Cash) return;
            const ticker = getCanonicalTicker(inst);
            if (ticker) unique.add(ticker);
        });
        return Array.from(unique);
    }, [instruments]);

    useEffect(() => {
        if (!settings) {
            setCoverageRows([]);
            return;
        }
        if (priceTickers.length === 0) {
            setCoverageRows([]);
            return;
        }
        const minHistoryDate = settings.minHistoryDate || "2020-01-01";
        getPriceCoverage(currentPortfolioId, priceTickers, minHistoryDate)
            .then(result => setCoverageRows(result.perTicker))
            .catch(() => setCoverageRows([]));
    }, [settings, priceTickers, currentPortfolioId, prices]);

    const coverageByTicker = useMemo(() => {
        return new Map(coverageRows.map(row => [row.ticker, row]));
    }, [coverageRows]);

    // -- Add Asset Modal State --
    const [isAssetModalOpen, setAssetModalOpen] = useState(false);
    const [assetForm, setAssetForm] = useState({
        ticker: '',
        isin: '',
        name: '',
        type: AssetType.Stock,
        assetClass: AssetClass.STOCK,
        quantity: 0,
        price: 0,
        fees: 0,
        date: new Date().toISOString().split('T')[0],
        currency: Currency.USD
    });
    const [isinLookupStatus, setIsinLookupStatus] = useState<'idle' | 'loading' | 'resolved' | 'multiple' | 'none' | 'error'>('idle');
    const [isinLookupMessage, setIsinLookupMessage] = useState('');
    const [isinCandidates, setIsinCandidates] = useState<InstrumentListing[]>([]);
    const [isinResolvedSymbol, setIsinResolvedSymbol] = useState('');
    const [assetMarketHint, setAssetMarketHint] = useState<{ status: 'idle' | 'loading' | MarketCloseAroundResult['status']; data?: MarketCloseAroundResult | null; message?: string }>({ status: 'idle' });
    const [txMarketHint, setTxMarketHint] = useState<{ status: 'idle' | 'loading' | MarketCloseAroundResult['status']; data?: MarketCloseAroundResult | null; message?: string }>({ status: 'idle' });
    const [forceAssetEodhd, setForceAssetEodhd] = useState(false);
    const [forceTxEodhd, setForceTxEodhd] = useState(false);
    const assetMarketHintReq = useRef(0);
    const txMarketHintReq = useRef(0);

    const numberValue = (value: number) => (Number.isFinite(value) ? value : "");
    const parseNumberInput = (value: string) => { const trimmed = value.trim(); if (!trimmed) return NaN; const parsed = parseFloat(trimmed); return Number.isFinite(parsed) ? parsed : NaN; };
    const normalizedTicker = normalizeTicker(assetForm.ticker);
    const normalizedIsin = normalizeIsin(assetForm.isin);
    const resolvedTicker = resolveEodhdSymbol(normalizedTicker, assetForm.type);
    const tickerLooksIsin = Boolean(normalizedTicker) && isIsin(normalizedTicker);
    const isinInvalid = Boolean(normalizedIsin) && !isIsin(normalizedIsin);
    const missingExchange = Boolean(normalizedTicker) && !tickerLooksIsin && !hasExchangeSuffix(resolvedTicker) && assetForm.type !== AssetType.Crypto;
    const canSaveAsset = Boolean(resolvedTicker) && !tickerLooksIsin && !isinInvalid && !missingExchange;
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

    // -- Edit Asset Modal State --
    const [isEditAssetModalOpen, setEditAssetModalOpen] = useState(false);
    const [editingAsset, setEditingAsset] = useState<Instrument | null>(null);
    const [editAssetForm, setEditAssetForm] = useState({
        name: '',
        type: AssetType.Stock,
        assetClass: AssetClass.STOCK,
        currency: Currency.CHF,
        sector: '',
        region: '' as RegionKey | ''
    });
    const [editAssetInitialRegion, setEditAssetInitialRegion] = useState<RegionKey | ''>('');

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

    const instrumentByTicker = useMemo(() => {
        return new Map((instruments || []).map(inst => [inst.ticker, inst]));
    }, [instruments]);

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
                    invested: 0,
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
                groups[ticker].invested += (t.quantity * t.price) + (t.fees || 0);
            } else if (t.type === TransactionType.Sell) {
                groups[ticker].quantity -= t.quantity;
                groups[ticker].invested -= (t.quantity * t.price) - (t.fees || 0);
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
    const handleOpenEditAsset = (instrument: Instrument) => {
        const inferredClass = instrument.assetClass || inferAssetClass(instrument);
        const regionInfo = getPrimaryRegionInfo(instrument.regionAllocation);
        const regionValue = regionInfo.count > 1
            ? ''
            : (regionInfo.key || (isRegionKey(instrument.region) ? instrument.region : ''));
        const initialRegion = regionInfo.count === 0 && regionValue ? '' : regionValue;
        setEditingAsset(instrument);
        setEditAssetForm({
            name: instrument.name || instrument.ticker,
            type: instrument.type || AssetType.Stock,
            assetClass: inferredClass,
            currency: instrument.currency || Currency.CHF,
            sector: instrument.sector || '',
            region: regionValue
        });
        setEditAssetInitialRegion(initialRegion);
        setEditAssetModalOpen(true);
    };

    const handleCloseEditAsset = () => {
        setEditAssetModalOpen(false);
        setEditingAsset(null);
        setEditAssetInitialRegion('');
    };

    const handleSaveAssetMeta = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (!editingAsset) return;
        const payload: Partial<Instrument> = {
            name: editAssetForm.name.trim(),
            type: editAssetForm.type,
            assetClass: editAssetForm.assetClass,
            currency: editAssetForm.currency,
            sector: editAssetForm.sector.trim() || undefined
        };

        const regionChanged = editAssetForm.region !== editAssetInitialRegion;
        if (regionChanged) {
            const regionValue = editAssetForm.region || undefined;
            payload.region = regionValue;
            payload.regionAllocation = regionValue
                ? ({ [regionValue]: 100 } as Partial<Record<RegionKey, number>>)
                : undefined;
        }

        if (editingAsset.id) {
            await db.instruments.update(editingAsset.id, payload);
        } else {
            const existing = await db.instruments.where('ticker').equals(editingAsset.ticker).first();
            if (existing?.id) await db.instruments.update(existing.id, payload);
        }

        handleCloseEditAsset();
    };

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
        const qtyValue = Number.isFinite(txForm.qty) ? txForm.qty : 0;
        const priceValue = Number.isFinite(txForm.price) ? txForm.price : 0;
        const feesValue = Number.isFinite(txForm.fees) ? txForm.fees : 0;

        if (editingTxId) {
            // Update existing
            await db.transactions.update(editingTxId, {
                date: new Date(txForm.date),
                type: txForm.type,
                instrumentTicker: activeAssetForTx,
                quantity: Number(qtyValue),
                price: Number(priceValue),
                currency: txForm.currency,
                fees: Number(feesValue),
                account: 'Default',
                portfolioId: currentPortfolioId
            });
        } else {
            // Create new
            await db.transactions.add({
                date: new Date(txForm.date),
                type: txForm.type,
                instrumentTicker: activeAssetForTx,
                quantity: Number(qtyValue),
                price: Number(priceValue),
                currency: txForm.currency,
                fees: Number(feesValue),
                account: 'Default',
                portfolioId: currentPortfolioId
            });
        }
        setTxModalOpen(false);
        setEditingTxId(null);
    };

    const handleSaveAsset = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!canSaveAsset) {
            setAssetInputNotice("Correggi gli errori prima di salvare.");
            return;
        }
        const tickerUpper = resolvedTicker;
        const isinValue = normalizedIsin;
        let attachWarning = "";
        let preferredListing = undefined as Instrument["preferredListing"];
        let listings = undefined as Instrument["listings"];

        if (isinValue) {
            try {
                const listingsResult = await resolveListingsByIsin(isinValue, settings?.eodhdApiKey);
                if (listingsResult.length > 0) {
                    const plan = planAutoAttachListing({
                        typedTicker: resolvedTicker,
                        listings: listingsResult,
                        preferredExchangesOrder: settings?.preferredExchangesOrder || ["SW", "US", "LSE", "XETRA", "MI", "PA"],
                        baseCurrency: settings?.baseCurrency || Currency.CHF,
                        confirmOverride: (message) => window.confirm(message)
                    });
                    preferredListing = plan.preferredListing;
                    listings = plan.listings;
                    if (plan.warning) attachWarning = plan.warning;
                } else {
                    attachWarning = "Nessun listing trovato per questo ISIN. Puoi configurarlo in Settings.";
                }
            } catch (err: any) {
                attachWarning = err?.message || "Lookup listing non riuscito. Puoi configurarlo in Settings.";
            }
        } else {
            attachWarning = "Suggerimento: aggiungi un ISIN per agganciare automaticamente il listing in Settings.";
        }

        await db.instruments.add({
            ticker: tickerUpper,
            name: assetForm.name,
            type: assetForm.type,
            assetClass: assetForm.assetClass,
            currency: assetForm.currency,
            targetAllocation: 0,
            isin: isinValue || undefined,
            preferredListing,
            listings,
            portfolioId: currentPortfolioId
        });

        if (preferredListing) {
            await db.instrumentListings.put({
                isin: isinValue || "",
                exchangeCode: preferredListing.exchangeCode,
                symbol: preferredListing.symbol,
                currency: preferredListing.currency,
                name: preferredListing.name,
                portfolioId: currentPortfolioId
            });
            if (settings) {
                const { config, changed } = buildPriceTickerConfigWithDefault(
                    settings.priceTickerConfig,
                    preferredListing.symbol,
                    { provider: "EODHD", eodhdSymbol: preferredListing.symbol }
                );
                if (changed) {
                    await db.settings.put({ ...settings, priceTickerConfig: config });
                }
            }
        }

        const qtyValue = Number.isFinite(assetForm.quantity) ? assetForm.quantity : 0;
        const priceValue = Number.isFinite(assetForm.price) ? assetForm.price : 0;
        const feesValue = Number.isFinite(assetForm.fees) ? assetForm.fees : 0;

        if (qtyValue > 0) {
            await db.transactions.add({
                date: new Date(assetForm.date),
                type: TransactionType.Buy,
                instrumentTicker: tickerUpper,
                quantity: Number(qtyValue),
                price: Number(priceValue),
                fees: Number(feesValue),
                currency: assetForm.currency,
                account: "Default",
                portfolioId: currentPortfolioId
            });
        }

        if (attachWarning) {
            setAssetAttachNotice(attachWarning);
        }

        setAssetForm({
            ticker: "",
            isin: "",
            name: "",
            type: AssetType.Stock,
            assetClass: AssetClass.STOCK,
            quantity: 0,
            price: 0,
            fees: 0,
            date: new Date().toISOString().split("T")[0],
            currency: Currency.USD
        });
        setIsinLookupStatus('idle');
        setIsinLookupMessage('');
        setIsinCandidates([]);
        setIsinResolvedSymbol('');
        setAssetInputNotice("");
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
        if (assetForm.type === AssetType.Crypto) {
            const resolved = resolveEodhdSymbol(assetForm.ticker, AssetType.Crypto);
            if (resolved && resolved !== assetForm.ticker) {
                setAssetForm(prev => ({ ...prev, ticker: resolved }));
            }
        }
    };

    const handleTickerChange = (value: string) => {
        const trimmed = normalizeTicker(value);
        if (trimmed && isIsin(trimmed)) {
            setAssetForm(prev => ({ ...prev, ticker: "", isin: trimmed }));
            setAssetInputNotice("Sembra un ISIN: spostato nel campo ISIN.");
            setTickerDropdownOpen(false);
            return;
        }
        if (assetInputNotice) setAssetInputNotice("");
        setAssetForm(prev => ({ ...prev, ticker: value.toUpperCase() }));
    };

    const handleIsinChange = (value: string) => {
        const normalized = normalizeIsin(value);
        setAssetForm(prev => ({ ...prev, isin: normalized }));
        setIsinLookupStatus('idle');
        setIsinLookupMessage('');
        setIsinCandidates([]);
        setIsinResolvedSymbol('');
        if (assetInputNotice) setAssetInputNotice("");
    };

    const mapListingType = (value?: string): AssetType | null => {
        const raw = (value || "").toLowerCase();
        if (!raw) return null;
        if (raw.includes("crypto")) return AssetType.Crypto;
        if (raw.includes("etf") || raw.includes("fund")) return AssetType.ETF;
        if (raw.includes("bond")) return AssetType.Bond;
        if (raw.includes("commodity")) return AssetType.Commodity;
        if (raw.includes("cash")) return AssetType.Cash;
        if (raw.includes("stock") || raw.includes("equity")) return AssetType.Stock;
        return null;
    };

    const mapAssetClassForType = (type: AssetType): AssetClass => {
        switch (type) {
            case AssetType.Crypto:
                return AssetClass.CRYPTO;
            case AssetType.Cash:
                return AssetClass.CASH;
            case AssetType.Bond:
                return AssetClass.BOND;
            case AssetType.ETF:
                return AssetClass.ETF_STOCK;
            case AssetType.Commodity:
                return AssetClass.ETC;
            case AssetType.Stock:
            default:
                return AssetClass.STOCK;
        }
    };

    const applyIsinCandidate = (listing: InstrumentListing) => {
        if (!listing?.symbol) return;
        const symbol = listing.symbol;
        const currentTicker = normalizeTicker(assetForm.ticker);
        if (currentTicker && currentTicker !== normalizeTicker(symbol)) {
            const confirm = window.confirm('Il ticker inserito (' + currentTicker + ') e diverso dal listing trovato (' + symbol + '). Vuoi usare ' + symbol + '?');
            if (!confirm) return;
        }
        const inferredType = mapListingType(listing.type) || assetForm.type;
        const nextAssetClass = mapAssetClassForType(inferredType);
        setAssetForm(prev => ({
            ...prev,
            ticker: symbol,
            isin: normalizedIsin,
            name: prev.name?.trim() ? prev.name : (listing.name || prev.name),
            currency: listing.currency || prev.currency,
            type: inferredType,
            assetClass: nextAssetClass
        }));
        setIsinResolvedSymbol(symbol);
        setIsinLookupStatus('resolved');
        setAssetInputNotice('Risolto da ISIN.');
    };

    const handleIsinSearch = async () => {
        const currentIsin = normalizedIsin;
        if (!currentIsin || !isIsin(currentIsin)) {
            setIsinLookupStatus('error');
            setIsinLookupMessage('Inserisci un ISIN valido.');
            setIsinCandidates([]);
            setIsinResolvedSymbol('');
            return;
        }
        setIsinLookupStatus('loading');
        setIsinLookupMessage('');
        try {
            const candidates = await resolveListingsByIsin(currentIsin, settings?.eodhdApiKey);
            if (candidates.length === 0) {
                setIsinLookupStatus('none');
                setIsinLookupMessage('Nessun listing trovato per questo ISIN.');
                setIsinCandidates([]);
                setIsinResolvedSymbol('');
                return;
            }
            setIsinCandidates(candidates);
            setIsinResolvedSymbol(candidates[0]?.symbol || '');
            if (candidates.length === 1) {
                applyIsinCandidate(candidates[0]);
                return;
            }
            setIsinLookupStatus('multiple');
        } catch (e: any) {
            setIsinLookupStatus('error');
            setIsinLookupMessage(e?.message || 'Lookup ISIN fallito');
            setIsinCandidates([]);
            setIsinResolvedSymbol('');
        }
    };

    useEffect(() => {
        if (!isAssetModalOpen) {
            setAssetMarketHint({ status: 'idle' });
            return;
        }
        if (!resolvedTicker || !assetForm.date || tickerLooksIsin || missingExchange) {
            setAssetMarketHint({ status: 'idle' });
            return;
        }
        const requestId = ++assetMarketHintReq.current;
        const controller = new AbortController();
        setAssetMarketHint({ status: 'loading' });
        const timeoutId = setTimeout(async () => {
            try {
                const result = await getMarketCloseAroundDate(currentPortfolioId, resolvedTicker, assetForm.date, 10, { signal: controller.signal, forceEodhd: forceAssetEodhd });
                if (requestId !== assetMarketHintReq.current || controller.signal.aborted) return;
                setAssetMarketHint({ status: result.status, data: result, message: result.message });
            } catch (err: any) {
                if (requestId !== assetMarketHintReq.current || controller.signal.aborted) return;
                setAssetMarketHint({ status: 'error', message: err?.message || undefined });
            }
        }, 350);
        return () => {
            controller.abort();
            clearTimeout(timeoutId);
        };
    }, [isAssetModalOpen, resolvedTicker, assetForm.date, tickerLooksIsin, missingExchange, currentPortfolioId, forceAssetEodhd]);

    useEffect(() => {
        if (!isTxModalOpen || !activeAssetForTx || activeAssetForTx === 'CASH' || !txForm.date) {
            setTxMarketHint({ status: 'idle' });
            return;
        }
        const requestId = ++txMarketHintReq.current;
        const controller = new AbortController();
        setTxMarketHint({ status: 'loading' });
        const timeoutId = setTimeout(async () => {
            try {
                const result = await getMarketCloseAroundDate(currentPortfolioId, activeAssetForTx, txForm.date, 10, { signal: controller.signal, forceEodhd: forceTxEodhd });
                if (requestId !== txMarketHintReq.current || controller.signal.aborted) return;
                setTxMarketHint({ status: result.status, data: result, message: result.message });
            } catch (err: any) {
                if (requestId !== txMarketHintReq.current || controller.signal.aborted) return;
                setTxMarketHint({ status: 'error', message: err?.message || undefined });
            }
        }, 350);
        return () => {
            controller.abort();
            clearTimeout(timeoutId);
        };
    }, [isTxModalOpen, activeAssetForTx, txForm.date, currentPortfolioId, forceTxEodhd]);

    const getCoverageBadge = (priceTicker: string) => {
        const row = coverageByTicker.get(priceTicker);
        const config = resolvePriceSyncConfig(priceTicker, settings);
        const provider = config.provider;
        const isNeedsMapping = Boolean(config.needsMapping);
        const isExcluded = !isNeedsMapping && (config.excluded || provider === "MANUAL");
        const statusLabel = isNeedsMapping
            ? "MAPPING"
            : isExcluded
                ? (provider === "MANUAL" ? "MANUAL" : "ESCLUSO")
                : (row?.status || "INCOMPLETO");
        const statusClass = isNeedsMapping
            ? "bg-red-100 text-red-700"
            : isExcluded
                ? "bg-slate-100 text-slate-600"
                : statusLabel === "OK"
                    ? "bg-green-100 text-green-700"
                    : statusLabel === "PARZIALE"
                        ? "bg-amber-100 text-amber-700"
                        : "bg-red-100 text-red-700";
        return { statusLabel, statusClass };
    };

    const handleOpenListingFix = (instrument?: Instrument, fallbackTicker?: string) => {
        const params = new URLSearchParams();
        params.set("focus", "listing");
        if (instrument?.ticker || fallbackTicker) {
            params.set("ticker", instrument?.ticker || fallbackTicker || "");
        }
        if (instrument?.isin) {
            params.set("isin", instrument.isin);
        }
        navigate(`/settings?${params.toString()}`);
    };

    return (
        <div className="space-y-6 relative animate-fade-in text-textPrimary">
            {/* Header & Add Asset Button */}
            <div className="flex justify-between items-center ui-panel p-6 sticky top-0 z-10 transition-colors">
                <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
                    <span className="material-symbols-outlined text-[#0052a3]">receipt_long</span>
                    Registro Transazioni
                </h2>
                <button
                    onClick={() => { setAssetAttachNotice(''); setAssetInputNotice(''); setIsinLookupStatus('idle'); setIsinLookupMessage(''); setIsinCandidates([]); setIsinResolvedSymbol(''); setAssetModalOpen(true); }}
                    className="ui-btn-primary px-5 py-2.5 rounded-xl text-sm font-bold transition-all shadow-lg hover:shadow-primary/30 flex items-center gap-2"
                >
                    <span className="material-symbols-outlined text-[20px]">add_circle</span>
                    Nuovo Asset
                </button>
            </div>
            {assetAttachNotice && (
                <div className="ui-panel-subtle border-amber-200 bg-amber-50 px-4 py-2 text-xs font-semibold text-amber-700">
                    {assetAttachNotice}
                </div>
            )}

            {/* --- MODAL: ADD ASSET & INITIAL BUY --- */}
            {isAssetModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-md animate-fade-in">
                    <div className="ui-panel-dense w-full max-w-lg overflow-hidden max-h-[90vh] overflow-y-auto">
                        <div className="p-6 border-b border-slate-200/70 flex justify-between items-center sticky top-0 bg-white/90 z-10">
                            <h3 className="text-lg font-bold text-slate-900">Aggiungi Strumento</h3>
                            <button onClick={() => setAssetModalOpen(false)} className="text-slate-400 hover:text-slate-700 transition-colors">
                                <span className="material-symbols-outlined">close</span>
                            </button>
                        </div>
                        <form onSubmit={handleSaveAsset} className="p-6 space-y-5">
                            {/* Ticker Section */}
                            <div className="relative">
                                <label className="block text-xs font-bold text-slate-700 font-medium uppercase mb-1.5">Ticker (symbol EODHD)</label>
                                <input
                                    ref={tickerInputRef}
                                    placeholder="Es. AAPL.US o BTC-USD.CC" required
                                    value={assetForm.ticker}
                                    onChange={e => handleTickerChange(e.target.value)}
                                    onFocus={() => setTickerDropdownOpen(tickerSearchResults.length > 0 && !suppressSuggestions)}
                                    onBlur={handleTickerBlur}
                                    onKeyDown={e => {
                                        if (e.key === 'Escape' || e.key === 'Tab') {
                                            setTickerDropdownOpen(false);
                                        }
                                    }}
                                    className="ui-input w-full uppercase font-mono text-sm"
                                    autoComplete="off"
                                />
                                <div className="text-[11px] text-slate-500 mt-1">
                                    Formato richiesto: SYMBOL.EXCHANGE (es. AAPL.US, VWRL.AS). Cripto: BTC-USD.CC.
                                </div>
                                {/* Search Preview Dropdown */}
                                {isTickerDropdownOpen && tickerSearchResults.length > 0 && (
                                    <div
                                        ref={tickerDropdownRef}
                                        className="absolute top-full left-0 right-0 ui-panel-dense shadow-xl mt-1 z-20 max-h-48 overflow-y-auto"
                                    >
                                        <div className="p-2 text-xs text-gray-500 font-medium bg-slate-50/50">Suggerimenti Borsa</div>
                                        {tickerSearchResults.map((res) => (
                                            <div
                                                key={res.t}
                                                onMouseDown={() => selectTickerSuggestion(res.t)}
                                                className="px-4 py-2 hover:bg-slate-50 cursor-pointer flex justify-between items-center group transition-colors"
                                            >
                                                <span className="font-bold text-gray-200">{res.t}</span>
                                                <span className="text-xs text-gray-500 group-hover:text-primary">{res.ex}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            {assetInputNotice && (
                                <div className="text-[11px] text-amber-600 mt-1">{assetInputNotice}</div>
                            )}
                            {tickerLooksIsin && (
                                <div className="text-[11px] text-red-600 mt-1">Sembra un ISIN: incollalo nel campo ISIN.</div>
                            )}
                            {missingExchange && (
                                <div className="text-[11px] text-red-600 mt-1">Manca l'exchange (es. .US, .SW, .AS).</div>
                            )}
                            {assetForm.type === AssetType.Crypto && resolvedTicker && resolvedTicker !== normalizedTicker && (
                                <div className="text-[11px] text-emerald-700 mt-1">Auto: {resolvedTicker}</div>
                            )}
                            </div>

                            <div>
                                <label className="block text-xs font-bold text-slate-700 font-medium uppercase mb-1.5">ISIN (opzionale)</label>
                                <input
                                    placeholder="Es. IE00B4L5Y983"
                                    value={assetForm.isin}
                                    onChange={e => handleIsinChange(e.target.value)}
                                    className="ui-input w-full uppercase font-mono text-sm"
                                    autoComplete="off"
                                />
                                <div className="text-[11px] text-slate-500 mt-1">
                                    Aiuta ad agganciare automaticamente listing e prezzi da EODHD.
                                </div>
                                <button
                                    type="button"
                                    onClick={handleIsinSearch}
                                    disabled={!normalizedIsin || isinInvalid || isinLookupStatus === 'loading'}
                                    className="mt-2 text-[11px] font-bold text-[#0052a3] hover:text-blue-600 disabled:opacity-50"
                                >
                                    {isinLookupStatus === 'loading' ? 'Cerca su EODHD...' : 'Cerca su EODHD'}
                                </button>
                                {isinInvalid && (
                                    <div className="text-[11px] text-red-600 mt-1">ISIN non valido. Usa formato es: IE00B4L5Y983.</div>
                                )}
                                {isinLookupStatus === 'loading' && (
                                    <div className="text-[11px] text-slate-500 mt-1">Risoluzione ISIN in corso...</div>
                                )}
                                {isinLookupStatus === 'resolved' && isinResolvedSymbol && (
                                    <div className="text-[11px] text-emerald-700 mt-1">Risolto da ISIN: {isinResolvedSymbol}</div>
                                )}
                                {isinLookupStatus === 'multiple' && isinCandidates.length > 0 && (
                                    <div className="mt-2 space-y-2">
                                        <div className="text-[11px] text-slate-500">Piu listing trovati: seleziona quello corretto.</div>
                                        <select
                                            className="w-full border border-borderSoft rounded-lg px-2 py-1 text-xs text-slate-800 bg-white shadow-inner"
                                            value={isinResolvedSymbol}
                                            onChange={e => setIsinResolvedSymbol(e.target.value)}
                                        >
                                            {isinCandidates.map(candidate => (
                                                <option key={candidate.symbol} value={candidate.symbol}>
                                                    {candidate.symbol} {candidate.exchangeCode ? '(' + candidate.exchangeCode + ')' : ''} {candidate.name || ''}
                                                </option>
                                            ))}
                                        </select>
                                        <button
                                            type="button"
                                            className="text-[11px] font-bold text-[#0052a3] hover:text-blue-600"
                                            onClick={() => { const selected = isinCandidates.find(c => c.symbol === isinResolvedSymbol); if (selected) applyIsinCandidate(selected); }}
                                        >
                                            Usa questo symbol
                                        </button>
                                    </div>
                                )}
                                {(isinLookupStatus === 'none' || isinLookupStatus === 'error') && isinLookupMessage && (
                                    <div className="text-[11px] text-amber-700 mt-1">
                                        {isinLookupMessage}{' '}
                                        <button
                                            type="button"
                                            className="underline text-[#0052a3] font-bold"
                                            onClick={() => navigate('/settings?focus=listing&isin=' + normalizedIsin)}
                                        >
                                            Apri Listings & FX
                                        </button>
                                    </div>
                                )}
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-slate-700 font-medium uppercase mb-1.5">Nome Strumento</label>
                                <input
                                    placeholder="Nome completo" required
                                    value={assetForm.name}
                                    onChange={e => setAssetForm({ ...assetForm, name: e.target.value })}
                                    className="ui-input w-full text-sm"
                                />
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-bold text-slate-700 font-medium uppercase mb-1.5">Tipo</label>
                                    <select
                                        value={assetForm.type}
                                        onChange={e => setAssetForm({ ...assetForm, type: e.target.value as AssetType })}
                                        className="ui-input w-full text-sm"
                                    >
                                        {Object.values(AssetType).map(t => <option key={t} value={t}>{getAssetTypeLabel(t)}</option>)}
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-slate-700 font-medium uppercase mb-1.5">Valuta</label>
                                    <select
                                        value={assetForm.currency}
                                        onChange={e => setAssetForm({ ...assetForm, currency: e.target.value as Currency })}
                                        className="ui-input w-full text-sm"
                                    >
                                        {Object.values(Currency).map(c => <option key={c} value={c}>{c}</option>)}
                                    </select>
                                </div>
                            </div>

                            {/* Initial Transaction Section */}
                            <div className="border-t border-white/10 pt-3 mt-2">
                                <p className="text-xs font-bold text-primary uppercase mb-3 flex items-center gap-1">
                                    <span className="material-symbols-outlined text-sm">shopping_cart</span>
                                    Dettagli Primo Acquisto
                                </p>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-bold text-slate-700 font-medium uppercase mb-1.5">Data</label>
                                    <input
                                        ref={assetDateRef}
                                        type="date" required
                                        value={assetForm.date}
                                        onChange={e => setAssetForm({ ...assetForm, date: e.target.value })}
                                        className="ui-input w-full text-sm dark-date-input"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-slate-700 font-medium uppercase mb-1.5">Quantità</label>
                                    <input
                                        type="number" placeholder="0" step="0.0001" required
                                        value={numberValue(assetForm.quantity)}
                                        onChange={e => setAssetForm({ ...assetForm, quantity: parseNumberInput(e.target.value) })}
                                        className="ui-input w-full text-sm font-mono"
                                    />
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-bold text-slate-700 font-medium uppercase mb-1.5">Prezzo Acquisto</label>
                                    <input
                                        type="number" placeholder="0.00" step="0.01" required
                                        value={numberValue(assetForm.price)}
                                        onChange={e => setAssetForm({ ...assetForm, price: parseNumberInput(e.target.value) })}
                                        className="ui-input w-full text-sm font-mono"
                                    />
                                    {assetMarketHint.status === 'loading' && (
                                        <div className="text-[11px] text-slate-500 mt-1">Carico prezzo di mercato...</div>
                                    )}
                                    {(assetMarketHint.status === 'exact' || assetMarketHint.status === 'fallback') && assetMarketHint.data && (
                                        <div className="text-[11px] text-slate-600 mt-1">
                                            {assetMarketHint.status === 'exact' ? 'Prezzo di mercato (close) ' : 'Nessun close per la data selezionata. Ultimo close disponibile '}
                                            ({assetMarketHint.data.dateUsed}): {assetMarketHint.data.close} {assetMarketHint.data.currency || ''} 
                                            <span className="text-slate-400">[fonte: {assetMarketHint.data.source === 'cache' ? 'cache locale' : 'EODHD'}]</span> 
                                            <button
                                                type="button"
                                                className="underline font-bold text-[#0052a3]"
                                                onClick={() => setAssetForm(prev => ({ ...prev, price: assetMarketHint.data?.close ?? prev.price }))}
                                            >
                                                Usa questo prezzo
                                            </button>
                                        </div>
                                    )}
                                    {assetMarketHint.status === 'not_found' && (
                                        <div className="text-[11px] text-amber-700 mt-1">Simbolo non coperto da EODHD.</div>
                                    )}
                                    {assetMarketHint.status === 'no_data' && (
                                        <div className="text-[11px] text-amber-700 mt-1">Nessun dato disponibile nel range.</div>
                                    )}
                                    {assetMarketHint.status === 'invalid_payload' && (
                                        <div className="text-[11px] text-amber-700 mt-1">Risposta non valida dal provider EODHD.</div>
                                    )}
                                    {assetMarketHint.status === 'aborted' && null}
                                    {assetMarketHint.status === 'error' && (
                                        <div className="text-[11px] text-amber-700 mt-1">{assetMarketHint.message === 'Missing EODHD key' ? 'Chiave EODHD mancante: aggiungila nelle impostazioni.' : 'Prezzo di mercato non disponibile al momento.'}</div>
                                    )}
                                    <label className="mt-2 inline-flex items-center gap-2 text-[11px] text-slate-500">
                                        <input
                                            type="checkbox"
                                            checked={forceAssetEodhd}
                                            onChange={e => setForceAssetEodhd(e.target.checked)}
                                        />
                                        Forza EODHD (ignora cache)
                                    </label>
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-slate-700 font-medium uppercase mb-1.5">Commissioni</label>
                                    <input
                                        type="number" placeholder="0.00" step="0.01"
                                        value={numberValue(assetForm.fees)}
                                        onChange={e => setAssetForm({ ...assetForm, fees: parseNumberInput(e.target.value) })}
                                        className="ui-input w-full text-sm font-mono"
                                    />
                                </div>
                            </div>

                            <div className="pt-4">
                                <button type="submit" className="ui-btn-primary w-full py-3.5 rounded-xl font-bold transition shadow-lg text-sm">
                                    Salva Strumento e Transazione
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* --- MODAL: ADD/EDIT TRANSACTION (Specific Asset) --- */}
            {isTxModalOpen && activeAssetForTx && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-md animate-fade-in">
                    <div className="ui-panel-dense w-full max-w-lg overflow-hidden">
                        <div className="p-6 border-b border-slate-200/70 flex justify-between items-center bg-white/90">
                            <div>
                                <h3 className="text-lg font-bold text-slate-900">
                                    {editingTxId ? 'Modifica Operazione' : 'Nuova Operazione'}
                                </h3>
                                <p className="text-xs text-primary font-bold uppercase tracking-wider mt-0.5">{activeAssetForTx}</p>
                            </div>
                            <button onClick={() => setTxModalOpen(false)} className="text-slate-400 hover:text-slate-700">
                                <span className="material-symbols-outlined">close</span>
                            </button>
                        </div>
                        <form onSubmit={handleSaveTransaction} className="p-6 space-y-4">
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-bold text-slate-700 font-medium uppercase mb-1.5">Data</label>
                                    <input
                                        type="date"
                                        className="ui-input w-full text-sm dark-date-input"
                                        value={txForm.date}
                                        onChange={e => setTxForm({ ...txForm, date: e.target.value })}
                                        required
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-slate-700 font-medium uppercase mb-1.5">Tipo</label>
                                    <select
                                        className="ui-input w-full text-sm"
                                        value={txForm.type}
                                        onChange={e => setTxForm({ ...txForm, type: e.target.value as TransactionType })}
                                    >
                                        {Object.values(TransactionType).map(t => <option key={t} value={t}>{getTransactionTypeLabel(t)}</option>)}
                                    </select>
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-bold text-slate-700 font-medium uppercase mb-1.5">Prezzo Unitario</label>
                                    <input
                                        type="number" placeholder="0.00"
                                        className="ui-input w-full text-sm font-mono"
                                        step="0.01"
                                        value={numberValue(txForm.price)}
                                        onChange={e => setTxForm({ ...txForm, price: parseNumberInput(e.target.value) })}
                                        required
                                    />
                                    {txMarketHint.status === 'loading' && (
                                        <div className="text-[11px] text-slate-500 mt-1">Carico prezzo di mercato...</div>
                                    )}
                                    {(txMarketHint.status === 'exact' || txMarketHint.status === 'fallback') && txMarketHint.data && (
                                        <div className="text-[11px] text-slate-600 mt-1">
                                            {txMarketHint.status === 'exact' ? 'Prezzo di mercato (close) ' : 'Nessun close per la data selezionata. Ultimo close disponibile '}
                                            ({txMarketHint.data.dateUsed}): {txMarketHint.data.close} {txMarketHint.data.currency || ''} 
                                            <span className="text-slate-400">[fonte: {txMarketHint.data.source === 'cache' ? 'cache locale' : 'EODHD'}]</span> 
                                            <button
                                                type="button"
                                                className="underline font-bold text-[#0052a3]"
                                                onClick={() => setTxForm(prev => ({ ...prev, price: txMarketHint.data?.close ?? prev.price }))}
                                            >
                                                Usa questo prezzo
                                            </button>
                                        </div>
                                    )}
                                    {txMarketHint.status === 'not_found' && (
                                        <div className="text-[11px] text-amber-700 mt-1">Simbolo non coperto da EODHD.</div>
                                    )}
                                    {txMarketHint.status === 'no_data' && (
                                        <div className="text-[11px] text-amber-700 mt-1">Nessun dato disponibile nel range.</div>
                                    )}
                                    {txMarketHint.status === 'invalid_payload' && (
                                        <div className="text-[11px] text-amber-700 mt-1">Risposta non valida dal provider EODHD.</div>
                                    )}
                                    {txMarketHint.status === 'aborted' && null}
                                    {txMarketHint.status === 'error' && (
                                        <div className="text-[11px] text-amber-700 mt-1">{txMarketHint.message === 'Missing EODHD key' ? 'Chiave EODHD mancante: aggiungila nelle impostazioni.' : 'Prezzo di mercato non disponibile al momento.'}</div>
                                    )}
                                    <label className="mt-2 inline-flex items-center gap-2 text-[11px] text-slate-500">
                                        <input
                                            type="checkbox"
                                            checked={forceTxEodhd}
                                            onChange={e => setForceTxEodhd(e.target.checked)}
                                        />
                                        Forza EODHD (ignora cache)
                                    </label>
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-slate-700 font-medium uppercase mb-1.5">Quantità</label>
                                    <input
                                        type="number" placeholder="0"
                                        className="ui-input w-full text-sm font-mono"
                                        step="0.0001"
                                        value={numberValue(txForm.qty)}
                                        onChange={e => setTxForm({ ...txForm, qty: parseNumberInput(e.target.value) })}
                                        required
                                    />
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-bold text-slate-700 font-medium uppercase mb-1.5">Commissioni</label>
                                    <input
                                        type="number" placeholder="0.00"
                                        className="ui-input w-full text-sm font-mono"
                                        step="0.01"
                                        value={numberValue(txForm.fees)}
                                        onChange={e => setTxForm({ ...txForm, fees: parseNumberInput(e.target.value) })}
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-slate-700 font-medium uppercase mb-1.5">Valuta</label>
                                    <select
                                        className="ui-input w-full text-sm"
                                        value={txForm.currency}
                                        onChange={e => setTxForm({ ...txForm, currency: e.target.value as Currency })}
                                    >
                                        {Object.values(Currency).map(c => <option key={c} value={c}>{c}</option>)}
                                    </select>
                                </div>
                            </div>

                            <div className="pt-4">
                                <button type="submit" className="ui-btn-primary w-full py-3.5 rounded-xl font-bold transition shadow-lg text-sm">
                                    {editingTxId ? 'Aggiorna Transazione' : 'Registra Movimento'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {isEditAssetModalOpen && editingAsset && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-md animate-fade-in">
                    <div className="ui-panel-dense w-full max-w-lg overflow-hidden">
                        <div className="p-6 border-b border-slate-200/70 flex justify-between items-center bg-white/90">
                            <div>
                                <h3 className="text-lg font-bold text-slate-900">Modifica Asset</h3>
                                <p className="text-xs text-primary font-bold uppercase tracking-wider mt-0.5">{editingAsset.ticker}</p>
                            </div>
                            <button onClick={handleCloseEditAsset} className="text-slate-400 hover:text-slate-700">
                                <span className="material-symbols-outlined">close</span>
                            </button>
                        </div>
                        <form onSubmit={handleSaveAssetMeta} className="p-6 space-y-4">
                            <div>
                                <label className="block text-xs font-bold text-slate-700 font-medium uppercase mb-1.5">Nome</label>
                                <input
                                    value={editAssetForm.name}
                                    onChange={e => setEditAssetForm({ ...editAssetForm, name: e.target.value })}
                                    className="ui-input w-full text-sm"
                                    required
                                />
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-bold text-slate-700 font-medium uppercase mb-1.5">Tipo</label>
                                    <select
                                        value={editAssetForm.type}
                                        onChange={e => setEditAssetForm({ ...editAssetForm, type: e.target.value as AssetType })}
                                        className="ui-input w-full text-sm"
                                    >
                                        {Object.values(AssetType).map(t => <option key={t} value={t}>{getAssetTypeLabel(t)}</option>)}
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-slate-700 font-medium uppercase mb-1.5">Asset class</label>
                                    <select
                                        value={editAssetForm.assetClass}
                                        onChange={e => setEditAssetForm({ ...editAssetForm, assetClass: e.target.value as AssetClass })}
                                        className="ui-input w-full text-sm"
                                    >
                                        {Object.values(AssetClass).map(ac => <option key={ac} value={ac}>{getAssetClassLabel(ac)}</option>)}
                                    </select>
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-bold text-slate-700 font-medium uppercase mb-1.5">Valuta</label>
                                    <select
                                        value={editAssetForm.currency}
                                        onChange={e => setEditAssetForm({ ...editAssetForm, currency: e.target.value as Currency })}
                                        className="ui-input w-full text-sm"
                                    >
                                        {Object.values(Currency).map(c => <option key={c} value={c}>{c}</option>)}
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-slate-700 font-medium uppercase mb-1.5">Settore</label>
                                    <input
                                        value={editAssetForm.sector}
                                        onChange={e => setEditAssetForm({ ...editAssetForm, sector: e.target.value })}
                                        className="ui-input w-full text-sm"
                                    />
                                </div>
                            </div>

                            <div>
                                <label className="block text-xs font-bold text-slate-700 font-medium uppercase mb-1.5">Geografia</label>
                                <select
                                    value={editAssetForm.region}
                                    onChange={e => setEditAssetForm({ ...editAssetForm, region: e.target.value as RegionKey | '' })}
                                    className="ui-input w-full text-sm"
                                >
                                    <option value="">Auto / multi</option>
                                    {REGION_OPTIONS.map(opt => (
                                        <option key={opt.key} value={opt.key}>{opt.label}</option>
                                    ))}
                                </select>
                            </div>

                            <div className="pt-4 flex gap-3">
                                <button
                                    type="button"
                                    onClick={handleCloseEditAsset}
                                    className="flex-1 border border-borderSoft text-slate-700 py-3 rounded-xl font-bold hover:bg-slate-50 transition"
                                >
                                    Annulla
                                </button>
                                <button
                                    type="submit"
                                    className="flex-1 ui-btn-primary py-3 rounded-xl font-bold transition"
                                >
                                    Salva
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Accordion List */}
            <div className="space-y-3">
                {groupedAssets.map(group => {
                    const instrument = instrumentByTicker.get(group.ticker);
                    const assetLabel = instrument ? getAssetTypeLabel(instrument.type) : (group.ticker === 'CASH' ? getAssetTypeLabel(AssetType.Cash) : '');
                    const instrumentName = instrument?.name || group.ticker;
                    const instrumentIsin = instrument?.isin;
                    const displayCurrency = instrument?.currency || group.currency;
                    const priceTicker = instrument ? getCanonicalTicker(instrument) : group.ticker;
                    const coverageBadge = group.ticker !== "CASH" && priceTicker ? getCoverageBadge(priceTicker) : null;
                    return (
                    <div key={group.ticker} className="ui-panel overflow-hidden transition-all hover:border-primary/30">

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
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <h3 className="font-bold text-slate-900 text-sm">{instrumentName}</h3>
                                        {coverageBadge && (
                                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-lg ${coverageBadge.statusClass}`}>
                                                {coverageBadge.statusLabel}
                                            </span>
                                        )}
                                    </div>
                                    <p className="text-xs text-slate-500">
                                        {group.ticker}{instrumentIsin ? ` • ISIN ${instrumentIsin}` : ""}
                                    </p>
                                    <p className="text-xs text-slate-500">
                                        {assetLabel ? `${assetLabel} - ` : ""}Media: {group.avgPrice.toFixed(2)} {displayCurrency}
                                    </p>
                                    <p className="text-xs text-slate-500">
                                        Investito: {group.invested.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })} {displayCurrency} · Quote: {group.quantity.toLocaleString()}
                                    </p>
                                    {group.ticker !== "CASH" && (
                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                handleOpenListingFix(instrument, group.ticker);
                                            }}
                                            className="text-[11px] font-bold text-[#0052a3] hover:text-blue-500 mt-1"
                                        >
                                            Fix listing/prezzi
                                        </button>
                                    )}
                                </div>
                            </div>

                            <div className="flex items-center gap-4">
                                <div className="text-right hidden sm:block">
                                    <p className="text-sm font-bold text-slate-900 tracking-tight">{group.currentValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {group.currency}</p>
                                    <p className={clsx("text-xs font-bold", group.pnl >= 0 ? "text-positive" : "text-negative")}>
                                        {group.pnl >= 0 ? '+' : ''}{group.pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })} ({group.pnlPercent.toFixed(1)}%)
                                    </p>
                                </div>
                                {instrument && (
                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleOpenEditAsset(instrument);
                                        }}
                                        className="p-2 rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition"
                                        aria-label="Modifica asset"
                                    >
                                        <span className="material-symbols-outlined text-[18px]">edit</span>
                                    </button>
                                )}
                                <span className={`material-symbols-outlined text-slate-400 transition-transform duration-300 ${expandedTicker === group.ticker ? 'rotate-180' : ''}`}>
                                    expand_more
                                </span>
                            </div>
                        </div>

                        {/* Expanded Transactions Table */}
                        {expandedTicker === group.ticker && (
                            <div className="bg-slate-50 border-t border-borderSoft animate-fade-in">
                                <table className="w-full text-sm text-left">
                                    <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-borderSoft">
                                        <tr>
                                            <th className="px-6 py-3 font-semibold">Data</th>
                                            <th className="px-6 py-3 font-semibold">Tipo</th>
                                            <th className="px-6 py-3 font-semibold text-right">Prezzo</th>
                                            <th className="px-6 py-3 font-semibold text-right">Qta</th>
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
                                                        {getTransactionTypeLabel(t.type)}
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
                                                            className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-primary transition-colors"
                                                            title="Modifica"
                                                        >
                                                            <span className="material-symbols-outlined text-[18px]">edit</span>
                                                        </button>
                                                        <button
                                                            onClick={() => handleDeleteTransaction(t.id)}
                                                            className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-negative transition-colors"
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
                                        className="text-xs text-[#0052a3] font-bold uppercase tracking-wide hover:text-blue-400 flex items-center justify-center gap-1 w-full py-2 hover:bg-slate-50 rounded transition-colors"
                                    >
                                        <span className="material-symbols-outlined text-[18px]">add</span> Registra acquisto / vendita
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                )})}

                {!transactions?.length && (
                    <div className="ui-panel-subtle text-center py-16 text-slate-500 border border-dashed border-borderSoft">
                        <span className="material-symbols-outlined text-4xl mb-3 opacity-30">receipt_long</span>
                        <p>Nessuna transazione presente.</p>
                        <p className="text-sm">Inizia aggiungendo il tuo primo strumento con il tasto in alto.</p>
                    </div>
                )}
            </div>
        </div>
    );
};
























