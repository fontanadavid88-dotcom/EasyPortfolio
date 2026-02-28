import React, { useState, useMemo } from 'react';
import { db, getCurrentPortfolioId } from '../db';
import { useLiveQuery } from 'dexie-react-hooks';
import { calculateHoldings, calculateRebalancing, getCanonicalTicker, getLatestPricePoint, getValuationDateForHoldings } from '../services/financeUtils';
import { RebalanceStrategy, AssetType, AssetClass, Instrument, Currency, RegionKey, PortfolioPosition } from '../types';
import { convertAmountFromSeries } from '../services/fxService';
import { analyzeRebalanceQuality, getIssueHelp } from '../services/dataQuality';
import { queryLatestFxForPairs, queryLatestPricesForTickers } from '../services/dbQueries';
import { InfoPopover } from '../components/InfoPopover';
import { computeRebalanceUnits } from '../services/rebalanceUtils';

import clsx from 'clsx';

// Mapping AssetType to Macro Category
type MacroCategory = 'AZIONI' | 'OBBLIGAZIONI' | 'COMMODITIES' | 'MONETARIO' | 'ALTRO';

const getMacroCategory = (instrument?: Instrument): MacroCategory => {
    const resolvedClass = instrument?.assetClass;
    if (resolvedClass === AssetClass.BOND || resolvedClass === AssetClass.ETF_BOND) return 'OBBLIGAZIONI';
    if (resolvedClass === AssetClass.ETF_STOCK || resolvedClass === AssetClass.STOCK) return 'AZIONI';
    if (resolvedClass === AssetClass.CASH || resolvedClass === AssetClass.CRYPTO) return 'MONETARIO';
    if (resolvedClass === AssetClass.ETC) return 'COMMODITIES';

    if (instrument?.type === AssetType.Bond) return 'OBBLIGAZIONI';
    if (instrument?.type === AssetType.Stock || instrument?.type === AssetType.ETF) return 'AZIONI';
    if (instrument?.type === AssetType.Commodity) return 'COMMODITIES';
    if (instrument?.type === AssetType.Cash || instrument?.type === AssetType.Crypto) return 'MONETARIO';
    return 'ALTRO';
};

