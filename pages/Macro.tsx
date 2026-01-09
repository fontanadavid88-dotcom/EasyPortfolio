import React, { useState, useEffect, useMemo } from 'react';
import { db, getCurrentPortfolioId } from '../db';
import { MacroGauge } from '../components/MacroGauge';
import { fetchMacroData, MacroIndicatorConfig, DEFAULT_INDICATORS, computeMacroIndex, mapIndexToPhase } from '../services/macroService';

export const Macro: React.FC = () => {
  const [syncLoading, setSyncLoading] = useState(false);
  const currentPortfolioId = getCurrentPortfolioId();

  // Load config from local storage or use defaults
  const [indicators, setIndicators] = useState<MacroIndicatorConfig[]>(() => {
    const saved = localStorage.getItem('macro_indicators_config');
    return saved ? JSON.parse(saved) : DEFAULT_INDICATORS;
  });

  // Persist changes
  useEffect(() => {
    localStorage.setItem('macro_indicators_config', JSON.stringify(indicators));
  }, [indicators]);

  // Compute derived state
  const { index01, rows } = useMemo(() => computeMacroIndex(indicators), [indicators]);

  // Map index01 (0=Expansion, 1=Crisis) to Gauge Score (0=Crisis, 100=Euphoria)
  const gaugeScore = Math.round((1 - index01) * 100);
  const phase = mapIndexToPhase(index01);

  // Handlers
  const handleUpdate = (id: string, field: keyof MacroIndicatorConfig, value: string | number) => {
    setIndicators(prev => prev.map(ind => {
      if (ind.id !== id) return ind;
      return { ...ind, [field]: Number(value) };
    }));
  };

  const handleReset = () => {
    if (confirm("Sei sicuro di voler ripristinare i valori predefiniti?")) {
      setIndicators(DEFAULT_INDICATORS);
    }
  };

  const handleSync = async () => {
    setSyncLoading(true);
    try {
      // Get URL from Settings DB
      const settings = await db.settings.get(1);
      // fallback: try portfolio-specific
      const portfolioSettings = await db.settings.where('portfolioId').equals(currentPortfolioId).first();
      const effectiveSettings = portfolioSettings || settings;
      if (!effectiveSettings || !effectiveSettings.googleSheetUrl) {
        alert("URL Google Sheet non configurato nelle Impostazioni.");
        return;
      }

      const data = await fetchMacroData(effectiveSettings.googleSheetUrl);
      if (data.length === 0) {
        alert("Nessun dato trovato nel foglio 'Macro'. Assicurati che le colonne siano: ID, Valore.");
        return;
      }

      // Update indicators matching ID
      setIndicators(prev => prev.map(ind => {
        // Try strict ID match first, then fuzzy Name match
        const match = data.find(d => d.id === ind.id || d.id === ind.name);
        if (match) {
          return {
            ...ind,
            currentValue: match.value,
            // Update min/max only if present in sheet
            minValue: match.min !== undefined ? match.min : ind.minValue,
            maxValue: match.max !== undefined ? match.max : ind.maxValue
          };
        }
        return ind;
      }));

      alert(`Aggiornati ${data.length} indicatori da Google Sheet!`);

    } catch (e: any) {
      console.error(e);
      alert(`Errore sync: ${e.message}`);
    } finally {
      setSyncLoading(false);
    }
  };

  // Optional: Save to DB history (snapshot)
  const saveSnapshot = async () => {
    await db.macro.add({
      date: new Date().toISOString(),
      value: gaugeScore,
      note: `Macro Index Snapshot: ${phase} (${indicators.length} indicators)`,
      portfolioId: currentPortfolioId
    });
    alert('Istantanea salvata nello storico!');
  };

  return (
    <div className="space-y-6 animate-fade-in text-slate-900 pb-10">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">public</span>
          Sentiment Macroeconomico
        </h2>
        <button onClick={saveSnapshot} className="flex items-center gap-2 text-sm text-primary hover:underline font-medium">
          <span className="material-symbols-outlined text-[18px]">history</span>
          Salva Snapshot
        </button>
      </div>

      <div className="grid lg:grid-cols-4 gap-6">

        {/* LEFT GAUGE CARD */}
        <div className="lg:col-span-1 bg-white p-6 rounded-2xl shadow-lg border border-borderSoft flex flex-col items-start">
          <h3 className="font-bold text-slate-900 mb-6 text-xs uppercase tracking-wider flex items-center gap-2">
            <span className="w-1 h-4 rounded-full bg-[#0052a3] shadow-[0_0_10px_rgba(0,82,163,0.5)]"></span> Macro Indicator
          </h3>
          <div className="w-full flex justify-center">
            <MacroGauge value={gaugeScore} />
          </div>
        </div>

        {/* RIGHT CONFIG CARTA */}
        <div className="lg:col-span-3 bg-white p-6 rounded-2xl shadow-lg border border-borderSoft">
          <div className="flex justify-between items-center mb-6">
            <div>
              <h3 className="text-lg font-semibold flex items-center gap-2">
                <span className="material-symbols-outlined text-primary">tune</span>
                Configura Indicatori
              </h3>
              <p className="text-sm text-slate-500">
                Il punteggio è calcolato pesando i seguenti indicatori macroeconomici.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleSync}
                disabled={syncLoading}
                className="text-xs bg-blue-50 hover:bg-blue-100 text-blue-600 px-3 py-1 rounded-full transition flex items-center gap-1 font-medium border border-blue-200"
              >
                {syncLoading ? (
                  <span className="material-symbols-outlined animate-spin text-[14px]">refresh</span>
                ) : (
                  <span className="material-symbols-outlined text-[14px]">cloud_download</span>
                )}
                {syncLoading ? "Loading..." : "Aggiorna da Sheet"}
              </button>
              <button
                onClick={handleReset}
                className="text-xs bg-slate-100 hover:bg-slate-200 text-slate-600 px-3 py-1 rounded-full transition"
              >
                Ripristina Default
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-xs text-slate-400 uppercase bg-slate-50 border-b">
                <tr>
                  <th className="px-3 py-3">Indicatore</th>
                  <th className="px-3 py-3 w-24">Valore</th>
                  <th className="px-3 py-3 w-20">Min</th>
                  <th className="px-3 py-3 w-20">Max</th>
                  <th className="px-3 py-3 w-20">Peso %</th>
                  <th className="px-3 py-3 text-right">Norm. (0-1)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-50/50 transition">
                    <td className="px-3 py-3 font-medium text-slate-700">
                      {row.name}
                      <span className="block text-[10px] text-slate-400 font-normal">
                        {row.direction === "high_is_crisis" ? "Alto = Crisi" : "Basso = Crisi"}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <input
                        type="number"
                        step="0.01"
                        value={row.currentValue}
                        onChange={(e) => handleUpdate(row.id, 'currentValue', e.target.value)}
                        className="w-full bg-slate-100 border-none rounded px-2 py-1 text-slate-800 font-bold focus:ring-2 focus:ring-primary/50 text-right"
                      />
                      <span className="text-[10px] text-slate-400 block text-right mt-0.5">{row.unit}</span>
                    </td>
                    <td className="px-3 py-3">
                      <input
                        type="number"
                        step="0.1"
                        value={row.minValue}
                        onChange={(e) => handleUpdate(row.id, 'minValue', e.target.value)}
                        className="w-full bg-transparent border border-slate-200 rounded px-1 py-1 text-slate-500 text-right text-xs"
                      />
                    </td>
                    <td className="px-3 py-3">
                      <input
                        type="number"
                        step="0.1"
                        value={row.maxValue}
                        onChange={(e) => handleUpdate(row.id, 'maxValue', e.target.value)}
                        className="w-full bg-transparent border border-slate-200 rounded px-1 py-1 text-slate-500 text-right text-xs"
                      />
                    </td>
                    <td className="px-3 py-3">
                      <input
                        type="number"
                        min="0" max="100"
                        value={row.weight}
                        onChange={(e) => handleUpdate(row.id, 'weight', e.target.value)}
                        className="w-full bg-transparent border border-slate-200 rounded px-1 py-1 text-slate-600 text-right text-xs font-medium"
                      />
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-xs">
                      <div className="flex items-center justify-end gap-2">
                        <div className="w-16 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                          <div
                            className={`h-full ${row.normalized > 0.6 ? 'bg-red-400' : row.normalized < 0.4 ? 'bg-green-400' : 'bg-yellow-400'}`}
                            style={{ width: `${row.normalized * 100}%` }}
                          />
                        </div>
                        {row.normalized.toFixed(2)}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};
