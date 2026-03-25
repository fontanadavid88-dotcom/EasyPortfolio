import React, { useMemo, useState } from 'react';
import clsx from 'clsx';
import { BacktestScenarioRecord, Currency } from '../../types';
import { BacktestScenarioInput, BacktestResult } from '../../services/backtestTypes';
import { getBacktestScenarioById } from '../../services/backtestScenarioRepository';
import { loadBacktestScenarioData } from '../../services/backtestDataSource';
import { runBacktest } from '../../services/backtestEngine';
import { buildComparisonSeries, BacktestComparisonSeries } from '../../services/backtestComparison';
import { BacktestComparisonKpis } from './BacktestComparisonKpis';
import { BacktestComparisonChart } from './BacktestComparisonChart';
import { formatScenarioContribution, resolveContributionFields } from './backtestUiUtils';

const recordToScenario = (record: BacktestScenarioRecord): BacktestScenarioInput => {
  const { amount, frequency } = resolveContributionFields(record);
  return {
    title: record.title,
    startDate: record.startDate,
    endDate: record.endDate,
    initialCapital: record.initialCapital,
    periodicContributionAmount: amount,
    contributionFrequency: frequency,
    rebalanceFrequency: record.rebalanceFrequency,
    baseCurrency: (record.baseCurrency as Currency) || Currency.CHF,
    assets: record.assets || []
  };
};

const formatCurrency = (value: number, currency: string) => {
  if (!Number.isFinite(value)) return '-';
  return new Intl.NumberFormat('it-CH', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0
  }).format(value);
};


const ScenarioSummary: React.FC<{
  label: string;
  scenario?: BacktestScenarioInput;
  result?: BacktestResult | null;
  issue?: string | null;
  updatedAt?: string;
}> = ({ label, scenario, result, issue, updatedAt }) => {
  if (!scenario) return null;
  const effectiveStart = result?.effectiveStartDate || scenario.startDate;
  const effectiveEnd = result?.effectiveEndDate || scenario.endDate;
  const hasCsv = scenario.assets.some(a => a.source === 'CSV_IMPORT');
  const updated = updatedAt ? updatedAt.slice(0, 10) : '-';
  const contributionLabel = formatScenarioContribution(scenario);
  return (
    <div className="ui-panel-subtle p-4 space-y-2">
      <div className="text-xs uppercase tracking-wide text-slate-500 font-semibold">{label}</div>
      <div className="text-sm font-semibold text-slate-800">{scenario.title || 'Scenario'}</div>
      <div className="text-xs text-slate-500">Periodo effettivo: {effectiveStart} {'->'} {effectiveEnd}</div>
      <div className="text-xs text-slate-500">Asset: {scenario.assets.length} {hasCsv ? '(con CSV)' : ''}</div>
      <div className="text-xs text-slate-500">Aggiornato: {updated}</div>
      <div className="text-xs text-slate-500">Ribilanciamento: {scenario.rebalanceFrequency === 'annual' ? 'annuale' : 'no'}</div>
      <div className="text-xs text-slate-500">Capitale iniziale: {formatCurrency(scenario.initialCapital, scenario.baseCurrency)}</div>
      <div className="text-xs text-slate-500">Contributo periodico: {contributionLabel}</div>
      {issue && (
        <div className="text-xs text-rose-700">{issue}</div>
      )}
    </div>
  );
};

