import React from 'react';
import { BacktestImport } from '../../types';

export const BacktestImportList: React.FC<{
  imports: BacktestImport[];
  selectedImportIds: Set<number>;
  onAdd: (imp: BacktestImport) => void;
  onDelete: (imp: BacktestImport) => void;
}> = ({ imports, selectedImportIds, onAdd, onDelete }) => {
  return (
    <div className="ui-panel-subtle p-4 space-y-3">
      <div className="text-sm font-semibold text-slate-700">Import CSV disponibili</div>
      {imports.length === 0 && (
        <div className="text-xs text-slate-500">Nessun import CSV disponibile.</div>
      )}
      {imports.length > 0 && (
        <div className="space-y-2">
          {imports.map(imp => {
            const isSelected = imp.id ? selectedImportIds.has(imp.id) : false;
            return (
              <div key={imp.id} className="ui-panel-dense p-3 flex flex-col gap-2">
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
                  <div>
                    <div className="font-semibold text-slate-800">{imp.name}</div>
                    <div className="text-xs text-slate-500">
                      {imp.ticker} · {imp.currency} · {imp.assetClass}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      Storico: {imp.firstDate || '—'} → {imp.lastDate || '—'} · Righe valide: {imp.validRowCount}
                    </div>
                    <div className="text-[11px] text-slate-400">File: {imp.originalFileName}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] uppercase tracking-wide font-semibold px-2 py-1 rounded-full border bg-slate-100 text-slate-600 border-slate-200">
                      CSV
                    </span>
                    <button
                      type="button"
                      className="ui-btn-secondary px-3 py-2 text-xs"
                      disabled={isSelected}
                      onClick={() => onAdd(imp)}
                    >
                      {isSelected ? 'Già aggiunto' : 'Aggiungi'}
                    </button>
                    <button
                      type="button"
                      className="ui-btn-ghost px-2 py-1 text-xs"
                      onClick={() => onDelete(imp)}
                    >
                      Elimina
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
