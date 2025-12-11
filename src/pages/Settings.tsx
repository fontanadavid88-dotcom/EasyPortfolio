import React, { useEffect, useState } from 'react';
import { db, seedDatabase } from '../db';
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

  const handleReset = async () => {
      if (confirm('ATTENZIONE: Stai per cancellare tutti i dati (Transazioni, Strumenti, Prezzi). L\'azione è irreversibile. Vuoi procedere?')) {
          await (db as any).delete();
          window.location.reload(); 
      }
  };

  return (
    <div className="space-y-8 max-w-4xl">
      <div className="bg-panel p-8 rounded-2xl shadow-card border border-panel-border">
        <h2 className="text-xl font-bold mb-6 flex items-center gap-2 text-panel-text">
            <span className="material-symbols-outlined text-primary">database</span>
            Fonti Dati
        </h2>
        <div className="space-y-6">
            <div>
                <label className="block text-sm font-bold text-panel-muted mb-2">EODHD API Key</label>
                <input 
                    type="password"
                    className="w-full border border-gray-200 bg-gray-50 p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none transition-all text-panel-text"
                    value={config.eodhdApiKey}
                    onChange={e => setConfig({...config, eodhdApiKey: e.target.value})}
                />
            </div>
            <div>
                <label className="block text-sm font-bold text-panel-muted mb-2">Price Sheet URL (JSON output)</label>
                <input 
                    className="w-full border border-gray-200 bg-gray-50 p-3 rounded-xl text-sm text-panel-muted focus:text-panel-text focus:ring-2 focus:ring-primary focus:outline-none transition-all"
                    value={config.googleSheetUrl}
                    onChange={e => setConfig({...config, googleSheetUrl: e.target.value})}
                />
                <p className="text-xs text-panel-muted mt-2 ml-1">L'URL deve puntare a un endpoint pubblico JSON o Google Viz API.</p>
            </div>
            <div className="flex gap-4 pt-4">
                <button onClick={handleSave} className="bg-shell-elevated text-white px-6 py-3 rounded-xl text-sm font-medium hover:bg-black transition shadow-lg">
                    Salva Configurazione
                </button>
                <button onClick={handleSync} disabled={loading} className="bg-primary text-white px-6 py-3 rounded-xl text-sm font-medium disabled:opacity-50 hover:bg-primary/90 transition shadow-lg flex items-center gap-2">
                    {loading ? (
                        <>
                           <span className="material-symbols-outlined animate-spin text-sm">refresh</span>
                           Aggiornamento...
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

      {/* DANGER ZONE */}
      <div className="bg-negative/5 p-8 rounded-2xl shadow-sm border border-negative/20">
          <h2 className="text-lg font-bold text-negative mb-2 flex items-center gap-2">
              <span className="material-symbols-outlined">warning</span>
              Zona Pericolo
          </h2>
          <p className="text-sm text-negative/80 mb-6 leading-relaxed">
              Se l'applicazione non visualizza i dati corretti o hai conflitti con versioni precedenti, puoi resettare il database. 
              Questo cancellerà tutto e ricaricherà i dati demo.
          </p>
          <button 
            onClick={handleReset}
            className="bg-panel border border-negative/30 text-negative px-5 py-2.5 rounded-xl text-sm font-bold hover:bg-negative/10 transition shadow-sm"
          >
              Resetta Database e Ricarica
          </button>
      </div>
    </div>
  );
};