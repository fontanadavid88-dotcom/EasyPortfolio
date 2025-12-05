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
    // Find ID
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

  if (!state) return <div className="p-8 text-center text-gray-500">Calcolo portafoglio...</div>;

  return (
    <div className="space-y-6 pb-20">
      
      {/* HEADER CONTROLS */}
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
        <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
            <span className="material-symbols-outlined text-blue-600">balance</span>
            Pannello Ribilanciamento
        </h2>
        
        <div className="flex flex-col md:flex-row gap-6">
            <div className="flex-1">
                <label className="block text-xs font-bold text-gray-500 uppercase mb-2">Strategia</label>
                <div className="flex gap-2">
                    <button 
                        onClick={() => setStrategy(RebalanceStrategy.Accumulate)}
                        className={`flex-1 py-2 px-3 rounded-lg border text-sm font-medium transition-all ${strategy === RebalanceStrategy.Accumulate ? 'bg-blue-600 border-blue-600 text-white' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}
                    >
                        Accumulo (Solo Acquisti)
                    </button>
                    <button 
                        onClick={() => setStrategy(RebalanceStrategy.Maintain)}
                        className={`flex-1 py-2 px-3 rounded-lg border text-sm font-medium transition-all ${strategy === RebalanceStrategy.Maintain ? 'bg-blue-600 border-blue-600 text-white' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}
                    >
                        Mantenimento
                    </button>
                </div>
            </div>

            {strategy === RebalanceStrategy.Accumulate && (
                <div className="flex-1">
                    <label className="block text-xs font-bold text-gray-500 uppercase mb-2">Nuova Liquidità (CHF)</label>
                    <div className="relative">
                        <input 
                            type="number" 
                            value={cashInjection} 
                            onChange={e => setCashInjection(Number(e.target.value))}
                            className="w-full border border-gray-300 p-2 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none font-mono"
                        />
                    </div>
                </div>
            )}
        </div>
      </div>

      {/* OPERATIONAL TABLE */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden overflow-x-auto">
        <table className="w-full text-sm text-left whitespace-nowrap">
            <thead className="bg-gray-50 text-gray-500 border-b border-gray-100">
                <tr>
                    <th className="px-4 py-3 font-medium">Strumento</th>
                    <th className="px-4 py-3 font-medium text-right">Posizione Attuale</th>
                    <th className="px-4 py-3 font-medium text-center">Target %</th>
                    <th className="px-4 py-3 font-medium text-center">Attuale %</th>
                    <th className="px-4 py-3 font-medium text-center">Azione</th>
                    <th className="px-4 py-3 font-medium text-right">Importo</th>
                    <th className="px-4 py-3 font-medium text-right">Quantità</th>
                </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
                {rebalancingPlan.map(p => {
                    // Find original instrument id for key
                    const instr = instruments?.find(i => i.ticker === p.ticker);
                    const isEditing = instr?.id === editTargetId;

                    return (
                        <tr key={p.ticker} className="hover:bg-gray-50">
                            {/* Ticker & Name */}
                            <td className="px-4 py-3">
                                <div className="font-bold text-gray-800">{p.ticker}</div>
                                <div className="text-xs text-gray-500 truncate max-w-[150px]">{p.name}</div>
                            </td>

                            {/* Current Value */}
                            <td className="px-4 py-3 text-right">
                                <div className="font-mono text-gray-700">{(state.positions.find(pos => pos.ticker === p.ticker)?.currentValueCHF || 0).toLocaleString('it-CH', { maximumFractionDigits: 0 })}</div>
                            </td>

                            {/* Target % (Editable) */}
                            <td className="px-4 py-3 text-center">
                                {isEditing ? (
                                    <div className="flex items-center justify-center gap-1">
                                        <input 
                                            autoFocus
                                            className="w-12 border border-blue-500 rounded px-1 py-0.5 text-center font-bold"
                                            value={tempTargetVal}
                                            onChange={e => setTempTargetVal(e.target.value)}
                                            onKeyDown={e => e.key === 'Enter' && saveTarget()}
                                            onBlur={saveTarget}
                                        />
                                        <span className="text-gray-400">%</span>
                                    </div>
                                ) : (
                                    <div 
                                        onClick={() => startEdit(p.ticker, p.targetPct)}
                                        className="cursor-pointer hover:bg-gray-200 rounded px-2 py-1 transition-colors inline-block font-bold text-gray-700 border border-dashed border-gray-300 hover:border-gray-400"
                                    >
                                        {p.targetPct}%
                                    </div>
                                )}
                            </td>

                            {/* Current % */}
                            <td className="px-4 py-3 text-center text-gray-600">
                                {p.currentPct.toFixed(1)}%
                            </td>

                            {/* Action */}
                            <td className="px-4 py-3 text-center">
                                <span className={`px-2 py-1 rounded text-xs font-bold inline-block w-20 text-center ${
                                    p.action === 'COMPRA' ? 'bg-green-100 text-green-800' : 
                                    p.action === 'VENDI' ? 'bg-red-100 text-red-800' : 
                                    'bg-gray-100 text-gray-400'
                                }`}>
                                    {p.action}
                                </span>
                            </td>

                            {/* Amount to Trade */}
                            <td className="px-4 py-3 text-right font-mono font-medium">
                                {p.amount > 0 ? p.amount.toLocaleString('it-CH', {maximumFractionDigits: 0}) : '-'}
                            </td>

                            {/* Quantity to Trade */}
                            <td className="px-4 py-3 text-right font-mono text-gray-500">
                                {p.quantity > 0.01 ? p.quantity.toFixed(2) : '-'}
                            </td>
                        </tr>
                    );
                })}
            </tbody>
        </table>
      </div>
      
      {/* Summary Footer */}
      <div className="text-center text-xs text-gray-400">
         Valore Totale Stimato Post-Ribilanciamento: CHF {(state.totalValue + (strategy === RebalanceStrategy.Accumulate ? cashInjection : 0)).toLocaleString()}
      </div>
    </div>
  );
};