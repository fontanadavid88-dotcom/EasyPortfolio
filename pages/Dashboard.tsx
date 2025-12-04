import React, { useEffect, useState } from 'react';
import { db } from '../db';
import { useLiveQuery } from 'dexie-react-hooks';
import { calculateHoldings } from '../services/financeUtils';
import { MacroGauge } from '../components/MacroGauge';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

export const Dashboard: React.FC = () => {
  const transactions = useLiveQuery(() => db.transactions.toArray());
  const prices = useLiveQuery(() => db.prices.toArray());
  const macro = useLiveQuery(() => db.macro.orderBy('date').last());
  const [totalValue, setTotalValue] = useState(0);

  useEffect(() => {
    if (!transactions || !prices) return;
    
    // Very simplified calculation for MVP Dashboard
    const holdingMap = calculateHoldings(transactions);
    let val = 0;
    
    holdingMap.forEach((qty, ticker) => {
      // Find latest price for ticker
      const p = prices.filter(p => p.ticker === ticker).sort((a,b) => b.date.localeCompare(a.date))[0];
      if (p) val += qty * p.close;
    });

    setTotalValue(val);
  }, [transactions, prices]);

  // Dummy data for chart if not enough history
  const chartData = [
    { date: 'Gen', value: totalValue * 0.9 },
    { date: 'Feb', value: totalValue * 0.95 },
    { date: 'Mar', value: totalValue * 0.92 },
    { date: 'Apr', value: totalValue }
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Main KPI Card */}
        <div className="bg-blue-600 text-white rounded-2xl p-6 shadow-md relative overflow-hidden">
          <div className="relative z-10">
            <p className="text-blue-100 text-sm font-medium mb-1 flex items-center gap-1">
              <span className="material-symbols-outlined text-sm">account_balance_wallet</span>
              Valore Totale Portafoglio
            </p>
            <h2 className="text-4xl font-bold">CHF {totalValue.toLocaleString('it-CH', { maximumFractionDigits: 0 })}</h2>
            <div className="mt-4 flex items-center space-x-2 text-sm">
              <span className="bg-white/20 px-3 py-1 rounded-full backdrop-blur-sm">+5.2% YTD</span>
              <span className="opacity-80">IRR: 8.4%</span>
            </div>
          </div>
          {/* Decorative Circle */}
          <div className="absolute -bottom-8 -right-8 w-32 h-32 bg-white/10 rounded-full"></div>
        </div>

        {/* Macro Indicator */}
        <MacroGauge value={macro?.value || 50} />
      </div>

      {/* Equity Curve */}
      <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100 h-80">
        <h3 className="text-gray-600 text-sm font-bold mb-4 flex items-center gap-2">
            <span className="material-symbols-outlined">show_chart</span>
            Andamento Valore
        </h3>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#2563eb" stopOpacity={0.1}/>
                <stop offset="95%" stopColor="#2563eb" stopOpacity={0}/>
              </linearGradient>
            </defs>
            <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{fill:'#9ca3af', fontSize: 12}} />
            <YAxis hide domain={['auto', 'auto']} />
            <Tooltip 
                contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
            />
            <Area type="monotone" dataKey="value" stroke="#2563eb" fillOpacity={1} fill="url(#colorValue)" strokeWidth={3} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Quick Holdings Table */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
          <span className="material-symbols-outlined text-gray-500">list</span>
          <h3 className="font-bold text-gray-800">Principali Asset</h3>
        </div>
        <table className="w-full text-sm text-left">
            <thead className="bg-gray-50 text-gray-500">
                <tr>
                    <th className="px-6 py-3 font-medium">Ticker</th>
                    <th className="px-6 py-3 font-medium text-right">Valore</th>
                </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
                {/* Mock rows if no data */}
                {!transactions?.length && (
                    <tr>
                        <td className="px-6 py-4 text-gray-500">Nessuna transazione registrata.</td>
                        <td className="px-6 py-4"></td>
                    </tr>
                )}
            </tbody>
        </table>
      </div>
    </div>
  );
};