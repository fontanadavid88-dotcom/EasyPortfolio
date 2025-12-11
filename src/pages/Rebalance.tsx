import React, { useState, useMemo } from 'react';
import { db } from '../db';
import { useLiveQuery } from 'dexie-react-hooks';
import { calculatePortfolioState, calculateRebalancing } from '../services/financeUtils';
import { RebalanceStrategy } from '../types';

export const Rebalance: React.FC = () => {
  const [strategy, setStrategy] = useState<RebalanceStrategy>(RebalanceStrategy.Accumulate);
  const [cashInjection, setCashInjection] = useState(0);
  const [editTargetId, setEditTargetId] = useState<number | null>(null);
  const [tempTargetVal, setTempTargetVal] = useState<string>('');
  
  const transactions = useLiveQuery(() => db.transactions.toArray());
  const prices = useLiveQuery(() => db.prices.toArray());
  const instruments = useLiveQuery(() => db.instruments.toArray());

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

  if (!state) return <div className="p-8 text-center text-shell-muted">Calcolo portafoglio...</div>;

  return (
    <div className="space-y-6 pb-20">
      
      {/* HEADER CONTROLS */}
      <div className="bg-panel p-6 rounded-2xl shadow-card border border-panel-border">
        <h2 className="text-xl font-bold mb-6 flex items-center gap-2 text-panel-text">
            <span className="material-symbols-outlined text-primary">balance</span>
            Pannello Ribilanciamento
        </h2>
        
        <div className="flex flex-col md:flex-row gap-8">
            <div className="flex-1">
                <label className="block text-xs font-bold text-panel-muted uppercase mb-3">Strategia</label>
                <div className="flex gap-3">
                    <button 
                        onClick={() => setStrategy(RebalanceStrategy.Accumulate)}
                        className={`flex-1 py-3 px-4 rounded-xl border text-sm font-semibold transition-all shadow-sm ${strategy === RebalanceStrategy.Accumulate ? 'bg-primary border-primary text-white shadow-primary/30' : 'border-gray-200 text-panel-muted hover:bg-gray-50'}`}
                    >
                        Accumulo (Acquisti)
                    </button>
                    <button 
                        onClick={() => setStrategy(RebalanceStrategy.Maintain)}
                        className={`flex-1 py-3 px-4 rounded-xl border text-sm font-semibold transition-all shadow-sm ${strategy === RebalanceStrategy.Maintain ? 'bg-primary border-primary text-white shadow-primary/30' : 'border-gray-200 text-panel-muted hover:bg-gray-50'}`}
                    >
                        Mantenimento
                    </button>
                </div>
            </div>

            {strategy === RebalanceStrategy.Accumulate && (
                <div className="flex-1">
                    <label className="block text-xs font-bold text-panel-muted uppercase mb-3">Nuova Liquidità (CHF)</label>
                    <div className="relative">
                        <input 
                            type="number" 
                            value={cashInjection} 
                            onChange={e => setCashInjection(Number(e.target.value))}
                            className="w-full border border-gray-200 bg-gray-50 p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none font-mono text-lg font-bold text-panel-text"
                        />
                    </div>
                </div>
            )}
        </div>
      </div>

      {/* OPERATIONAL TABLE */}
      <div className="bg-panel rounded-2xl shadow-card border border-panel-border overflow-hidden overflow-x-auto">
        <table className="w-full text-sm text-left whitespace-nowrap">
            <thead className="bg-gray-50/50 text-panel-muted border-b border-panel-border">
                <tr>
                    <th className="px-6 py-4 font-semibold text-xs uppercase tracking-wider">Strumento</th>
                    <th className="px-6 py-4 font-semibold text-xs uppercase tracking-wider text-right">Valore Attuale</th>
                    <th className="px-6 py-4 font-semibold text-xs uppercase tracking-wider text-center">Target %</th>
                    <th className="px-6 py-4 font-semibold text-xs uppercase tracking-wider text-center">Attuale %</th>
                    <th className="px-6 py-4 font-semibold text-xs uppercase tracking-wider text-center">Azione</th>
                    <th className="px-6 py-4 font-semibold text-xs uppercase tracking-wider text-right">Importo</th>
                    <th className="px-6 py-4 font-semibold text-xs uppercase tracking-wider text-right">Quantità</th>
                </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
                {rebalancingPlan.map(p => {
                    const instr = instruments?.find(i => i.ticker === p.ticker);
                    const isEditing = instr?.id === editTargetId;

                    return (
                        <tr key={p.ticker} className="hover:bg-gray-50 transition-colors">
                            {/* Ticker & Name */}
                            <td className="px-6 py-4">
                                <div className="font-bold text-panel-text">{p.ticker}</div>
                                <div className="text-xs text-panel-muted truncate max-w-[180px]">{p.name}</div>
                            </td>

                            {/* Current Value */}
                            <td className="px-6 py-4 text-right">
                                <div className="font-mono text-panel-text font-medium">{(state.positions.find(pos => pos.ticker === p.ticker)?.currentValueCHF || 0).toLocaleString('it-CH', { maximumFractionDigits: 0 })}</div>
                            </td>

                            {/* Target % (Editable) */}
                            <td className="px-6 py-4 text-center">
                                {isEditing ? (
                                    <div className="flex items-center justify-center gap-1">
                                        <input 
                                            autoFocus
                                            className="w-16 border border-primary rounded px-2 py-1 text-center font-bold text-primary bg-blue-50"
                                            value={tempTargetVal}
                                            onChange={e => setTempTargetVal(e.target.value)}
                                            onKeyDown={e => e.key === 'Enter' && saveTarget()}
                                            onBlur={saveTarget}
                                        />
                                    </div>
                                ) : (
                                    <div 
                                        onClick={() => startEdit(p.ticker, p.targetPct)}
                                        className="cursor-pointer hover:bg-gray-200 rounded px-3 py-1 transition-colors inline-block font-bold text-panel-muted border border-dashed border-transparent hover:border-gray-400"
                                    >
                                        {p.targetPct}%
                                    </div>
                                )}
                            </td>

                            {/* Current % */}
                            <td className="px-6 py-4 text-center text-panel-muted font-mono">
                                {p.currentPct.toFixed(1)}%
                            </td>

                            {/* Action */}
                            <td className="px-6 py-4 text-center">
                                <span className={`px-3 py-1 rounded-full text-xs font-bold inline-block w-24 text-center ${
                                    p.action === 'COMPRA' ? 'bg-positive/10 text-positive' : 
                                    p.action === 'VENDI' ? 'bg-negative/10 text-negative' : 
                                    'bg-gray-100 text-gray-400'
                                }`}>
                                    {p.action}
                                </span>
                            </td>

                            {/* Amount to Trade */}
                            <td className="px-6 py-4 text-right font-mono font-bold text-panel-text">
                                {p.amount > 0 ? p.amount.toLocaleString('it-CH', {maximumFractionDigits: 0}) : '-'}
                            </td>

                            {/* Quantity to Trade */}
                            <td className="px-6 py-4 text-right font-mono text-panel-muted">
                                {p.quantity > 0.01 ? p.quantity.toFixed(2) : '-'}
                            </td>
                        </tr>
                    );
                })}
            </tbody>
        </table>
      </div>
      
      {/* Summary Footer */}
      <div className="text-center text-xs text-shell-muted mt-4">
         Valore Totale Stimato Post-Ribilanciamento: CHF <span className="font-bold text-white">{(state.totalValue + (strategy === RebalanceStrategy.Accumulate ? cashInjection : 0)).toLocaleString()}</span>
      </div>
    </div>
  );
};