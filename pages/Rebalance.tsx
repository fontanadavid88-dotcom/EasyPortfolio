import React, { useState } from 'react';
import { db } from '../db';
import { useLiveQuery } from 'dexie-react-hooks';
import { calculateHoldings, calculateRebalancing } from '../services/financeUtils';
import { RebalanceStrategy } from '../types';

export const Rebalance: React.FC = () => {
  const [strategy, setStrategy] = useState<RebalanceStrategy>(RebalanceStrategy.Accumulate);
  const [cashInjection, setCashInjection] = useState(0);
  
  const transactions = useLiveQuery(() => db.transactions.toArray());
  const prices = useLiveQuery(() => db.prices.toArray());
  const instruments = useLiveQuery(() => db.instruments.toArray());

  // Derived state for rebalancing table
  const rebalancingPlan = React.useMemo(() => {
    if (!transactions || !prices || !instruments) return [];

    const holdingMap = calculateHoldings(transactions);
    
    let totalPortfolioValue = 0;
    const holdings = instruments.map(instr => {
      const qty = holdingMap.get(instr.ticker) || 0;
      // Find latest price
      const latestPrice = prices
        .filter(p => p.ticker === instr.ticker)
        .sort((a,b) => b.date.localeCompare(a.date))[0]?.close || 0;
      
      const value = qty * latestPrice; // Simplified: assume base currency match
      totalPortfolioValue += value;

      return {
        ticker: instr.ticker,
        value,
        qty,
        price: latestPrice,
        targetPct: instr.targetAllocation || 0,
        currentPct: 0 // calc later
      };
    }).filter(h => h.targetPct > 0 || h.qty > 0);

    // Add cash injection to total for calculation
    const effectiveTotal = totalPortfolioValue + (strategy === RebalanceStrategy.Accumulate ? cashInjection : 0);

    // Calculate percentages
    holdings.forEach(h => {
        h.currentPct = (h.value / effectiveTotal) * 100;
    });

    const plan = calculateRebalancing(holdings, effectiveTotal);
    
    // Filter out Accumulate specific logic (only buys)
    if (strategy === RebalanceStrategy.Accumulate) {
      return plan.filter(p => p.action === 'BUY');
    }

    return plan;

  }, [transactions, prices, instruments, strategy, cashInjection]);

  return (
    <div className="space-y-6">
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
        <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
            <span className="material-symbols-outlined text-blue-600">tune</span>
            Configurazione Ribilanciamento
        </h2>
        <div className="flex gap-4 mb-4">
            <button 
                onClick={() => setStrategy(RebalanceStrategy.Accumulate)}
                className={`flex-1 py-3 px-4 rounded-xl border text-sm font-medium transition-all ${strategy === RebalanceStrategy.Accumulate ? 'bg-blue-50 border-blue-500 text-blue-700 shadow-sm' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}
            >
                Accumulo (Solo Acquisti)
            </button>
            <button 
                onClick={() => setStrategy(RebalanceStrategy.Maintain)}
                className={`flex-1 py-3 px-4 rounded-xl border text-sm font-medium transition-all ${strategy === RebalanceStrategy.Maintain ? 'bg-blue-50 border-blue-500 text-blue-700 shadow-sm' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}
            >
                Mantenimento (Acquista & Vendi)
            </button>
        </div>

        {strategy === RebalanceStrategy.Accumulate && (
            <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">Liquidità da investire (CHF)</label>
                <div className="relative">
                    <span className="absolute left-3 top-2.5 text-gray-400 font-bold">CHF</span>
                    <input 
                        type="number" 
                        value={cashInjection} 
                        onChange={e => setCashInjection(Number(e.target.value))}
                        className="w-full border border-gray-300 pl-12 p-2.5 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
                    />
                </div>
            </div>
        )}
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50">
            <h3 className="font-semibold text-gray-800">Ordini Suggeriti</h3>
        </div>
        <table className="w-full text-sm text-left">
            <thead className="bg-white text-gray-500 border-b border-gray-100">
                <tr>
                    <th className="px-6 py-3 font-medium">Strumento</th>
                    <th className="px-6 py-3 font-medium">Azione</th>
                    <th className="px-6 py-3 font-medium text-right">Importo (CHF)</th>
                    <th className="px-6 py-3 font-medium text-right">Target %</th>
                </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
                {rebalancingPlan.map(p => (
                    <tr key={p.ticker} className="hover:bg-gray-50">
                        <td className="px-6 py-4 font-bold text-gray-800">{p.ticker}</td>
                        <td className="px-6 py-4">
                            <span className={`px-3 py-1 rounded-full text-xs font-bold flex w-fit items-center gap-1 ${p.action === 'BUY' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                                <span className="material-symbols-outlined text-[16px]">{p.action === 'BUY' ? 'add' : 'remove'}</span>
                                {p.action === 'BUY' ? 'COMPRA' : 'VENDI'}
                            </span>
                        </td>
                        <td className="px-6 py-4 text-right font-mono">{p.amount.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                        <td className="px-6 py-4 text-right text-gray-500">{p.targetPct}%</td>
                    </tr>
                ))}
                {rebalancingPlan.length === 0 && (
                     <tr><td colSpan={4} className="text-center py-12 text-gray-400 flex flex-col items-center justify-center">
                        <span className="material-symbols-outlined text-4xl mb-2 opacity-30">check_circle</span>
                        Portafoglio bilanciato o nessun target impostato.
                     </td></tr>
                )}
            </tbody>
        </table>
      </div>
    </div>
  );
};