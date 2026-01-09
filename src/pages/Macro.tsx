import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../../db';
import { useLiveQuery } from 'dexie-react-hooks';
import { MacroGauge } from '../../components/MacroGauge';

// --- TYPES ---
export type MacroIndicatorDirection = "high_is_crisis" | "low_is_crisis";

export interface MacroIndicatorConfig {
  id: string;
  name: string;
  unit?: string;

  currentValue: number;
  minValue: number;
  maxValue: number;

  weight: number;          // 0-100 logic in UI, converted to 0-1 for calculation
  direction: MacroIndicatorDirection;

  sourceType?: "manual" | "api";
  sourceKey?: string;
}

interface MacroIndicatorComputed extends MacroIndicatorConfig {
  normalized: number; // 0-1 (0 = expansion/euforia, 1 = crisis)
  weighted: number;   // normalized * weight (0-1)
}

// --- HELPERS ---

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function normalizeIndicator(
  current: number,
  min: number,
  max: number,
  direction: MacroIndicatorDirection
): number {
  // Safe division
  const range = max - min;
  if (range === 0) return 0.5; // Neutral if range is 0

  let normalized = (current - min) / range;

  // If direction is "high_is_crisis", then higher value = closer to 1 (crisis)
  // If "low_is_crisis", then lower value = closer to 1 (crisis) -> invert
  if (direction === "low_is_crisis") {
    normalized = 1 - normalized;
  }

  return clamp01(normalized);
}

function computeMacroIndex(
  indicators: MacroIndicatorConfig[]
): { index01: number; rows: MacroIndicatorComputed[] } {
  let totalWeight = 0;
  const rows: MacroIndicatorComputed[] = indicators.map(ind => {
    const norm = normalizeIndicator(ind.currentValue, ind.minValue, ind.maxValue, ind.direction);
    totalWeight += ind.weight;
    return {
      ...ind,
      normalized: norm,
      weighted: 0 // placeholder
    };
  });

  // Calculate generic index
  let weightedSum = 0;

  if (totalWeight === 0) {
    // Edge case: no weights. Return simple average or 0.
    return { index01: 0.5, rows };
  }

  rows.forEach(r => {
    // Normalized weight relative to total sum
    const relWeight = r.weight / totalWeight;
    r.weighted = r.normalized * relWeight;
    weightedSum += r.weighted;
  });

  return { index01: clamp01(weightedSum), rows };
}

type MacroPhase = "CRISI" | "NEUTRO" | "EUFORIA";

function mapIndexToPhase(index01: number): MacroPhase {
  if (index01 > 0.60) return "CRISI";
  if (index01 < 0.40) return "EUFORIA";
  return "NEUTRO";
}

// --- DEFAULTS ---
const DEFAULT_INDICATORS: MacroIndicatorConfig[] = [
  { id: '1', name: 'Tasso Fed Funds', unit: '%', currentValue: 5.33, minValue: 0, maxValue: 10, weight: 15, direction: "high_is_crisis" },
  { id: '2', name: 'Lavoratori Temporanei', unit: 'k', currentValue: 2950, minValue: 2000, maxValue: 3500, weight: 10, direction: "low_is_crisis" },
  { id: '3', name: 'Tasso Disoccupazione', unit: '%', currentValue: 3.7, minValue: 3.4, maxValue: 10, weight: 20, direction: "high_is_crisis" },
  { id: '4', name: 'Sentiment Consumatori (UMich)', unit: 'pts', currentValue: 69, minValue: 50, maxValue: 100, weight: 10, direction: "low_is_crisis" },
  { id: '5', name: 'S&P 500 Earnings Yield', unit: '%', currentValue: 4.5, minValue: 3, maxValue: 7, weight: 15, direction: "low_is_crisis" }, // Low yield = expensive = risky? Usually Low Earnings Yield = High P/E = Euphoria (so normalized -> 0). Wait. 
  // Let's standardise: 1 = CRISIS. 
  // High Yield -> Cheap -> Good -> Expansion (0). 
  // Low Yield -> Expensive -> Bubble -> Risk (1).
  // So Low is Crisis.

  { id: '6', name: 'VIX (Indice Paura)', unit: 'pts', currentValue: 13, minValue: 10, maxValue: 60, weight: 10, direction: "high_is_crisis" },
  { id: '7', name: 'Spread 10Y-2Y Treasury', unit: 'bps', currentValue: -0.40, minValue: -1.0, maxValue: 2.0, weight: 20, direction: "low_is_crisis" }
  // Inverted curve (negative) is predictor of recession (Crisis). 
  // So Low (Negative) is Crisis.
];

export const Macro: React.FC = () => {
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
  // Required: 1 -> 0 (Crisis), 0 -> 100 (Euphoria)
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

  // Optional: Save to DB history (snapshot)
  const saveSnapshot = async () => {
    await db.macro.add({
      date: new Date().toISOString(),
      value: gaugeScore,
      note: `Macro Index Snapshot: ${phase} (${indicators.length} indicators)`
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

        {/* LEFT GAUGE CARD (Top Left - 1 col on Large screens? Maybe 1/3) */}
        <div className="lg:col-span-1 bg-white p-6 rounded-2xl shadow-lg border border-borderSoft flex flex-col items-center justify-center">
          <MacroGauge value={gaugeScore} />
          <div className="mt-4 text-center">
            <div className="text-4xl font-bold text-slate-800">{gaugeScore}</div>
            <div className={`text-sm font-bold tracking-widest uppercase mt-1 ${phase === 'CRISI' ? 'text-red-500' : phase === 'EUFORIA' ? 'text-green-500' : 'text-yellow-500'}`}>
              {phase}
            </div>
            <div className="text-xs text-slate-400 mt-2">
              Indice Normalizzato: {index01.toFixed(2)} (0=Exp, 1=Cry)
            </div>
          </div>
        </div>

        {/* RIGHT CONFIG CARTA (3 cols) */}
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
            <button
              onClick={handleReset}
              className="text-xs bg-slate-100 hover:bg-slate-200 text-slate-600 px-3 py-1 rounded-full transition"
            >
              Ripristina Default
            </button>
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