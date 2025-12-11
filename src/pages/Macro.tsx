import React, { useState } from 'react';
import { db } from '../db';
import { useLiveQuery } from 'dexie-react-hooks';
import { MacroGauge } from '../components/MacroGauge';

export const Macro: React.FC = () => {
  const currentMacro = useLiveQuery(() => db.macro.orderBy('date').last());
  const [manualValue, setManualValue] = useState(50);

  const saveMacro = async () => {
    await db.macro.add({
      date: new Date().toISOString(),
      value: manualValue,
      note: 'Manual Update'
    });
    alert('Indicatore aggiornato!');
  };

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-shell-text">Sentiment Macroeconomico</h2>
      
      <div className="grid md:grid-cols-2 gap-6">
        <MacroGauge value={currentMacro?.value || 50} />

        <div className="bg-panel p-6 rounded-2xl shadow-card border border-panel-border">
            <h3 className="text-lg font-semibold mb-4 flex items-center gap-2 text-panel-text">
                <span className="material-symbols-outlined text-panel-muted">edit</span>
                Aggiorna Indicatore
            </h3>
            <p className="text-sm text-panel-muted mb-6 leading-relaxed">
                Regola manualmente il punteggio di sentiment (0-100) o calcolalo basandoti su metriche sottostanti (Inflazione, Tassi, Spread) nei prossimi aggiornamenti.
            </p>
            
            <div className="mb-8">
                <label className="block text-sm font-bold text-panel-text mb-2">Punteggio: {manualValue}</label>
                <input 
                    type="range" 
                    min="0" max="100" 
                    value={manualValue} 
                    onChange={e => setManualValue(Number(e.target.value))}
                    className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-primary"
                />
                <div className="flex justify-between text-xs font-semibold text-panel-muted mt-2 uppercase tracking-wide">
                    <span>Crisi (0)</span>
                    <span>Neutro (50)</span>
                    <span>Euforia (100)</span>
                </div>
            </div>

            <button 
                onClick={saveMacro}
                className="w-full bg-primary text-white py-3 rounded-xl hover:bg-primary/90 transition font-medium shadow-lg shadow-primary/30"
            >
                Salva Nuovo Stato
            </button>
        </div>
      </div>
    </div>
  );
};