const MACRO_ORDER = ['OBBLIGAZIONI', 'AZIONI', 'COMMODITIES', 'MONETARIO', 'ALTRO'];
const MACRO_COLORS: Record<MacroCategory, string> = {
    AZIONI: '#0052a3',
    OBBLIGAZIONI: '#1d4ed8',
    COMMODITIES: '#b45309',
    MONETARIO: '#0f766e',
    ALTRO: '#64748b'
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

export const Rebalance: React.FC = () => {
    const currentPortfolioId = getCurrentPortfolioId();
    const [strategy, setStrategy] = useState<RebalanceStrategy>(RebalanceStrategy.Accumulate);
    const [cashInjection, setCashInjection] = useState(0);
    const [editTargetId, setEditTargetId] = useState<number | null>(null);
    const [editTargetTicker, setEditTargetTicker] = useState<string | null>(null);
    const [tempTargetVal, setTempTargetVal] = useState<string>('');
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

    const transactions = useLiveQuery(() => db.transactions.where('portfolioId').equals(currentPortfolioId).toArray(), [currentPortfolioId], []);
    const instruments = useLiveQuery(() => db.instruments.where('portfolioId').equals(currentPortfolioId).toArray(), [currentPortfolioId], []);

    const priceTickers = useMemo(() => {
        const set = new Set<string>();
        (instruments || []).forEach(instr => {
            const ticker = getCanonicalTicker(instr);
            if (ticker) set.add(ticker);
            if (instr.ticker) set.add(instr.ticker);
        });
        (transactions || []).forEach(t => {
            if (t.instrumentTicker) set.add(t.instrumentTicker);
        });
        return Array.from(set.values());
    }, [instruments, transactions]);

    const priceTickersKey = useMemo(() => priceTickers.slice().sort().join('|'), [priceTickers]);

    const latestPricesAll = useLiveQuery(
        async () => {
            if (!priceTickers.length) return [];
            const t0 = performance.now();
            const rows = await queryLatestPricesForTickers({
                portfolioId: currentPortfolioId,
                tickers: priceTickers
            });
            if (import.meta.env.DEV) {
                console.log('[PERF][Rebalance] latest prices', Math.round(performance.now() - t0), 'ms', {
                    tickers: priceTickers.length,
                    count: rows.length
                });
            }
            return rows;
        },
        [currentPortfolioId, priceTickersKey],
        []
    );

    const fxPairs = useMemo(() => {
        const base = Currency.CHF;
        const set = new Set<string>();
        (instruments || []).forEach(instr => {
            if (instr.currency && instr.currency !== base) {
                set.add(`${instr.currency}/${base}`);
            }
        });
        return Array.from(set.values());
    }, [instruments]);

    const fxPairsKey = useMemo(() => fxPairs.slice().sort().join('|'), [fxPairs]);

    const holdings = useMemo(() => {
        return calculateHoldings(transactions || []);
    }, [transactions]);

    const valuationDate = useMemo(() => {
        if (!transactions || !latestPricesAll) return '';
        return getValuationDateForHoldings(transactions, latestPricesAll, instruments || []) || '';
    }, [transactions, latestPricesAll, instruments]);

    const prices = useLiveQuery(
        async () => {
            if (!priceTickers.length || !valuationDate) return [];
            const t0 = performance.now();
            const rows = await queryLatestPricesForTickers({
                portfolioId: currentPortfolioId,
                tickers: priceTickers,
                upToDate: valuationDate
            });
            if (import.meta.env.DEV) {
                console.log('[PERF][Rebalance] prices at valuation', Math.round(performance.now() - t0), 'ms', {
                    tickers: priceTickers.length,
                    count: rows.length,
                    valuationDate
                });
            }
            return rows;
        },
        [currentPortfolioId, priceTickersKey, valuationDate],
        []
    );

    const fxRates = useLiveQuery(
        async () => {
            if (!fxPairs.length || !valuationDate) return [];
            const t0 = performance.now();
            const rows = await queryLatestFxForPairs({
                pairs: fxPairs,
                upToDate: valuationDate
            });
            if (import.meta.env.DEV) {
                console.log('[PERF][Rebalance] latest fx', Math.round(performance.now() - t0), 'ms', {
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

    const rebalanceQuality = useMemo(() => {
        if (!transactions || !prices || !instruments || !fxRates || !valuationDate) return null;
        return analyzeRebalanceQuality(holdings, instruments, prices, fxRates, valuationDate, Currency.CHF);
    }, [transactions, prices, instruments, fxRates, valuationDate, holdings]);

    const rebalanceData = useMemo(() => {
        if (!transactions || !prices || !instruments || !fxRates || !valuationDate) return null;
        const uniqueInstruments = Array.from(
            new Map(instruments.map(inst => [inst.ticker, inst])).values()
        );
        const positions: PortfolioPosition[] = [];
        let totalValueCHF = 0;
        const fxDates: string[] = [];
        const valuationMeta = new Map<string, { priceCurrency: Currency; priceDate?: string; fxDate?: string; fxRateToChf?: number; valueLocal: number }>();

        holdings.forEach((qty, ticker) => {
            if (qty <= 0.000001) return;
            const instr = uniqueInstruments.find(i => i.ticker === ticker);
            if (!instr) return;
            const priceTicker = getCanonicalTicker(instr);
            const pricePoint = getLatestPricePoint(priceTicker, valuationDate, prices);
            const price = pricePoint?.close || 0;
            const priceCurrency = (pricePoint?.currency || instr.currency || Currency.CHF) as Currency;
            const valueLocal = qty * price;
            let fxRateToChf: number | undefined;
            let fxDate: string | undefined;
            let valueCHF = 0;
            if (priceCurrency === Currency.CHF) {
                fxRateToChf = 1;
                fxDate = valuationDate;
                valueCHF = valueLocal;
            } else {
                const converted = convertAmountFromSeries(valueLocal, priceCurrency, Currency.CHF, valuationDate, fxRates);
                if (converted) {
                    fxRateToChf = converted.lookup.rate;
                    fxDate = converted.lookup.date;
                    fxDates.push(converted.lookup.date);
                    valueCHF = converted.value;
                }
            }
            totalValueCHF += valueCHF;
            positions.push({
                ticker: instr.ticker,
                name: instr.name,
                assetType: instr.type,
                assetClass: instr.assetClass,
                currency: instr.currency,
                quantity: qty,
                currentPrice: price,
                currentValueCHF: valueCHF,
                targetPct: instr.targetAllocation || 0,
                currentPct: 0
            });
            valuationMeta.set(instr.ticker, {
                priceCurrency,
                priceDate: pricePoint?.date,
                fxDate,
                fxRateToChf,
                valueLocal
            });
        });

        positions.forEach(p => {
            p.currentPct = totalValueCHF > 0 ? (p.currentValueCHF / totalValueCHF) * 100 : 0;
        });

        const oldestFxDate = fxDates.length ? fxDates.sort()[0] : '';

        return { positions, totalValueCHF, valuationMeta, oldestFxDate };
    }, [transactions, prices, instruments, fxRates, valuationDate, holdings]);

    // 2. Calculate Rebalancing Suggestions
    const rebalancingPlan = useMemo(() => {
        if (!rebalanceData) return [];
        return calculateRebalancing(rebalanceData.positions, rebalanceData.totalValueCHF, strategy, cashInjection);
    }, [rebalanceData, strategy, cashInjection]);

    const positionByTicker = useMemo(() => {
        if (!rebalanceData) return new Map<string, PortfolioPosition>();
        return new Map(rebalanceData.positions.map(pos => [pos.ticker, pos]));
    }, [rebalanceData]);

    const hasFxStale = useMemo(() => {
        if (!rebalanceQuality?.issues) return false;
        return rebalanceQuality.issues.some(issue => issue.type === 'fxStale');
    }, [rebalanceQuality]);

    const unvaluedTickers = useMemo(() => {
        if (!rebalanceQuality?.statusByTicker) return [];
        return Object.entries(rebalanceQuality.statusByTicker)
            .filter(([, status]) => status === 'UNVALUED')
            .map(([ticker]) => ticker);
    }, [rebalanceQuality]);

    const isRebalanceBlocked = unvaluedTickers.length > 0;

    const issueHighlights = useMemo(() => {
        const issues = rebalanceQuality?.issues || [];
        const priceMissing = Array.from(new Set(
            issues.filter(i => i.type === 'priceMissing').map(i => i.priceTicker || i.ticker)
        )).slice(0, 3);
        const priceStaleIssues = issues.filter(i => i.type === 'priceStale');
        const priceStaleTickers = Array.from(new Set(priceStaleIssues.map(i => i.priceTicker || i.ticker))).slice(0, 3);
        const oldestPriceDate = priceStaleIssues
            .map(i => i.priceDate)
            .filter(Boolean)
            .sort()
            .shift();
        const fxIssues = issues.filter(i => i.type === 'fxMissing' || i.type === 'fxStale');
        const fxPairs = Array.from(new Set(
            fxIssues.map(i => `${i.fxBase || 'FX'}→${i.fxQuote || 'CHF'}`)
        )).slice(0, 3);
        const fxOldestDate = fxIssues
            .map(i => i.fxDate)
            .filter(Boolean)
            .sort()
            .shift();

        const items = [];
        if (priceMissing.length) {
            items.push({
                title: 'Prezzo mancante',
                detail: `Ticker: ${priceMissing.join(', ')}`
            });
        }
        if (fxPairs.length) {
            items.push({
                title: 'FX mancante/stale',
                detail: `${fxPairs.join(', ')}${fxOldestDate ? ` · ultimo ${fxOldestDate}` : ''}`
            });
        }
        if (priceStaleTickers.length) {
            items.push({
                title: 'Copertura insufficiente',
                detail: `${priceStaleTickers.join(', ')}${oldestPriceDate ? ` · ultimo prezzo ${oldestPriceDate}` : ''}`
            });
        }
        return items.slice(0, 3);
    }, [rebalanceQuality]);

    // 3. Group by Macro and calculate deviations for visualization
    const groupedPlan = useMemo(() => {
        if (!rebalancingPlan || !instruments) return {};

        const grouped: Record<string, {
            items: typeof rebalancingPlan,
            totalCurrentPct: number,
            totalTargetPct: number
        }> = {};

        rebalancingPlan.forEach(item => {
            const instr = instruments.find(i => i.ticker === item.ticker);
            const macro = getMacroCategory(instr);

            if (!grouped[macro]) {
                grouped[macro] = { items: [], totalCurrentPct: 0, totalTargetPct: 0 };
            }
            grouped[macro].items.push(item);
            grouped[macro].totalCurrentPct += item.currentPct;
            grouped[macro].totalTargetPct += item.targetPct;
        });

        return grouped;
    }, [rebalancingPlan, instruments]);

    // Handle Target Update
    const startEdit = (ticker: string, currentVal: number) => {
        const instr = instruments?.find(i => i.ticker === ticker);
        setEditTargetId(instr?.id ?? null);
        setEditTargetTicker(ticker);
        setTempTargetVal(currentVal.toFixed(1));
    };

    const saveTarget = async () => {
        const parsed = Number(String(tempTargetVal).replace(',', '.'));
        if (!Number.isFinite(parsed)) {
            setEditTargetId(null);
            setEditTargetTicker(null);
            return;
        }
        const nextValue = Math.max(0, Math.min(100, parsed));
        let didUpdate = false;
        if (editTargetTicker) {
            const modified = await db.instruments
                .where('ticker')
                .equals(editTargetTicker)
                .and(i => i.portfolioId === currentPortfolioId)
                .modify({ targetAllocation: nextValue });
            didUpdate = Number(modified) > 0;
        }
        if (!didUpdate && editTargetId) {
            await db.instruments.update(editTargetId, { targetAllocation: nextValue });
        }
        setTempTargetVal(nextValue.toFixed(1));
        setEditTargetId(null);
        setEditTargetTicker(null);
    };

    const handleOpenEditAsset = (instrument: Instrument) => {
        const regionInfo = getPrimaryRegionInfo(instrument.regionAllocation);
        const regionValue = regionInfo.count > 1
            ? ''
            : (regionInfo.key || (isRegionKey(instrument.region) ? instrument.region : ''));
        const initialRegion = regionInfo.count === 0 && regionValue ? '' : regionValue;
        setEditingAsset(instrument);
        setEditAssetForm({
            name: instrument.name || instrument.ticker,
            type: instrument.type || AssetType.Stock,
            assetClass: instrument.assetClass || AssetClass.STOCK,
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

        let didUpdate = false;
        if (editingAsset.id) {
            const updated = await db.instruments.update(editingAsset.id, payload);
            didUpdate = updated > 0;
        }
        if (!didUpdate) {
            await db.instruments
                .where('ticker')
                .equals(editingAsset.ticker)
                .and(i => i.portfolioId === currentPortfolioId)
                .modify(payload);
        }

        handleCloseEditAsset();
    };

    const tintColor = (hex: string, mix = 0.6) => {
        const normalized = hex.replace('#', '');
        if (normalized.length !== 6) return hex;
        const r = parseInt(normalized.slice(0, 2), 16);
        const g = parseInt(normalized.slice(2, 4), 16);
        const b = parseInt(normalized.slice(4, 6), 16);
        const to = (v: number) => Math.round(v + (255 - v) * mix).toString(16).padStart(2, '0');
        return `#${to(r)}${to(g)}${to(b)}`;
    };

    const DeviationBlock = ({ deviation, color, muted }: { deviation: number; color?: string; muted?: boolean }) => {
        // Thresholds
        const isUnderweight = deviation < -0.5;
        const isOverweight = deviation > 0.5;
        const isNeutral = !isUnderweight && !isOverweight;

        // Scale intensity
        const intensity = Math.min(Math.abs(deviation), 5) / 5;
        const baseColor = color || '#94a3b8';
        const toneColor = muted ? tintColor(baseColor, 0.65) : baseColor;
        const alpha = muted ? 0.6 : 0.85;

        return (
            <div className="grid grid-cols-3 h-8 w-full gap-0.5 bg-slate-200 rounded overflow-hidden border border-white">
                {/* Sottopesato (LEFT) */}
                <div className="flex items-center justify-center relative">
                    {isUnderweight && (
                        <div
                            className="h-full transition-all"
                            style={{ width: `${Math.max(20, intensity * 100)}%` }}
                            aria-label="Sottopesato"
                        >
                            <div
                                className="h-full w-full"
                                style={{ backgroundColor: toneColor, opacity: alpha }}
                            />
                        </div>
                    )}
                </div>

                {/* Neutro (CENTER) */}
                <div className="flex items-center justify-center relative border-x border-white">
                    {isNeutral && (
                        <div
                            className="w-2 h-2 rounded-full shadow-lg"
                        style={{ backgroundColor: toneColor, opacity: muted ? 0.5 : 0.9 }}
                            aria-label="Neutro"
                        />
                    )}
                </div>

                {/* Sovrapesato (RIGHT) */}
                <div className="flex items-center justify-center relative">
                    {isOverweight && (
                        <div
                            className="h-full transition-all"
                            style={{ width: `${Math.max(20, intensity * 100)}%` }}
                            aria-label="Sovrapesato"
                        >
                            <div
                                className="h-full w-full"
                                style={{ backgroundColor: toneColor, opacity: alpha }}
                            />
                        </div>
                    )}
                </div>
            </div>
        );
    };

    if (!rebalanceData) return <div className="p-10 text-center text-gray-500 flex flex-col items-center gap-3"><span className="material-symbols-outlined animate-spin text-primary">donut_large</span> Calcolo...</div>;

    return (
        <div className="space-y-6 pb-20 animate-fade-in text-textPrimary">

            {isEditAssetModalOpen && editingAsset && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-md">
                    <div className="ui-panel-dense w-full max-w-lg p-6 relative">
                        <div className="flex items-start justify-between">
                            <div>
                                <h3 className="text-lg font-bold text-slate-900">Modifica Asset</h3>
                                <p className="text-xs text-slate-500 font-medium">{editingAsset.ticker}</p>
                            </div>
                            <button
                                onClick={handleCloseEditAsset}
                                className="text-slate-400 hover:text-slate-700 transition"
                                aria-label="Chiudi"
                            >
                                <span className="material-symbols-outlined">close</span>
                            </button>
                        </div>

                        <form onSubmit={handleSaveAssetMeta} className="mt-4 space-y-4">
                            <div>
                                <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">Nome</label>
                                <input
                                    value={editAssetForm.name}
                                    onChange={e => setEditAssetForm({ ...editAssetForm, name: e.target.value })}
                                    className="ui-input w-full text-sm"
                                />
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">Tipo</label>
                                    <select
                                        value={editAssetForm.type}
                                        onChange={e => setEditAssetForm({ ...editAssetForm, type: e.target.value as AssetType })}
                                        className="ui-input w-full text-sm"
                                    >
                                        {Object.values(AssetType).map(type => (
                                            <option key={type} value={type}>{type}</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">Asset Class</label>
                                    <select
                                        value={editAssetForm.assetClass}
                                        onChange={e => setEditAssetForm({ ...editAssetForm, assetClass: e.target.value as AssetClass })}
                                        className="ui-input w-full text-sm"
                                    >
                                        {Object.values(AssetClass).map(ac => (
                                            <option key={ac} value={ac}>{ac}</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">Valuta</label>
                                    <select
                                        value={editAssetForm.currency}
                                        onChange={e => setEditAssetForm({ ...editAssetForm, currency: e.target.value as Currency })}
                                        className="ui-input w-full text-sm"
                                    >
                                        {Object.values(Currency).map(cur => (
                                            <option key={cur} value={cur}>{cur}</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">Settore</label>
                                    <input
                                        value={editAssetForm.sector}
                                        onChange={e => setEditAssetForm({ ...editAssetForm, sector: e.target.value })}
                                        className="ui-input w-full text-sm"
                                    />
                                </div>
                            </div>

                            <div>
                                <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">Geografia</label>
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
                                    className="flex-1 ui-btn-secondary py-3 rounded-xl font-bold transition"
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

            {/* HEADER CONTROLS */}
            <div className="ui-panel p-6">
                <h2 className="text-xl font-bold mb-6 flex items-center gap-2 text-slate-900">
                    <span className="material-symbols-outlined text-[#0052a3]">balance</span>
                    Pannello Ribilanciamento
                </h2>
                {valuationDate && (
                    <div className="text-xs text-slate-500 mb-4 flex flex-wrap items-center gap-2">
                        <span>Base currency: CHF</span>
                        <span>•</span>
                        <span>Valuation date: {valuationDate}</span>
                        <span>•</span>
                        <span>FX used: {rebalanceData?.oldestFxDate || 'N/D'}</span>
                        {hasFxStale && (
                            <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 font-bold border border-amber-200">
                                FX stale
                            </span>
                        )}
                    </div>
                )}
                {isRebalanceBlocked && (
                    <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 flex flex-col gap-2">
                        <div className="font-bold">Alcuni strumenti hanno dati incompleti. Il rebalance e limitato.</div>
                        <div>Ticker senza valutazione: {unvaluedTickers.join(', ')}</div>
                        {issueHighlights.length > 0 && (
                            <div className="mt-1 space-y-1">
                                {issueHighlights.map((item, idx) => (
                                    <div key={`${item.title}-${idx}`} className="flex items-start gap-2">
                                        <span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-amber-600" />
                                        <div>
                                            <div className="font-semibold">{item.title}</div>
                                            <div className="text-amber-700">{item.detail}</div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                        <div>
                            <a
                                href="#/data?tab=checks"
                                className="inline-flex items-center gap-1 text-amber-700 font-bold hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                            >
                                Vai a Data Inspector
                            </a>
                            <span className="mx-2 text-amber-600">·</span>
                            <a
                                href="#/settings"
                                className="inline-flex items-center gap-1 text-amber-700 font-bold hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                            >
                                Vai a Settings → Sync/FX
                            </a>
                        </div>
                    </div>
                )}

                <div className="flex flex-col md:flex-row gap-8">
                    <div className="flex-1">
                        <label className="block text-xs font-bold text-slate-400 uppercase mb-3">Strategia</label>
                        <div className="flex gap-3">
                            <button
                                onClick={() => setStrategy(RebalanceStrategy.Accumulate)}
                                className={clsx(
                                    "flex-1 py-3 px-4 rounded-xl border text-sm font-bold transition-all shadow-lg",
                                    strategy === RebalanceStrategy.Accumulate ? "border-[#0052a3] text-white shadow-md bg-[#0052a3]" : "border-borderSoft text-slate-500 hover:bg-slate-50"
                                )}
                            >
                                Accumulo (Acquisti)
                            </button>
                            <button
                                onClick={() => setStrategy(RebalanceStrategy.Maintain)}
                                className={clsx(
                                    "flex-1 py-3 px-4 rounded-xl border text-sm font-bold transition-all shadow-lg",
                                    strategy === RebalanceStrategy.Maintain ? "border-[#0052a3] text-white shadow-md bg-[#0052a3]" : "border-borderSoft text-slate-500 hover:bg-slate-50"
                                )}
                            >
                                Mantenimento
                            </button>
                        </div>
                    </div>

                    {strategy === RebalanceStrategy.Accumulate && (
                        <div className="flex-1">
                            <label className="block text-xs font-bold text-gray-400 uppercase mb-3">Nuova Liquidita (CHF)</label>
                            <div className="relative">
                                <input
                                    type="number"
                                    value={cashInjection}
                                    onChange={e => setCashInjection(Number(e.target.value))}
                                    className="ui-input w-full font-mono text-lg font-bold text-right"
                                />
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* HEATMAP TABLE */}
            <div className="ui-panel-dense rounded-2xl overflow-hidden overflow-x-auto">
                <table className="w-full text-sm text-left">
                    <thead className="bg-slate-100 text-slate-500 border-b border-borderSoft text-xs uppercase tracking-wider">
                        <tr>
                            <th className="px-4 py-4 font-bold w-[25%]">Asset Class / Strumento</th>
                            <th className="px-2 py-4 font-bold text-center w-[10%]">Target</th>
                            <th className="px-2 py-4 font-bold text-center w-[10%]">Attuale</th>
                            <th className="px-0 py-4 font-bold text-center w-[25%] bg-slate-50">
                                <div className="grid grid-cols-3 text-[10px] opacity-70">
                                    <span>Sottopesato</span>
                                    <span>Neutro</span>
                                    <span>Sovrapesato</span>
                                </div>
                            </th>
                            <th className="px-4 py-4 font-bold text-right w-[15%]">Attuale / Quote</th>
                            <th className="px-4 py-4 font-bold text-right w-[10%]">Quote</th>
                            <th className="px-4 py-4 font-bold text-right w-[15%]">Azione Consigliata</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-borderSoft">
                        {MACRO_ORDER.filter(m => groupedPlan[m]).map(macro => {
                            const group = groupedPlan[macro];
                            const macroDiff = group.totalCurrentPct - group.totalTargetPct;
                            const macroColor = MACRO_COLORS[macro as ReturnType<typeof getMacroCategory>] || '#0052a3';

                            return (
                                <React.Fragment key={macro}>
                                    {/* MACRO HEADER ROW */}
                                    <tr className="bg-slate-50 border-b border-borderSoft">
                                        <td
                                            className="px-4 py-3 font-bold flex items-center gap-2 border-l-4"
                                            style={{ color: macroColor, borderLeftColor: macroColor }}
                                        >
                                            {macro}
                                        </td>
                                        <td className="px-2 py-3 font-bold text-center text-slate-700">{group.totalTargetPct.toFixed(1)}%</td>
                                        <td className="px-2 py-3 font-bold text-center text-slate-700">{group.totalCurrentPct.toFixed(1)}%</td>
                                        <td className="px-0 py-1">
                                            <div className="px-4 w-full">
                                                <DeviationBlock deviation={macroDiff} color={macroColor} />
                                            </div>
                                        </td>
                                        <td className="px-4 py-3 text-right"></td>
                                        <td className="px-4 py-3 text-right"></td>
                                        <td className="px-4 py-3 text-right"></td>
                                    </tr>

                                    {/* ITEMS */}
                                    {group.items.map(p => {
                                        const instr = instruments?.find(i => i.ticker === p.ticker);
                                        const isEditing = instr?.id === editTargetId;
                                        const diff = p.currentPct - p.targetPct;
                                        const itemColor = macroColor;
                                        const position = positionByTicker.get(p.ticker);
                                        const meta = rebalanceData?.valuationMeta.get(p.ticker);
                                        const heldQty = position?.quantity ?? 0;
                                        const priceCurrency = (meta?.priceCurrency || instr?.currency || position?.currency || Currency.CHF) as Currency;
                                        const instrumentCurrency = (instr?.currency || position?.currency || priceCurrency) as Currency;
                                        const assetCurrency = priceCurrency;
                                        const assetClassLabelIt = instr?.assetClass === AssetClass.ETF_BOND ? 'ETF Obbligazioni'
                                            : instr?.assetClass === AssetClass.ETF_STOCK ? 'ETF Azioni'
                                                : instr?.assetClass === AssetClass.BOND ? 'Obbligazioni'
                                                    : instr?.assetClass === AssetClass.STOCK ? 'Azioni'
                                                        : instr?.assetClass === AssetClass.ETC ? 'ETC'
                                                            : instr?.assetClass === AssetClass.CRYPTO ? 'Cripto'
                                                                : instr?.assetClass === AssetClass.CASH ? 'Liquidita'
                                                                    : instr?.assetClass === AssetClass.OTHER ? 'Altro'
                                                                        : '';
                                        const currentValue = meta?.valueLocal ?? ((position?.currentPrice ?? 0) * heldQty);
                                        const status = rebalanceQuality?.statusByTicker[p.ticker] || 'OK';
                                        const issues = rebalanceQuality?.issuesByTicker[p.ticker] || [];
                                        const sortedIssues = [...issues].sort((a, b) => {
                                            const priority: Record<string, number> = {
                                                priceMissing: 0,
                                                fxMissing: 1,
                                                currencyMismatch: 2,
                                                priceStale: 3,
                                                fxStale: 4
                                            };
                                            return (priority[a.type] ?? 99) - (priority[b.type] ?? 99);
                                        });
                                        const issueHelps = sortedIssues.map(getIssueHelp);
                                        const isTradable = !isRebalanceBlocked && status === 'OK';
                                        const hasMismatch = sortedIssues.some(issue => issue.type === 'currencyMismatch');
                                        const priceValue = position?.currentPrice ?? 0;
                                        const formatPrice = (value: number) => {
                                            if (!Number.isFinite(value) || value <= 0) return '—';
                                            const decimals = value < 1 ? 4 : 2;
                                            return value.toLocaleString('it-CH', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
                                        };
                                        const amountLocal = meta?.fxRateToChf ? (p.amount / meta.fxRateToChf) : null;
                                        const baseCurrency = Currency.CHF;
                                        const isNeutral = p.action === 'NEUTRO' || p.amount <= 0;
                                        const isCashLike = instr?.type === AssetType.Cash;
                                        const signedDelta = p.action === 'VENDI' ? -p.amount : p.amount;
                                        const isUnvalued = unvaluedTickers.includes(p.ticker);
                                        const unitsResult = (!isTradable || isUnvalued || isCashLike)
                                            ? { reason: 'invalid' as const }
                                            : computeRebalanceUnits({
                                                deltaBase: signedDelta,
                                                baseCurrency,
                                                instrumentCurrency,
                                                price: priceValue,
                                                priceCurrency,
                                                fxRates,
                                                valuationDate
                                            });
                                        const formatUnits = (value: number) => {
                                            if (!Number.isFinite(value)) return '—';
                                            const decimals = instr?.type === AssetType.Crypto ? 6 : 4;
                                            return value.toLocaleString('it-CH', { minimumFractionDigits: 0, maximumFractionDigits: decimals });
                                        };
                                        const unitsLabel = isNeutral
                                            ? '0'
                                            : (unitsResult.units !== undefined && Number.isFinite(unitsResult.units))
                                                ? formatUnits(unitsResult.units)
                                                : '—';
                                        const unitsTitle = unitsLabel === '—'
                                            ? (unitsResult.reason === 'currency_mismatch'
                                                ? 'Valuta prezzo non coerente con la valuta dello strumento'
                                                : unitsResult.reason === 'missing_fx'
                                                    ? 'Manca FX per convertire il delta'
                                                    : 'Manca prezzo o FX per calcolare le quote')
                                            : undefined;

                                        return (
                                            <tr key={p.ticker} className="hover:bg-slate-50 transition-colors group">
                                                {/* Ticker & Name */}
                                                <td className="px-4 py-3 pl-8">
                                                    <div className="flex items-start justify-between gap-2">
                                                        <div>
                                                            <div className="font-semibold text-slate-700">{p.name || p.ticker}</div>
                                                            <div className="text-xs text-slate-400 truncate max-w-[180px] group-hover:text-slate-600">
                                                                {p.ticker}{instr?.isin ? ` - ISIN ${instr.isin}` : ''}
                                                            </div>
                                                        </div>
                                                        {instr && (
                                                            <button
                                                                type="button"
                                                                onClick={() => handleOpenEditAsset(instr)}
                                                                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition"
                                                                title="Modifica asset"
                                                            >
                                                                <span className="material-symbols-outlined text-[18px]">edit</span>
                                                            </button>
                                                        )}
                                                    </div>
                                                    {assetClassLabelIt && (
                                                        <span className="mt-1 inline-flex items-center text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">
                                                            {assetClassLabelIt}
                                                        </span>
                                                    )}
                                                </td>

                                                {/* Target % (Editable) */}
                                                <td className="px-2 py-3 text-center">
                                                    {isEditing ? (
                                                        <input
                                                            autoFocus
                                                            className="ui-input-sm w-14 text-center font-bold"
                                                            value={tempTargetVal}
                                                            onChange={e => setTempTargetVal(e.target.value)}
                                                            onKeyDown={e => e.key === 'Enter' && saveTarget()}
                                                            onBlur={saveTarget}
                                                        />
                                                    ) : (
                                                        <div
                                                            onClick={() => startEdit(p.ticker, p.targetPct)}
                                                            className="cursor-pointer hover:text-primary transition-colors font-mono font-medium text-slate-500 decoration-dotted underline underline-offset-4"
                                                            title="Modifica Target"
                                                        >
                                                            {p.targetPct.toFixed(1)}%
                                                        </div>
                                                    )}
                                                </td>

                                                {/* Current % */}
                                                <td className="px-2 py-3 text-center text-slate-700 font-mono">
                                                    {p.currentPct.toFixed(1)}%
                                                </td>

                                                {/* Deviation Visual */}
                                                <td className="px-0 py-2 align-middle">
                                                    <div className="px-4 w-full">
                                                        <DeviationBlock deviation={diff} color={itemColor} muted />
                                                    </div>
                                                </td>

                                                {/* Current / Quantity */}
                                                <td className="px-4 py-3 text-right">
                                                    <div className="text-xs font-medium text-slate-600">
                                                        {assetCurrency} {currentValue.toLocaleString('it-CH', { maximumFractionDigits: 2 })}
                                                    </div>
                                                    <div className="text-[11px] text-slate-400">
                                                        Quote: {heldQty.toLocaleString('it-CH', { maximumFractionDigits: 6 })}
                                                    </div>
                                                    <div className="text-[11px] text-slate-400">
                                                        Px: {assetCurrency} {formatPrice(priceValue)}
                                                        {meta?.priceDate && meta.priceDate !== valuationDate ? ` (${meta.priceDate})` : ''}
                                                        {hasMismatch ? ' (mismatch)' : ''}
                                                    </div>
                                                </td>

                                                {/* Units */}
                                                <td className="px-4 py-3 text-right">
                                                    <div
                                                        className={clsx('text-xs font-mono', unitsLabel === '—' ? 'text-slate-400' : 'text-slate-600')}
                                                        title={unitsTitle}
                                                    >
                                                        {unitsLabel}
                                                    </div>
                                                </td>

                                                {/* Action */}
                                                <td className="px-4 py-3 text-right">
                                                    <div className="flex flex-col items-end gap-1">
                                                        {!isTradable ? (
                                                            <InfoPopover
                                                                ariaLabel="Dettagli dati incompleti"
                                                                title="Dati incompleti"
                                                                triggerContent="Dati incompleti"
                                                                triggerClassName="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-amber-100 text-amber-700 focus:outline-none focus:ring-2 focus:ring-primary"
                                                                popoverClassName="right-0"
                                                                renderContent={() => (
                                                                    <div className="space-y-2">
                                                                        {issueHelps.length === 0 ? (
                                                                            <div className="text-xs">
                                                                                <div className="font-bold text-slate-900">Rebalance limitato</div>
                                                                                <div className="text-slate-600">Almeno un asset non e valutabile. Verifica i dati.</div>
                                                                                <a href="#/data?tab=checks" className="text-primary font-bold hover:underline">
                                                                                    Apri Data Inspector (Check)
                                                                                </a>
                                                                            </div>
                                                                        ) : (
                                                                            issueHelps.slice(0, 5).map((help, idx) => (
                                                                                <div key={`${p.ticker}-issue-${idx}`} className="text-xs">
                                                                                    <div className="font-bold text-slate-900">{help.title}</div>
                                                                                    <div className="text-slate-600">{help.description}</div>
                                                                                    <a href={help.href} className="text-primary font-bold hover:underline">
                                                                                        {help.ctaLabel}
                                                                                    </a>
                                                                                </div>
                                                                            ))
                                                                        )}
                                                                    </div>
                                                                )}
                                                            />
                                                        ) : (
                                                            <span className={clsx(
                                                                "px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider",
                                                                p.action === 'COMPRA' ? "bg-green-500/20 text-green-400" :
                                                                    p.action === 'VENDI' ? "bg-red-500/20 text-red-400" :
                                                                        "bg-gray-500/20 text-gray-500"
                                                            )}>
                                                                {p.action}
                                                            </span>
                                                        )}
                                                        {isTradable && p.amount > 0 && (
                                                            <span className="text-xs font-mono text-slate-500">
                                                                CHF {p.amount.toLocaleString('it-CH', { maximumFractionDigits: 0 })}
                                                            </span>
                                                        )}
                                                        {isTradable && p.amount > 0 && amountLocal !== null && (
                                                            <span className="text-[11px] text-slate-400">
                                                                ≈ {assetCurrency} {amountLocal.toLocaleString('it-CH', { maximumFractionDigits: 0 })}
                                                            </span>
                                                        )}
                                                    </div>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </React.Fragment>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            {/* Summary Footer */}
            <div className="text-center text-xs text-slate-500 mt-4">
                Valore Totale Stimato Post-Ribilanciamento: CHF <span className="font-bold text-slate-900">{(rebalanceData.totalValueCHF + (strategy === RebalanceStrategy.Accumulate ? cashInjection : 0)).toLocaleString()}</span>
            </div>
        </div>
    );
};




