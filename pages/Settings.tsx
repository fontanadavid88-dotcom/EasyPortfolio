import React, { useEffect, useState } from 'react';
import { db } from '../db';
import { syncPrices } from '../services/priceService';
import { Currency } from '../types';

export const Settings: React.FC = () => {
  const [config, setConfig] = useState({
    eodhdApiKey: '',
    googleSheetUrl: '',
    baseCurrency: Currency.CHF
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    db.settings.toCollection().first().then(s => {
      if (s) setConfig(s);
    });
  }, []);

  const handleSave = async () => {
    await db.settings.put({ ...config, id: 1 }); // Singleton
    alert('Impostazioni salvate');
  };

  const handleSync = async () => {
    setLoading(true);
    try {
        await syncPrices();
        alert('Prezzi aggiornati con successo!');
    } catch (e) {
        alert('Errore aggiornamento prezzi.');
    } finally {
        setLoading(false);
    }
  };

  return (
    <div className="space-y-8 max-w-4xl">
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
        <h2 className="text-xl font-bold mb-6 flex items-center gap-2">
            <span className="material-symbols-outlined text-blue-600">database</span>
            Fonti Dati
        </h2>
        <div className="space-y-6">
            <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">EODHD API Key</label>
                <input 
                    type="password"
                    className="w-full border border-gray-300 p-2.5 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
                    value={config.eodhdApiKey}
                    onChange={e => setConfig({...config, eodhdApiKey: e.target.value})}
                />
            </div>
            <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Price Sheet URL (JSON output)</label>
                <input 
                    className="w-full border border-gray-300 p-2.5 rounded-lg text-sm text-gray-600 focus:ring-2 focus:ring-blue-500 focus:outline-none"
                    value={config.googleSheetUrl}
                    onChange={e => setConfig({...config, googleSheetUrl: e.target.value})}
                />
                <p className="text-xs text-gray-400 mt-1">L'URL deve puntare a un endpoint pubblico JSON o Google Viz API.</p>
            </div>
            <div className="flex gap-4 pt-2">
                <button onClick={handleSave} className="bg-gray-900 text-white px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-gray-800 transition shadow-sm">
                    Salva Configurazione
                </button>
                <button onClick={handleSync} disabled={loading} className="bg-blue-600 text-white px-5 py-2.5 rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-blue-700 transition shadow-sm flex items-center gap-2">
                    {loading ? (
                        <>
                           <span className="material-symbols-outlined animate-spin text-sm">refresh</span>
                           Aggiornamento in corso...
                        </>
                    ) : (
                        <>
                            <span className="material-symbols-outlined text-sm">sync</span>
                            Aggiorna Prezzi
                        </>
                    )}
                </button>
            </div>
        </div>
      </div>
    </div>
  );
};