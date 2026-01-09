import React, { useState, useMemo } from 'react';
import { db, getCurrentPortfolioId } from '../db';
import { useLiveQuery } from 'dexie-react-hooks';
import { calculatePortfolioState, calculateRebalancing } from '../services/financeUtils';
import { RebalanceStrategy, AssetType } from '../types';

import clsx from 'clsx';

// Mapping AssetType to Macro Category
const getMacroCategory = (type: AssetType): 'AZIONI' | 'OBBLIGAZIONI' | 'COMMODITIES' | 'MONETARIO' | 'ALTRO' => {
    switch (type) {
        case AssetType.Stock:
        case AssetType.ETF:
            return 'AZIONI';
        case AssetType.Bond:
            return 'OBBLIGAZIONI';
        case AssetType.Commodity:
            return 'COMMODITIES';
        case AssetType.Cash:
        case AssetType.Crypto:
            return 'MONETARIO';
        default:
            return 'ALTRO';
    }
};

const MACRO_ORDER = ['OBBLIGAZIONI', 'AZIONI', 'COMMODITIES', 'MONETARIO', 'ALTRO'];

export const Rebalance: React.FC = () => {
    const currentPortfolioId = getCurrentPortfolioId();
    const [strategy, setStrategy] = useState<RebalanceStrategy>(RebalanceStrategy.Accumulate);
    const [cashInjection, setCashInjection] = useState(0);
    const [editTargetId, setEditTargetId] = useState<number | null>(null);
    const [tempTargetVal, setTempTargetVal] = useState<string>('');

    const transactions = useLiveQuery(() => db.transactions.where('portfolioId').equals(currentPortfolioId).toArray(), [currentPortfolioId], []);
    const prices = useLiveQuery(() => db.prices.where('portfolioId').equals(currentPortfolioId).toArray(), [currentPortfolioId], []);
    const instruments = useLiveQuery(() => db.instruments.where('portfolioId').equals(currentPortfolioId).toArray(), [currentPortfolioId], []);

    // 1. Get Base State
    const state = useMemo(() => {
        if (!transactions || !prices || !instruments) return null;
        return calculatePortfolioState(transactions, instruments, prices);
    }, [transactions, prices, instruments]);

    // 2. Calculate Rebalancing Suggestions
    const rebalancingPlan = useMemo(() => {
        if (!state) return [];
        return calculateRebalancing(state.positions, state.totalValue, strategy, cashInjection);
    }, [state, strategy, cashInjection]);

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
            const macro = instr ? getMacroCategory(instr.type) : 'ALTRO';

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
        if (instr && instr.id) {
            setEditTargetId(instr.id);
            setTempTargetVal(currentVal.toString());
        }
    };

    const saveTarget = async () => {
        if (editTargetId) {
            await db.instruments.update(editTargetId, { targetAllocation: parseFloat(tempTargetVal) });
            setEditTargetId(null);
        }
    };

    const DeviationBlock = ({ deviation }: { deviation: number }) => {
        // Thresholds
        const isUnderweight = deviation < -0.5;
        const isOverweight = deviation > 0.5;
        const isNeutral = !isUnderweight && !isOverweight;

        // Scale intensity
        const intensity = Math.min(Math.abs(deviation), 5) / 5;

        return (
            <div className="grid grid-cols-3 h-8 w-full gap-0.5 bg-slate-200 rounded overflow-hidden border border-white">
                {/* Sottopesato (LEFT) */}
                <div className={`flex items-center justify-center relative ${isUnderweight ? 'bg-blue-100' : ''}`}>
                    {isUnderweight && (
                        <div
                            className="h-full bg-blue-600 shadow-[0_0_10px_rgba(37,99,235,0.5)] transition-all"
                            style={{ width: `${Math.max(20, intensity * 100)}%` }}
                        />
                    )}
                </div>

                {/* Neutro (CENTER) */}
                <div className={`flex items-center justify-center relative border-x border-white ${isNeutral ? 'bg-yellow-100' : ''}`}>
                    {isNeutral && <div className="w-2 h-2 rounded-full bg-yellow-500 shadow-lg" />}
                </div>

                {/* Sovrapesato (RIGHT) */}
                <div className={`flex items-center justify-center relative ${isOverweight ? 'bg-red-100' : ''}`}>
                    {isOverweight && (
                        <div
                            className="h-full bg-red-600 shadow-[0_0_10px_rgba(220,38,38,0.5)] transition-all"
                            style={{ width: `${Math.max(20, intensity * 100)}%` }}
                        />
                    )}
                </div>
            </div>
        );
    };

    if (!state) return <div className="p-10 text-center text-gray-500 flex flex-col items-center gap-3"><span className="material-symbols-outlined animate-spin text-primary">donut_large</span> Calcolo...</div>;

    return (
        <div className="space-y-6 pb-20 animate-fade-in text-textPrimary">

            {/* HEADER CONTROLS */}
            <div className="bg-white p-6 rounded-2xl shadow-lg border border-borderSoft">
                <h2 className="text-xl font-bold mb-6 flex items-center gap-2 text-slate-900">
                    <span className="material-symbols-outlined text-[#0052a3]">balance</span>
                    Pannello Ribilanciamento
                </h2>

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
                            <label className="block text-xs font-bold text-gray-400 uppercase mb-3">Nuova Liquidità (CHF)</label>
                            <div className="relative">
                                <input
                                    type="number"
                                    value={cashInjection}
                                    onChange={e => setCashInjection(Number(e.target.value))}
                                    className="w-full border border-borderSoft bg-slate-50 p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none font-mono text-lg font-bold text-slate-900 text-right"
                                />
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* HEATMAP TABLE */}
            <div className="bg-white rounded-2xl shadow-lg border border-borderSoft overflow-hidden overflow-x-auto">
                <table className="w-full text-sm text-left">
                    <thead className="bg-slate-100 text-slate-500 border-b border-borderSoft text-xs uppercase tracking-wider">
                        <tr>
                            <th className="px-4 py-4 font-bold w-[25%]">Asset Class / Strumento</th>
                            <th className="px-2 py-4 font-bold text-center w-[10%]">Target</th>
                            <th className="px-2 py-4 font-bold text-center w-[10%]">Attuale</th>
                            <th className="px-0 py-4 font-bold text-center w-[30%] bg-black/5">
                                <div className="grid grid-cols-3 text-[10px] opacity-70">
                                    <span>Sottopesato</span>
                                    <span>Neutro</span>
                                    <span>Sovrapesato</span>
                                </div>
                            </th>
                            <th className="px-4 py-4 font-bold text-right w-[25%]">Azione Consigliata</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-borderSoft">
                        {MACRO_ORDER.filter(m => groupedPlan[m]).map(macro => {
                            const group = groupedPlan[macro];
                            const macroDiff = group.totalCurrentPct - group.totalTargetPct;

                            return (
                                <React.Fragment key={macro}>
                                    {/* MACRO HEADER ROW */}
                                    <tr className="bg-slate-50 border-b border-borderSoft">
                                        <td className="px-4 py-3 font-bold flex items-center gap-2" style={{ color: '#0052a3' }}>
                                            {macro}
                                        </td>
                                        <td className="px-2 py-3 font-bold text-center text-slate-700">{group.totalTargetPct.toFixed(1)}%</td>
                                        <td className="px-2 py-3 font-bold text-center text-slate-700">{group.totalCurrentPct.toFixed(1)}%</td>
                                        <td className="px-0 py-1">
                                            <div className="px-4 opacity-50"><DeviationBlock deviation={macroDiff} /></div>
                                        </td>
                                        <td className="px-4 py-3 text-right"></td>
                                    </tr>

                                    {/* ITEMS */}
                                    {group.items.map(p => {
                                        const instr = instruments?.find(i => i.ticker === p.ticker);
                                        const isEditing = instr?.id === editTargetId;
                                        const diff = p.currentPct - p.targetPct;

                                        return (
                                            <tr key={p.ticker} className="hover:bg-slate-50 transition-colors group">
                                                {/* Ticker & Name */}
                                                <td className="px-4 py-3 pl-8">
                                                    <div className="font-bold text-slate-900">{p.ticker}</div>
                                                    <div className="text-xs text-slate-500 truncate max-w-[180px] group-hover:text-slate-700">{p.name}</div>
                                                </td>

                                                {/* Target % (Editable) */}
                                                <td className="px-2 py-3 text-center">
                                                    {isEditing ? (
                                                        <input
                                                            autoFocus
                                                            className="w-14 border border-primary rounded bg-white text-center font-bold text-slate-900 text-xs py-1 outline-none"
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
                                                            {p.targetPct}%
                                                        </div>
                                                    )}
                                                </td>

                                                {/* Current % */}
                                                <td className="px-2 py-3 text-center text-slate-700 font-mono">
                                                    {p.currentPct.toFixed(1)}%
                                                </td>

                                                {/* Deviation Visual */}
                                                <td className="px-0 py-2 align-middle">
                                                    <div className="px-2">
                                                        <DeviationBlock deviation={diff} />
                                                    </div>
                                                </td>

                                                {/* Action */}
                                                <td className="px-4 py-3 text-right">
                                                    <div className="flex flex-col items-end gap-1">
                                                        <span className={clsx(
                                                            "px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider",
                                                            p.action === 'COMPRA' ? "bg-green-500/20 text-green-400" :
                                                                p.action === 'VENDI' ? "bg-red-500/20 text-red-400" :
                                                                    "bg-gray-500/20 text-gray-500"
                                                        )}>
                                                            {p.action}
                                                        </span>
                                                        {p.amount > 0 && (
                                                            <span className="text-xs font-mono text-slate-500">
                                                                CHF {p.amount.toLocaleString('it-CH', { maximumFractionDigits: 0 })}
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
                Valore Totale Stimato Post-Ribilanciamento: CHF <span className="font-bold text-slate-900">{(state.totalValue + (strategy === RebalanceStrategy.Accumulate ? cashInjection : 0)).toLocaleString()}</span>
            </div>
        </div>
    );
};
