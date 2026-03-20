import React, { useMemo } from 'react';
import clsx from 'clsx';
import { Instrument } from '../../types';
import { BacktestScenarioInput, BacktestDataQualitySummary } from '../../services/backtestTypes';
import { BacktestAssetsTable } from './BacktestAssetsTable';
import { AllocationStatus } from './AllocationStatus';

const normalizeAllocations = (assets: BacktestScenarioInput['assets']) => {
  const total = assets.reduce((sum, a) => sum + (Number.isFinite(a.allocationPct) ? a.allocationPct : 0), 0);
  if (total <= 0) return assets;
  const scaled = assets.map(a => ({
    ...a,
    allocationPct: Math.round(((a.allocationPct || 0) / total) * 10000) / 100
  }));
  const roundedTotal = scaled.reduce((sum, a) => sum + (a.allocationPct || 0), 0);
  const diff = Math.round((100 - roundedTotal) * 100) / 100;
  if (scaled.length > 0 && Math.abs(diff) > 0) {
    const lastIdx = scaled.length - 1;
    scaled[lastIdx] = {
      ...scaled[lastIdx],
      allocationPct: Math.round((scaled[lastIdx].allocationPct + diff) * 100) / 100
    };
  }
  return scaled;
};

export const BacktestBuilder: React.FC<{
  scenario: BacktestScenarioInput;
  instruments: Instrument[];
  quality: BacktestDataQualitySummary | null;
  qualityLoading?: boolean;
  onScenarioChange: (next: BacktestScenarioInput) => void;
  onRun: () => void;
  isRunning?: boolean;
}> = ({ scenario, instruments, quality, qualityLoading, onScenarioChange, onRun, isRunning }) => {
  const allocationSum = useMemo(
    () => scenario.assets.reduce((sum, a) => sum + (Number.isFinite(a.allocationPct) ? a.allocationPct : 0), 0),
    [scenario.assets]
  );

  const qualityStatusLabel = useMemo(() => {
    if (!quality?.status) return null;
    if (quality.status === 'full') return { text: 'Full', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
    if (quality.status === 'partial-runnable') return { text: 'Parziale ma eseguibile', className: 'bg-amber-50 text-amber-700 border-amber-200' };
    if (quality.status === 'partial-blocking') return { text: 'Parziale bloccante', className: 'bg-rose-50 text-rose-700 border-rose-200' };
    return { text: 'Missing', className: 'bg-rose-50 text-rose-700 border-rose-200' };
  }, [quality?.status]);

  const validationErrors = useMemo(() => {
    const errors: string[] = [];
    if (!scenario.title.trim()) errors.push('Inserisci un titolo per il backtest.');
    if (!scenario.startDate || !scenario.endDate) errors.push('Date non valide.');
    if (scenario.startDate && scenario.endDate && scenario.startDate > scenario.endDate) errors.push('La data di inizio è successiva alla data di fine.');
    if (scenario.initialCapital < 0) errors.push('Il capitale iniziale non può essere negativo.');
    if (scenario.annualContribution < 0) errors.push('Il versamento annuale non può essere negativo.');
    if (scenario.assets.length === 0) errors.push('Aggiungi almeno uno strumento.');
    if (Math.abs(allocationSum - 100) > 0.01) errors.push('La somma delle allocazioni deve essere 100%.');
    if (quality && !quality.canRun) {
      errors.push(quality.blockingReason || 'Dati insufficienti per il backtest.');
    }
    return errors;
  }, [scenario, allocationSum, quality]);

  const canRun = validationErrors.length === 0 && !qualityLoading && !isRunning;

  return (
    <div className="space-y-6">
      <div className="ui-panel p-6 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Backtest</h1>
            <p className="text-sm text-slate-500">Costruisci uno scenario e simula un portafoglio modello.</p>
          </div>
          <div className="text-xs text-slate-400 text-right">
            Base currency
            <div className="text-sm font-semibold text-slate-700">{scenario.baseCurrency}</div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          <div>
            <label className="text-sm font-semibold text-slate-700">Titolo del test</label>
            <input
              className="ui-input mt-2"
              value={scenario.title}
              onChange={e => onScenarioChange({ ...scenario, title: e.target.value })}
              placeholder="Es. Portafoglio bilanciato 60/30/10"
            />
          </div>
          <div>
            <label className="text-sm font-semibold text-slate-700">Data inizio</label>
            <input
              type="date"
              className="ui-input mt-2"
              value={scenario.startDate}
              onChange={e => onScenarioChange({ ...scenario, startDate: e.target.value })}
            />
          </div>
          <div>
            <label className="text-sm font-semibold text-slate-700">Data fine</label>
            <input
              type="date"
              className="ui-input mt-2"
              value={scenario.endDate}
              onChange={e => onScenarioChange({ ...scenario, endDate: e.target.value })}
            />
          </div>
          <div>
            <label className="text-sm font-semibold text-slate-700">Capitale iniziale</label>
            <input
              type="number"
              min="0"
              className="ui-input mt-2"
              value={scenario.initialCapital}
              onChange={e => onScenarioChange({ ...scenario, initialCapital: Number(e.target.value) })}
            />
          </div>
          <div>
            <label className="text-sm font-semibold text-slate-700">Versamento annuale</label>
            <input
              type="number"
              min="0"
              className="ui-input mt-2"
              value={scenario.annualContribution}
              onChange={e => onScenarioChange({ ...scenario, annualContribution: Number(e.target.value) })}
            />
          </div>
          <div>
            <label className="text-sm font-semibold text-slate-700">Ribilanciamento</label>
            <select
              className="ui-input mt-2"
              value={scenario.rebalanceFrequency}
              onChange={e => onScenarioChange({ ...scenario, rebalanceFrequency: e.target.value as BacktestScenarioInput['rebalanceFrequency'] })}
            >
              <option value="none">No</option>
              <option value="annual">Annuale</option>
            </select>
          </div>
        </div>
      </div>

      <BacktestAssetsTable
        assets={scenario.assets}
        instruments={instruments}
        onChange={(assets) => onScenarioChange({ ...scenario, assets })}
        qualityByTicker={quality?.byTicker}
      />

      <AllocationStatus
        total={allocationSum}
        onNormalize={() => onScenarioChange({ ...scenario, assets: normalizeAllocations(scenario.assets) })}
        canNormalize={scenario.assets.length > 0 && Math.abs(allocationSum - 100) > 0.01}
      />

      <div className="ui-panel-subtle p-4 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-700">Qualità dati scenario</div>
          {qualityStatusLabel && (
            <span className={clsx('text-[11px] uppercase tracking-wide font-semibold px-2 py-1 rounded-full border', qualityStatusLabel.className)}>
              {qualityStatusLabel.text}
            </span>
          )}
        </div>
        {qualityLoading && <div className="text-xs text-slate-500">Analisi dati in corso...</div>}
        {!qualityLoading && (!quality || quality.messages.length === 0) && (
          <div className="text-xs text-slate-500">Nessuna analisi disponibile.</div>
        )}
        {!qualityLoading && quality && (
          <div className="text-xs text-slate-600 space-y-1">
            <div>Richiesto: {quality.requestedStartDate || '—'} → {quality.requestedEndDate || '—'}</div>
            <div>Disponibile: {quality.availableStartDate || '—'} → {quality.availableEndDate || '—'}</div>
            <div>Effettivo: {quality.effectiveStartDate || '—'} → {quality.effectiveEndDate || '—'}</div>
          </div>
        )}
        {!qualityLoading && quality && quality.messages.length > 0 && (
          <ul className="text-xs text-slate-600 list-disc pl-4">
            {quality.messages.map((msg, idx) => (
              <li key={idx}>{msg}</li>
            ))}
          </ul>
        )}
        {!qualityLoading && quality?.warningMessage && (
          <div className="mt-2 text-xs text-amber-700">
            {quality.warningMessage}
          </div>
        )}
      </div>

      {validationErrors.length > 0 && (
        <div className="ui-panel-subtle border-amber-200 bg-amber-50 p-4 text-xs text-amber-800 space-y-1">
          <div className="font-semibold">Correggi i seguenti punti prima di eseguire:</div>
          <ul className="list-disc pl-4">
            {validationErrors.map((err, idx) => (
              <li key={idx}>{err}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={onRun}
          disabled={!canRun}
          className={clsx('ui-btn-primary', !canRun && 'cursor-not-allowed')}
        >
          {isRunning ? 'Esecuzione...' : 'Esegui backtest'}
        </button>
      </div>
    </div>
  );
};
