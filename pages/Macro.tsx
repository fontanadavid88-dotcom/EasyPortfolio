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
      <h2 className="text-2xl font-bold text-gray-900">Sentiment Macroeconomico</h2>
      
      <div className="grid md:grid-cols-2 gap-6">
        <MacroGauge value={currentMacro?.value || 50} />

        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
            <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <span className="material-symbols-outlined text-gray-500">edit</span>
                Aggiorna Indicatore
            </h3>
            <p className="text-sm text-gray-500 mb-6 leading-relaxed">
                Regola manualmente il punteggio di sentiment (0-100) o calcolalo basandoti su metriche sottostanti (Inflazione, Tassi, Spread) nei prossimi aggiornamenti.
            </p>
            
            <div className="mb-8">
                <label className="block text-sm font-bold text-gray-700 mb-2">Punteggio: {manualValue}</label>
                <input 
                    type="range" 
                    min="0" max="100" 
                    value={manualValue} 
                    onChange={e => setManualValue(Number(e.target.value))}
                    className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                />
                <div className="flex justify-between text-xs font-semibold text-gray-400 mt-2 uppercase tracking-wide">
                    <span>Crisi (0)</span>
                    <span>Neutro (50)</span>
                    <span>Euforia (100)</span>
                </div>
            </div>

            <button 
                onClick={saveMacro}
                className="w-full bg-blue-600 text-white py-3 rounded-xl hover:bg-blue-700 transition font-medium shadow-sm shadow-blue-200"
            >
                Salva Nuovo Stato
            </button>
        </div>
      </div>
    </div>
  );
};