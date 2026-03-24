import React from 'react';
import clsx from 'clsx';
import { BacktestScenarioRecord } from '../../types';

const formatDate = (value?: string) => value ? value.slice(0, 10) : '-';

export const BacktestScenarioList: React.FC<{
  scenarios: BacktestScenarioRecord[];
  currentScenarioId?: number | null;
  onOpen: (id: number) => void;
  onDuplicate: (id: number) => void;
  onDelete: (id: number) => void;
}> = ({ scenarios, currentScenarioId, onOpen, onDuplicate, onDelete }) => {
  return (
    <div className="ui-panel-subtle p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-700">Scenari salvati</div>
        <div className="text-xs text-slate-500">{scenarios.length} totali</div>
      </div>
      {scenarios.length === 0 && (
        <div className="text-xs text-slate-500">Nessuno scenario salvato.</div>
      )}
      {scenarios.length > 0 && (
        <div className="space-y-2">
          {scenarios.map(scenario => {
            const isActive = currentScenarioId === scenario.id;
            return (
              <div
                key={scenario.id}
                className={clsx(
                  'border rounded-lg p-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between',
                  isActive ? 'border-emerald-300 bg-emerald-50/40' : 'border-slate-200 bg-white'
                )}
              >
                <div className="space-y-1">
                  <div className="text-sm font-semibold text-slate-800">
                    {scenario.title || 'Scenario senza titolo'}
                  </div>
                  <div className="text-xs text-slate-500">
                    {scenario.startDate} {'->'} {scenario.endDate} - {scenario.assets?.length || 0} asset - Aggiornato {formatDate(scenario.updatedAt)}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" className="ui-btn-secondary px-3 py-1 text-xs" onClick={() => scenario.id && onOpen(scenario.id)}>
                    Apri
                  </button>
                  <button type="button" className="ui-btn-secondary px-3 py-1 text-xs" onClick={() => scenario.id && onDuplicate(scenario.id)}>
                    Duplica
                  </button>
                  <button type="button" className="ui-btn-ghost px-3 py-1 text-xs text-rose-600" onClick={() => scenario.id && onDelete(scenario.id)}>
                    Elimina
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