export const BacktestComparisonPanel: React.FC<{
  scenarios: BacktestScenarioRecord[];
  portfolioId: string;
}> = ({ scenarios, portfolioId }) => {
  const [scenarioAId, setScenarioAId] = useState<number | ''>('');
  const [scenarioBId, setScenarioBId] = useState<number | ''>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [scenarioA, setScenarioA] = useState<BacktestScenarioInput | null>(null);
  const [scenarioB, setScenarioB] = useState<BacktestScenarioInput | null>(null);
  const [recordA, setRecordA] = useState<BacktestScenarioRecord | null>(null);
  const [recordB, setRecordB] = useState<BacktestScenarioRecord | null>(null);
  const [resultA, setResultA] = useState<BacktestResult | null>(null);
  const [resultB, setResultB] = useState<BacktestResult | null>(null);
  const [issueA, setIssueA] = useState<string | null>(null);
  const [issueB, setIssueB] = useState<string | null>(null);
  const [comparison, setComparison] = useState<BacktestComparisonSeries | null>(null);

  const scenarioOptions = useMemo(() => scenarios.map(s => ({
    id: s.id as number,
    label: `${s.title || 'Scenario'} (${s.startDate} -> ${s.endDate}) - ${s.assets?.length || 0} asset - ${s.updatedAt ? s.updatedAt.slice(0, 10) : '-'}`
  })), [scenarios]);

  const runScenario = async (record: BacktestScenarioRecord) => {
    const scenario = recordToScenario(record);
    const data = await loadBacktestScenarioData(scenario, portfolioId);
    if (!data.quality.canRun) {
      return { scenario, result: null, issue: data.quality.blockingReason || 'Scenario non eseguibile.' };
    }
    const result = runBacktest(scenario, data);
    if (result.errors && result.errors.length > 0) {
      return { scenario, result: null, issue: result.errors[0] };
    }
    return { scenario, result, issue: null };
  };

  const handleCompare = async () => {
    setError(null);
    setIssueA(null);
    setIssueB(null);
    setComparison(null);
    setResultA(null);
    setResultB(null);

    if (!scenarioAId || !scenarioBId) {
      setError('Seleziona due scenari per il confronto.');
      return;
    }
    if (scenarioAId === scenarioBId) {
      setError('Seleziona due scenari diversi.');
      return;
    }

    setLoading(true);
    const recordA = await getBacktestScenarioById(Number(scenarioAId));
    const recordB = await getBacktestScenarioById(Number(scenarioBId));
    if (!recordA || !recordB) {
      setError('Scenario non trovato.');
      setLoading(false);
      return;
    }

    const [resA, resB] = await Promise.all([runScenario(recordA), runScenario(recordB)]);

    setScenarioA(resA.scenario);
    setScenarioB(resB.scenario);
    setRecordA(recordA);
    setRecordB(recordB);
    setIssueA(resA.issue);
    setIssueB(resB.issue);

    if (!resA.result || !resB.result) {
      setLoading(false);
      return;
    }

    setResultA(resA.result);
    setResultB(resB.result);
    setComparison(buildComparisonSeries(resA.result, resB.result));
    setLoading(false);
  };

  return (
    <div className="ui-panel-subtle p-4 space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-700">Confronto scenari (2)</div>
          <div className="text-xs text-slate-500">Seleziona due scenari salvati e confronta i risultati.</div>
        </div>
        <button
          type="button"
          className={clsx('ui-btn-primary', loading && 'cursor-not-allowed')}
          onClick={handleCompare}
          disabled={loading}
        >
          {loading ? 'Confronto in corso...' : 'Confronta'}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="text-xs font-semibold text-slate-600">Scenario A</label>
          <select
            className="ui-input mt-1"
            value={scenarioAId}
            onChange={e => setScenarioAId(e.target.value ? Number(e.target.value) : '')}
          >
            <option value="">Seleziona scenario</option>
            {scenarioOptions.map(opt => (
              <option key={opt.id} value={opt.id} disabled={opt.id === scenarioBId}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600">Scenario B</label>
          <select
            className="ui-input mt-1"
            value={scenarioBId}
            onChange={e => setScenarioBId(e.target.value ? Number(e.target.value) : '')}
          >
            <option value="">Seleziona scenario</option>
            {scenarioOptions.map(opt => (
              <option key={opt.id} value={opt.id} disabled={opt.id === scenarioAId}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div className="text-xs text-rose-700">{error}</div>
      )}

      {(scenarioA || scenarioB) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ScenarioSummary label="Scenario A" scenario={scenarioA || undefined} result={resultA} issue={issueA} updatedAt={recordA?.updatedAt} />
          <ScenarioSummary label="Scenario B" scenario={scenarioB || undefined} result={resultB} issue={issueB} updatedAt={recordB?.updatedAt} />
        </div>
      )}

      {resultA && resultB && comparison && (
        <div className="space-y-4">
          <BacktestComparisonKpis scenarioA={scenarioA!} scenarioB={scenarioB!} resultA={resultA} resultB={resultB} />
          <BacktestComparisonChart seriesData={comparison} labelA={scenarioA!.title || 'Scenario A'} labelB={scenarioB!.title || 'Scenario B'} />
        </div>
      )}
    </div>
  );
};
