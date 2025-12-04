import React, { useState } from 'react';
import { db } from '../db';
import { useLiveQuery } from 'dexie-react-hooks';
import { TransactionType, Currency } from '../types';

export const Transactions: React.FC = () => {
  const transactions = useLiveQuery(() => db.transactions.orderBy('date').reverse().toArray());
  const [isOpen, setIsOpen] = useState(false);

  // Form State
  const [formData, setFormData] = useState({
    date: new Date().toISOString().split('T')[0],
    type: TransactionType.Buy,
    ticker: '',
    qty: 0,
    price: 0,
    currency: Currency.CHF
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await db.transactions.add({
      date: new Date(formData.date),
      type: formData.type,
      instrumentTicker: formData.ticker.toUpperCase(),
      quantity: Number(formData.qty),
      price: Number(formData.price),
      currency: formData.currency,
      fees: 0,
      account: 'Default'
    });
    setIsOpen(false);
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
            Transazioni
        </h2>
        <button 
          onClick={() => setIsOpen(!isOpen)}
          className="bg-blue-600 text-white px-4 py-2 rounded-full text-sm hover:bg-blue-700 transition-colors shadow-sm flex items-center gap-2"
        >
          <span className="material-symbols-outlined text-sm">{isOpen ? 'close' : 'add'}</span>
          {isOpen ? 'Chiudi' : 'Nuova Transazione'}
        </button>
      </div>

      {isOpen && (
        <form onSubmit={handleSubmit} className="bg-white p-6 rounded-2xl shadow-md space-y-4 animate-in fade-in slide-in-from-top-2 border border-blue-100">
          <h3 className="text-lg font-semibold text-gray-700">Dettagli Operazione</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
             <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Data</label>
                <input 
                    type="date" 
                    className="w-full border border-gray-300 p-2.5 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
                    value={formData.date}
                    onChange={e => setFormData({...formData, date: e.target.value})}
                    required
                />
             </div>
             <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Tipo</label>
                <select 
                    className="w-full border border-gray-300 p-2.5 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
                    value={formData.type}
                    onChange={e => setFormData({...formData, type: e.target.value as TransactionType})}
                >
                    {Object.values(TransactionType).map(t => <option key={t} value={t}>{t}</option>)}
                </select>
             </div>
             <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Ticker</label>
                <input 
                    placeholder="Es. AAPL.US" 
                    className="w-full border border-gray-300 p-2.5 rounded-lg uppercase focus:ring-2 focus:ring-blue-500 focus:outline-none"
                    value={formData.ticker}
                    onChange={e => setFormData({...formData, ticker: e.target.value})}
                    required
                />
             </div>
             <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Quantità</label>
                <input 
                    type="number" placeholder="0" 
                    className="w-full border border-gray-300 p-2.5 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
                    step="0.0001"
                    value={formData.qty}
                    onChange={e => setFormData({...formData, qty: parseFloat(e.target.value)})}
                    required
                />
             </div>
             <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Prezzo Unitario</label>
                <input 
                    type="number" placeholder="0.00" 
                    className="w-full border border-gray-300 p-2.5 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
                    step="0.01"
                    value={formData.price}
                    onChange={e => setFormData({...formData, price: parseFloat(e.target.value)})}
                    required
                />
             </div>
             <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Valuta</label>
                <select 
                    className="w-full border border-gray-300 p-2.5 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
                    value={formData.currency}
                    onChange={e => setFormData({...formData, currency: e.target.value as Currency})}
                >
                    {Object.values(Currency).map(c => <option key={c} value={c}>{c}</option>)}
                </select>
             </div>
          </div>
          <div className="flex justify-end pt-2">
            <button type="submit" className="bg-gray-900 text-white px-6 py-2.5 rounded-lg hover:bg-gray-800 font-medium shadow-lg shadow-gray-200">
                Salva Operazione
            </button>
          </div>
        </form>
      )}

      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="w-full text-sm text-left">
          <thead className="bg-gray-50 text-gray-500">
            <tr>
              <th className="px-6 py-3 font-medium">Data</th>
              <th className="px-6 py-3 font-medium">Tipo</th>
              <th className="px-6 py-3 font-medium">Strumento</th>
              <th className="px-6 py-3 font-medium text-right">Qtà</th>
              <th className="px-6 py-3 font-medium text-right">Prezzo</th>
              <th className="px-6 py-3 font-medium text-right">Totale</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {transactions?.map(t => (
              <tr key={t.id} className="hover:bg-gray-50 transition-colors">
                <td className="px-6 py-4 text-gray-600">{t.date.toLocaleDateString('it-IT')}</td>
                <td className="px-6 py-4 font-medium">
                    <span className={`px-2 py-1 rounded-md text-xs font-bold ${t.type === 'Buy' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                        {t.type}
                    </span>
                </td>
                <td className="px-6 py-4 font-semibold text-gray-800">{t.instrumentTicker}</td>
                <td className="px-6 py-4 text-right">{t.quantity}</td>
                <td className="px-6 py-4 text-right">{t.price.toFixed(2)} {t.currency}</td>
                <td className="px-6 py-4 text-right text-gray-500 font-medium">{(t.quantity * t.price).toFixed(2)}</td>
              </tr>
            ))}
            {!transactions?.length && (
                <tr><td colSpan={6} className="text-center py-12 text-gray-400">Nessuna transazione trovata. Aggiungine una.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};