import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { db, getCurrentPortfolioId } from '../db';
import { useLiveQuery } from 'dexie-react-hooks';
import { calculateHoldings, calculateRebalancing, getCanonicalTicker, getLatestPricePoint, getValuationDateForHoldings } from '../services/financeUtils';
import { computeHoldingsPriceDateStats } from '../services/dataFreshness';
import { diffDaysYmd } from '../services/dateUtils';
import { RebalanceStrategy, AssetType, AssetClass, Instrument, Currency, RegionKey, PortfolioPosition, RebalancePlan } from '../types';
import { convertAmountFromSeries } from '../services/fxService';
import { analyzeRebalanceQuality, getIssueHelp } from '../services/dataQuality';
import { queryLatestFxForPairs, queryLatestPricesForTickers } from '../services/dbQueries';
import { InfoPopover } from '../components/InfoPopover';
import { DataStatusBar } from '../components/DataStatusBar';
import { computeRebalanceUnits } from '../services/rebalanceUtils';
import { clearDraft, getDraftAgeLabel, loadDraft, saveDraft, type RebalanceDraftV1 } from '../services/rebalanceDraft';
import { deletePlan, duplicatePlan, listPlans, savePlan as saveRebalancePlan } from '../services/rebalancePlanService';
import { buildRebalancePlanCsv, downloadCsv } from '../services/csvExport';
import { formatQuantity } from '../services/quantityFormat';

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
    const defaultStrategy = RebalanceStrategy.Accumulate;
    const defaultCashInjection = 0;
    const [draft, setDraft] = useState<RebalanceDraftV1 | null>(null);
    const [draftReady, setDraftReady] = useState(false);
    const saveTimeoutRef = useRef<number | null>(null);
    const lastSnapshotRef = useRef<string | null>(null);
    const [isPlanModalOpen, setPlanModalOpen] = useState(false);
    const [planList, setPlanList] = useState<RebalancePlan[]>([]);
    const [planNotice, setPlanNotice] = useState<string | null>(null);
    const [planLoading, setPlanLoading] = useState(false);
    const [expandedPlanId, setExpandedPlanId] = useState<string | null>(null);

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

    const priceStats = useMemo(() => {
        return computeHoldingsPriceDateStats(transactions || [], instruments || [], latestPricesAll || []);
    }, [transactions, instruments, latestPricesAll]);

    const valuationDate = useMemo(() => {
        if (!transactions || !latestPricesAll) return '';
        return getValuationDateForHoldings(transactions, latestPricesAll, instruments || []) || '';
    }, [transactions, latestPricesAll, instruments]);

    const priceLatestAsOf = priceStats.priceLatestAsOf;
    const rebalanceDate = priceLatestAsOf || valuationDate || '';

    const draftSnapshotBase = useCallback(() => ({
        v: 1 as const,
        portfolioId: currentPortfolioId,
        valuationDate: rebalanceDate || undefined,
        baseCurrency: Currency.CHF,
        strategy,
        totalAmount: cashInjection
    }), [currentPortfolioId, rebalanceDate, strategy, cashInjection]);

    const buildDraftSnapshot = useCallback(() => JSON.stringify(draftSnapshotBase()), [draftSnapshotBase]);

    const persistDraft = useCallback((force = false) => {
        if (!draftReady) return;
        const snapshot = buildDraftSnapshot();
        if (!force && snapshot === lastSnapshotRef.current) return;
        const payload: RebalanceDraftV1 = { ...draftSnapshotBase(), savedAt: Date.now() };
        saveDraft(currentPortfolioId, payload);
        setDraft(payload);
        lastSnapshotRef.current = snapshot;
    }, [buildDraftSnapshot, currentPortfolioId, draftReady, draftSnapshotBase]);

    const isDraftStale = draft ? Date.now() - draft.savedAt > 30 * 24 * 60 * 60 * 1000 : false;
    const isDraftApplied = !!draft && draft.strategy === strategy && (draft.totalAmount ?? 0) === cashInjection;
    const draftAgeLabel = draft ? getDraftAgeLabel(draft.savedAt) : '';

    useEffect(() => {
        setDraftReady(false);
        const loaded = loadDraft(currentPortfolioId);
        setDraft(loaded);
        const initialSnapshot = JSON.stringify({
            v: 1,
            portfolioId: currentPortfolioId,
            valuationDate: rebalanceDate || undefined,
            baseCurrency: Currency.CHF,
            strategy: defaultStrategy,
            totalAmount: defaultCashInjection
        });
        lastSnapshotRef.current = loaded ? JSON.stringify({
            v: 1,
            portfolioId: loaded.portfolioId,
            valuationDate: loaded.valuationDate,
            baseCurrency: loaded.baseCurrency,
            strategy: loaded.strategy ?? defaultStrategy,
            totalAmount: loaded.totalAmount ?? defaultCashInjection
        }) : initialSnapshot;
        setDraftReady(true);

        const isLoadedStale = loaded ? Date.now() - loaded.savedAt > 30 * 24 * 60 * 60 * 1000 : false;
        const canAutoApply = strategy === defaultStrategy && cashInjection === defaultCashInjection;
        if (loaded && !isLoadedStale && canAutoApply) {
            setStrategy((loaded.strategy as RebalanceStrategy) || defaultStrategy);
            setCashInjection(typeof loaded.totalAmount === 'number' ? loaded.totalAmount : defaultCashInjection);
        }
    }, [currentPortfolioId]);

    useEffect(() => {
        if (!draftReady) return;
        const snapshot = buildDraftSnapshot();
        if (snapshot === lastSnapshotRef.current) return;
        if (saveTimeoutRef.current) window.clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = window.setTimeout(() => {
            persistDraft();
        }, 450);
        return () => {
            if (saveTimeoutRef.current) window.clearTimeout(saveTimeoutRef.current);
        };
    }, [buildDraftSnapshot, draftReady, persistDraft]);

    useEffect(() => {
        if (!draftReady) return;
        const handleBeforeUnload = () => {
            persistDraft(true);
        };
        window.addEventListener('beforeunload', handleBeforeUnload);
        return () => window.removeEventListener('beforeunload', handleBeforeUnload);
    }, [draftReady, persistDraft]);

    const handleRestoreDraft = useCallback(() => {
        if (!draft) return;
        setStrategy((draft.strategy as RebalanceStrategy) || defaultStrategy);
        setCashInjection(typeof draft.totalAmount === 'number' ? draft.totalAmount : defaultCashInjection);
    }, [draft, defaultCashInjection, defaultStrategy]);

    const handleResetDraft = useCallback(() => {
        clearDraft(currentPortfolioId);
        setDraft(null);
        setStrategy(defaultStrategy);
        setCashInjection(defaultCashInjection);
        lastSnapshotRef.current = JSON.stringify({
            v: 1,
            portfolioId: currentPortfolioId,
            valuationDate: rebalanceDate || undefined,
            baseCurrency: Currency.CHF,
            strategy: defaultStrategy,
            totalAmount: defaultCashInjection
        });
    }, [currentPortfolioId, defaultCashInjection, defaultStrategy, rebalanceDate]);


    const prices = useLiveQuery(
        async () => {
            if (!priceTickers.length || !rebalanceDate) return [];
            const t0 = performance.now();
            const rows = await queryLatestPricesForTickers({
                portfolioId: currentPortfolioId,
                tickers: priceTickers,
                upToDate: rebalanceDate
            });
            if (import.meta.env.DEV) {
                console.log('[PERF][Rebalance] prices at valuation', Math.round(performance.now() - t0), 'ms', {
                    tickers: priceTickers.length,
                    count: rows.length,
                    valuationDate: rebalanceDate
                });
            }
            return rows;
        },
        [currentPortfolioId, priceTickersKey, rebalanceDate],
        []
    );

    const fxRates = useLiveQuery(
        async () => {
            if (!fxPairs.length || !rebalanceDate) return [];
            const t0 = performance.now();
            const rows = await queryLatestFxForPairs({
                pairs: fxPairs,
                upToDate: rebalanceDate
            });
            if (import.meta.env.DEV) {
                console.log('[PERF][Rebalance] latest fx', Math.round(performance.now() - t0), 'ms', {
                    pairs: fxPairs.length,
                    count: rows.length,
                    upToDate: rebalanceDate
                });
            }
            return rows;
        },
        [fxPairsKey, rebalanceDate],
        []
    );

    const rebalanceQuality = useMemo(() => {
        if (!transactions || !prices || !instruments || !fxRates || !rebalanceDate) return null;
        return analyzeRebalanceQuality(holdings, instruments, prices, fxRates, rebalanceDate, Currency.CHF);
    }, [transactions, prices, instruments, fxRates, rebalanceDate, holdings]);

    const rebalanceData = useMemo(() => {
        if (!transactions || !prices || !instruments || !fxRates || !rebalanceDate) return null;
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
            const pricePoint = getLatestPricePoint(priceTicker, rebalanceDate, prices);
            const price = pricePoint?.close || 0;
            const priceCurrency = (pricePoint?.currency || instr.currency || Currency.CHF) as Currency;
            const valueLocal = qty * price;
            let fxRateToChf: number | undefined;
            let fxDate: string | undefined;
            let valueCHF = 0;
            if (priceCurrency === Currency.CHF) {
                fxRateToChf = 1;
                fxDate = rebalanceDate;
                valueCHF = valueLocal;
            } else {
                const converted = convertAmountFromSeries(valueLocal, priceCurrency, Currency.CHF, rebalanceDate, fxRates);
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
    }, [transactions, prices, instruments, fxRates, rebalanceDate, holdings]);

    const usedPriceDates = useMemo(() => {
        if (!rebalanceData?.valuationMeta) return [];
        return Array.from(rebalanceData.valuationMeta.entries()).map(([ticker, meta]) => ({
            ticker,
            date: meta.priceDate
        }));
    }, [rebalanceData]);

    useEffect(() => {
        if (!import.meta.env.DEV) return;
        if (!rebalanceDate || !usedPriceDates.length) return;
        console.log('[Rebalance][DEBUG] used price dates', {
            rebalanceDate,
            usedPriceDates
        });
    }, [rebalanceDate, usedPriceDates]);

    // 2. Calculate Rebalancing Suggestions
    const rebalancingPlan = useMemo(() => {
        if (!rebalanceData) return [];
        return calculateRebalancing(rebalanceData.positions, rebalanceData.totalValueCHF, strategy, cashInjection);
    }, [rebalanceData, strategy, cashInjection]);

    const positionByTicker = useMemo(() => {
        if (!rebalanceData) return new Map<string, PortfolioPosition>();
        return new Map(rebalanceData.positions.map(pos => [pos.ticker, pos]));
    }, [rebalanceData]);

    const hasActionablePlan = useMemo(() => {
        return rebalancingPlan.some(p => (p.action === 'COMPRA' || p.action === 'VENDI') && p.amount > 0);
    }, [rebalancingPlan]);

    const buildPlanItems = useCallback(() => {
        return rebalancingPlan.map(p => {
            const instr = instruments?.find(i => i.ticker === p.ticker);
            const position = positionByTicker.get(p.ticker);
            const meta = rebalanceData?.valuationMeta.get(p.ticker);
            const price = position?.currentPrice ?? 0;
            const priceCurrency = (meta?.priceCurrency || instr?.currency || Currency.CHF) as Currency;
            const instrumentCurrency = (instr?.currency || position?.currency || priceCurrency) as Currency;
            const signedDelta = p.action === 'VENDI' ? -p.amount : p.amount;
            const unitsResult = price > 0
                ? computeRebalanceUnits({
                    deltaBase: signedDelta,
                    baseCurrency: Currency.CHF,
                    instrumentCurrency,
                    price,
                    priceCurrency,
                    fxRates,
                    valuationDate: rebalanceDate
                })
                : { reason: 'missing_price' as const };
            const units = unitsResult.units ?? (p.quantity > 0 ? p.quantity : undefined);
            const reason = !units
                ? (unitsResult.reason || (price <= 0 ? 'missing_price' : undefined))
                : undefined;
            return {
                ticker: p.ticker,
                action: p.action as 'COMPRA' | 'VENDI' | 'NEUTRO',
                amountBase: p.amount,
                units,
                instrumentCurrency,
                price,
                priceCurrency,
                reason
            };
        });
    }, [rebalancingPlan, instruments, positionByTicker, rebalanceData, fxRates, rebalanceDate]);

    const handleSavePlan = useCallback(async () => {
        if (!rebalanceData || !hasActionablePlan) return;
        const items = buildPlanItems();
        const labelBase = rebalanceDate || new Date().toISOString().slice(0, 10);
        const saved = await saveRebalancePlan({
            portfolioId: currentPortfolioId,
            valuationDate: rebalanceDate || undefined,
            baseCurrency: Currency.CHF,
            strategy,
            totalAmount: cashInjection,
            items,
            label: `Rebalance ${labelBase}`
        });
        setPlanList(prev => [saved, ...prev]);
        setPlanNotice('Piano salvato');
    }, [rebalanceData, hasActionablePlan, buildPlanItems, currentPortfolioId, rebalanceDate, strategy, cashInjection]);

    const handleApplyPlan = useCallback((plan: RebalancePlan) => {
        const nextStrategy = plan.strategy === RebalanceStrategy.Maintain
            ? RebalanceStrategy.Maintain
            : RebalanceStrategy.Accumulate;
        setStrategy(nextStrategy);
        setCashInjection(typeof plan.totalAmount === 'number' ? plan.totalAmount : defaultCashInjection);
        setPlanNotice(`Piano applicato${plan.valuationDate ? ` (${plan.valuationDate})` : ''}`);
        setPlanModalOpen(false);
    }, [defaultCashInjection]);

    const handleDeletePlan = useCallback(async (planId?: string) => {
        if (!planId) return;
        await deletePlan(planId);
        setPlanList(prev => prev.filter(p => p.id !== planId));
    }, []);

    const handleDuplicatePlan = useCallback(async (planId?: string) => {
        if (!planId) return;
        const duplicated = await duplicatePlan(planId);
        setPlanList(prev => [duplicated, ...prev]);
        setPlanNotice('Piano duplicato');
    }, []);

    const handleLoadDraftFromPlan = useCallback((plan: RebalancePlan) => {
        const payload: RebalanceDraftV1 = {
            v: 1,
            portfolioId: currentPortfolioId,
            savedAt: Date.now(),
            valuationDate: plan.valuationDate,
            baseCurrency: plan.baseCurrency || Currency.CHF,
            strategy: plan.strategy,
            totalAmount: plan.totalAmount
        };
        saveDraft(currentPortfolioId, payload);
        setDraft(payload);
        setPlanNotice('Bozza salvata');
        setPlanModalOpen(false);
    }, [currentPortfolioId]);

    const hasExportableItems = useCallback((plan: RebalancePlan) => {
        return plan.items.some(item =>
            (item.action === 'COMPRA' || item.action === 'VENDI')
            && typeof item.amountBase === 'number'
            && item.amountBase > 0
        );
    }, []);

    const handleExportPlan = useCallback((plan: RebalancePlan) => {
        if (!hasExportableItems(plan)) return;
        const csv = buildRebalancePlanCsv(plan);
        const dateTag = plan.valuationDate || new Date(plan.createdAt).toISOString().slice(0, 10);
        const filename = `rebalance_${plan.portfolioId}_${dateTag}.csv`;
        downloadCsv(filename, csv);
    }, [hasExportableItems]);

    useEffect(() => {
        if (!isPlanModalOpen) return;
        let isMounted = true;
        setPlanLoading(true);
        listPlans(currentPortfolioId)
            .then(rows => {
                if (isMounted) setPlanList(rows);
            })
            .finally(() => {
                if (isMounted) setPlanLoading(false);
            });
        return () => { isMounted = false; };
    }, [isPlanModalOpen, currentPortfolioId]);

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
            fxIssues.map(i => `${i.fxBase || 'FX'}â†’${i.fxQuote || 'CHF'}`)
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

            {isPlanModalOpen && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-md px-4">
                    <div className="ui-panel w-full max-w-3xl p-6">
                        <div className="flex items-center justify-between mb-4">
                            <div>
                                <h3 className="text-lg font-bold text-slate-900">Storico ribilanciamenti</h3>
                                <p className="text-xs text-slate-600">Piani salvati per il portafoglio corrente.</p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setPlanModalOpen(false)}
                                className="ui-btn-ghost px-3 py-1 text-xs font-bold"
                            >
                                Chiudi
                            </button>
                        </div>

                        {planLoading ? (
                            <div className="text-sm text-slate-500">Caricamento...</div>
                        ) : planList.length === 0 ? (
                            <div className="text-sm text-slate-500">Nessun piano salvato.</div>
                        ) : (
                            <div className="space-y-3">
                                {planList.map(plan => (
                                    <div key={plan.id || `${plan.createdAt}-${plan.label || 'plan'}`} className="ui-panel-dense p-4 flex flex-col gap-3">
                                        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
                                            <div className="space-y-1">
                                                <div className="flex items-center gap-2">
                                                    <div className="font-semibold text-slate-900">{plan.label || 'Piano ribilanciamento'}</div>
                                                    {plan.valuationDate && (
                                                        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                                                            Snapshot {plan.valuationDate}
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="text-xs text-slate-600 flex flex-wrap items-center gap-2">
                                                    <span>{new Date(plan.createdAt).toLocaleString('it-CH')}</span>
                                                    {typeof plan.totalAmount === 'number' && <span>· CHF {plan.totalAmount.toLocaleString('it-CH')}</span>}
                                                    <span>· {plan.items.length} righe</span>
                                                </div>
                                            </div>
                                            <div className="flex flex-wrap items-center gap-2">
                                                <button
                                                    type="button"
                                                    onClick={() => setExpandedPlanId(expandedPlanId === plan.id ? null : (plan.id || null))}
                                                    className="ui-btn-ghost px-3 py-2 text-xs font-bold"
                                                >
                                                    {expandedPlanId === plan.id ? 'Nascondi dettagli' : 'Dettagli'}
                                                </button>
                                                <div className="hidden md:block h-6 w-px bg-slate-200" />
                                                <button
                                                    type="button"
                                                    onClick={() => handleLoadDraftFromPlan(plan)}
                                                    className="ui-btn-secondary px-3 py-2 text-xs font-bold"
                                                >
                                                    Carica come bozza
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => handleExportPlan(plan)}
                                                    disabled={!hasExportableItems(plan)}
                                                    title={!hasExportableItems(plan) ? 'Nessun ordine esportabile' : undefined}
                                                    className="ui-btn-secondary px-3 py-2 text-xs font-bold"
                                                >
                                                    Esporta CSV
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => handleDuplicatePlan(plan.id)}
                                                    className="ui-btn-ghost px-3 py-2 text-xs font-bold"
                                                >
                                                    Duplica
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => handleApplyPlan(plan)}
                                                    className="ui-btn-primary px-3 py-2 text-xs font-bold"
                                                >
                                                    Applica
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => handleDeletePlan(plan.id)}
                                                    className="ui-btn-ghost px-3 py-2 text-xs font-bold text-rose-700 hover:text-rose-800"
                                                >
                                                    Elimina
                                                </button>
                                            </div>
                                        </div>

                                        {expandedPlanId === plan.id && (
                                            <div className="ui-panel-subtle p-3">
                                                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600 mb-2">
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        <span className="px-2 py-0.5 rounded-full border border-emerald-200 bg-emerald-50 text-emerald-700 font-bold">
                                                            {plan.items.filter(i => i.action === 'COMPRA').length} azioni
                                                        </span>
                                                        <span className="px-2 py-0.5 rounded-full border border-rose-200 bg-rose-50 text-rose-700 font-bold">
                                                            {plan.items.filter(i => i.action === 'VENDI').length} vendite
                                                        </span>
                                                        <span className="px-2 py-0.5 rounded-full border border-slate-200 bg-slate-100 text-slate-600 font-bold">
                                                            {plan.items.filter(i => i.action === 'NEUTRO').length} neutre
                                                        </span>
                                                    </div>
                                                    <button
                                                        type="button"
                                                        onClick={() => handleExportPlan(plan)}
                                                        disabled={!hasExportableItems(plan)}
                                                        title={!hasExportableItems(plan) ? 'Nessun ordine esportabile' : undefined}
                                                        className="ui-btn-ghost px-2 py-0.5 text-[11px] font-bold"
                                                    >
                                                        CSV
                                                    </button>
                                                </div>
                                                <div className="max-h-64 overflow-auto">
                                                    <table className="w-full text-xs text-left">
                                                        <thead className="text-slate-500 uppercase tracking-wider">
                                                            <tr>
                                                                <th className="py-2 px-2">Ticker</th>
                                                                <th className="py-2 px-2">Azione</th>
                                                                <th className="py-2 px-2 text-right whitespace-nowrap">CHF</th>
                                                                <th className="py-2 px-2 text-right whitespace-nowrap">Quote</th>
                                                                <th className="py-2 px-2">Note</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody className="divide-y divide-slate-200/70">
                                                            {plan.items.map((item, idx) => (
                                                                <tr key={`${item.ticker}-${idx}`}>
                                                                    <td className="py-2 px-2 font-semibold text-slate-900">{item.ticker}</td>
                                                                    <td className="py-2 px-2">
                                                                        <span className={clsx(
                                                                            'rebalance-action-chip',
                                                                            item.action === 'COMPRA' ? 'rebalance-action-buy'
                                                                                : item.action === 'VENDI' ? 'rebalance-action-sell'
                                                                                    : 'rebalance-action-neutral'
                                                                        )}>
                                                                            {item.action}
                                                                        </span>
                                                                    </td>
                                                                    <td className="py-2 px-2 text-right font-mono text-slate-700 whitespace-nowrap">
                                                                        {typeof item.amountBase === 'number'
                                                                            ? `CHF ${item.amountBase.toLocaleString('it-CH', { maximumFractionDigits: 0 })}`
                                                                            : '—'}
                                                                    </td>
                                                                    <td className="py-2 px-2 text-right font-mono text-slate-700 whitespace-nowrap">
                                                                        {typeof item.units === 'number'
                                                                            ? formatQuantity(item.units, instruments?.find(i => i.ticker === item.ticker), item.ticker)
                                                                            : '—'}
                                                                    </td>
                                                                    <td className="py-2 px-2 text-slate-500">{item.reason || ''}</td>
                                                                </tr>
                                                            ))}
                                                        </tbody>
                                                    </table>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* HEADER CONTROLS */}
            <div className="ui-panel p-6">
                <h2 className="text-xl font-bold mb-6 flex items-center gap-2 text-slate-900">
                    <span className="material-symbols-outlined text-[#0052a3]">balance</span>
                    Pannello Ribilanciamento
                </h2>
                <DataStatusBar
                    portfolioId={currentPortfolioId}
                    transactions={transactions || []}
                    instruments={instruments || []}
                    prices={latestPricesAll || []}
                    fxUsed={rebalanceData?.oldestFxDate || undefined}
                    variant="rebalance"
                    rebalanceDate={rebalanceDate || undefined}
                    usedPriceDates={usedPriceDates}
                />
                {rebalanceDate && (
                    <div className="text-xs text-slate-500 mb-4 flex flex-wrap items-center gap-2">
                        <span>Base currency: CHF</span>
                        <span>·</span>
                        <span>Prezzi (rebalance): {rebalanceDate || 'N/D'}</span>
                        <span>·</span>
                        <span>FX (usato): {rebalanceData?.oldestFxDate || 'N/D'}</span>
                        {hasFxStale && (
                            <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 font-bold border border-amber-200">
                                FX stale
                            </span>
                        )}
                    </div>
                )}
                {draft && (
                    <div className="text-xs text-slate-500 mb-4 flex flex-wrap items-center gap-2">
                        <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                            Bozza salvata • {draftAgeLabel}
                        </span>
                        {isDraftStale && (
                            <span className="text-amber-600">Bozza vecchia</span>
                        )}
                        {!isDraftApplied && (
                            <button
                                type="button"
                                onClick={handleRestoreDraft}
                                className="ui-btn-secondary px-3 py-1 text-xs font-bold"
                            >
                                Ripristina bozza
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={handleResetDraft}
                            className="ui-btn-ghost px-3 py-1 text-xs font-bold"
                        >
                            Reset bozza
                        </button>
                    </div>
                )}
                <div className="flex flex-wrap items-center gap-2 mb-4">
                    <button
                        type="button"
                        onClick={handleSavePlan}
                        disabled={!hasActionablePlan}
                        title={!hasActionablePlan ? 'Nessun piano da salvare' : undefined}
                        className="ui-btn-primary px-4 py-2 text-xs font-bold"
                    >
                        Salva piano
                    </button>
                    <button
                        type="button"
                        onClick={() => setPlanModalOpen(true)}
                        className="ui-btn-secondary px-4 py-2 text-xs font-bold"
                    >
                        Storico
                    </button>
                    {planNotice && (
                        <span className="text-xs text-slate-500">{planNotice}</span>
                    )}
                </div>
                {isRebalanceBlocked && (
                    <div className="ui-panel-subtle border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 flex flex-col gap-2">
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
                                Vai a Settings â†’ Sync/FX
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
                            <th className="px-4 py-4 font-bold text-right w-[10%] rebalance-emph-col min-w-[120px]">Quote</th>
                            <th className="px-4 py-4 font-bold text-right w-[15%] rebalance-emph-col min-w-[170px] whitespace-nowrap">Azione Consigliata</th>
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
                                        const isStalePrice = Boolean(meta?.priceDate && rebalanceDate && meta.priceDate < rebalanceDate);
                                        const lagDays = isStalePrice && meta?.priceDate ? diffDaysYmd(rebalanceDate, meta.priceDate) : 0;
                                        const showPriceDate = Boolean(meta?.priceDate && (meta.priceDate !== rebalanceDate || isStalePrice));
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
                                        const isActionRow = p.action === 'COMPRA' || p.action === 'VENDI';
                                        const unitsResult = (!isTradable || isUnvalued || isCashLike)
                                            ? { reason: 'invalid' as const }
                                            : computeRebalanceUnits({
                                                deltaBase: signedDelta,
                                                baseCurrency,
                                                instrumentCurrency,
                                                price: priceValue,
                                                priceCurrency,
                                                fxRates,
                                                valuationDate: rebalanceDate
                                            });
                                        const unitsLabel = isNeutral
                                            ? formatQuantity(0, instr, p.ticker)
                                            : (unitsResult.units !== undefined && Number.isFinite(unitsResult.units))
                                                ? formatQuantity(unitsResult.units, instr, p.ticker)
                                                : '—';
                                        const unitsTitle = unitsLabel === '—'
                                            ? (unitsResult.reason === 'currency_mismatch'
                                                ? 'Valuta prezzo non coerente con la valuta dello strumento'
                                                : unitsResult.reason === 'missing_fx'
                                                    ? 'Manca FX per convertire il delta'
                                                    : 'Manca prezzo o FX per calcolare le quote')
                                            : undefined;

                                        return (
                                            <tr
                                                key={p.ticker}
                                                className={clsx(
                                                    "hover:bg-slate-50 transition-colors group",
                                                    isActionRow && "rebalance-row-active"
                                                )}
                                            >
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
                                                <td className="px-4 py-3 text-right rebalance-emph-col min-w-[120px]">
                                                    <div className="text-xs font-medium text-slate-600">
                                                        {assetCurrency} {currentValue.toLocaleString('it-CH', { maximumFractionDigits: 2 })}
                                                    </div>
                                                    <div className="text-[11px] text-slate-400">
                                                        Quote: {formatQuantity(heldQty, instr, p.ticker)}
                                                    </div>
                                                    <div className={clsx('text-[11px]', isStalePrice ? 'text-amber-600' : 'text-slate-400')}>
                                                        Px: {assetCurrency} {formatPrice(priceValue)}
                                                        {showPriceDate && meta?.priceDate ? ` (${meta.priceDate})` : ''}
                                                        {isStalePrice && lagDays > 0 && (
                                                            <span className="ml-1 text-[10px] font-semibold">-{lagDays} g</span>
                                                        )}
                                                        {hasMismatch ? ' (mismatch)' : ''}
                                                    </div>
                                                </td>

                                                {/* Units */}
                                                <td className="px-4 py-3 text-right rebalance-emph-col min-w-[170px]">
                                                    <div
                                                        className={clsx('text-xs font-mono', unitsLabel === '—' ? 'text-slate-400' : 'text-slate-700')}
                                                        title={unitsTitle}
                                                    >
                                                        {unitsLabel === '—' ? unitsLabel : <span className="rebalance-emph-cell">{unitsLabel}</span>}
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
                                                                triggerClassName="rebalance-action-chip bg-amber-100 text-amber-700 focus:outline-none focus:ring-2 focus:ring-primary"
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
                                                                "rebalance-action-chip",
                                                                p.action === 'COMPRA' ? "rebalance-action-buy" :
                                                                    p.action === 'VENDI' ? "rebalance-action-sell" :
                                                                        "rebalance-action-neutral"
                                                            )}>
                                                                {p.action}
                                                            </span>
                                                        )}
                                                        {isTradable && p.amount > 0 && (
                                                            <span className="rebalance-emph-cell">
                                                                CHF {p.amount.toLocaleString('it-CH', { maximumFractionDigits: 0 })}
                                                            </span>
                                                        )}
                                                        {isTradable && p.amount > 0 && amountLocal !== null && (
                                                            <span className="text-[11px] text-slate-400">
                                                                ˜ {assetCurrency} {amountLocal.toLocaleString('it-CH', { maximumFractionDigits: 0 })}
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

















