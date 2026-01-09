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
        <div className="space-y-8 max-w-4xl animate-fade-in text-textPrimary">
            <div className="bg-backgroundElevated p-8 rounded-2xl shadow-lg border border-borderSoft">
                <h2 className="text-xl font-bold mb-6 flex items-center gap-2 text-textPrimary">
                    <span className="material-symbols-outlined text-primary">database</span>
                    Fonti Dati
                </h2>
                <div className="space-y-6">
                    <div>
                        <label className="block text-sm font-bold text-gray-400 mb-2">EODHD API Key</label>
                        <input
                            type="password"
                            className="w-full border border-borderSoft bg-backgroundDark p-3 rounded-xl focus:ring-2 focus:ring-primary focus:outline-none transition-all text-white"
                            value={config.eodhdApiKey}
                            onChange={e => setConfig({ ...config, eodhdApiKey: e.target.value })}
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-bold text-gray-400 mb-2">Price Sheet URL (JSON output)</label>
                        <input
                            className="w-full border border-borderSoft bg-backgroundDark p-3 rounded-xl text-sm text-gray-300 focus:ring-2 focus:ring-primary focus:outline-none transition-all"
                            value={config.googleSheetUrl}
                            onChange={e => setConfig({ ...config, googleSheetUrl: e.target.value })}
                        />
                        <p className="text-xs text-gray-500 mt-2 ml-1">L'URL deve puntare a un endpoint pubblico JSON o Google Viz API.</p>
                    </div>
                    <div className="flex gap-4 pt-4">
                        <button onClick={handleSave} className="bg-backgroundDark border border-borderSoft text-white px-6 py-3 rounded-xl text-sm font-medium hover:bg-white/5 transition shadow-lg">
                            Salva Configurazione
                        </button>
                        <button onClick={handleSync} disabled={loading} className="bg-primary text-white px-6 py-3 rounded-xl text-sm font-bold disabled:opacity-50 hover:bg-blue-600 transition shadow-lg hover:shadow-primary/30 flex items-center gap-2">
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
            <div className="bg-red-900/10 p-8 rounded-2xl shadow-sm border border-red-500/20">
                <h2 className="text-lg font-bold text-red-400 mb-2 flex items-center gap-2">
                    <span className="material-symbols-outlined">warning</span>
                    Zona Pericolo
                </h2>
                <p className="text-sm text-red-200/70 mb-6 leading-relaxed">
                    Se l'applicazione non visualizza i dati corretti o hai conflitti con versioni precedenti, puoi resettare il database.
                    Questo cancellerà tutto e ricaricherà i dati demo.
                </p>
                <button
                    onClick={handleReset}
                    className="bg-red-500/10 border border-red-500/30 text-red-400 px-5 py-2.5 rounded-xl text-sm font-bold hover:bg-red-500/20 transition shadow-sm"
                >
                    Resetta Database e Ricarica
                </button>
            </div>
        </div>
    );
};