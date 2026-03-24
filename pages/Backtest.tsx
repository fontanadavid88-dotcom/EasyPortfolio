import React, { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { subDays, format } from 'date-fns';
import { db, getCurrentPortfolioId } from '../db';
import { Currency } from '../types';
import { BacktestScenarioInput, BacktestResult } from '../services/backtestTypes';
import { BacktestBuilder } from '../components/backtest/BacktestBuilder';
import { BacktestResults } from '../components/backtest/BacktestResults';
import { buildBacktestScenarioDataKey, loadBacktestScenarioData } from '../services/backtestDataSource';
import { runBacktest } from '../services/backtestEngine';
import { listBacktestImports } from '../services/backtestImportRepository';
import { BacktestScenarioList } from '../components/backtest/BacktestScenarioList';
import { createBacktestScenario, deleteBacktestScenario, duplicateBacktestScenario, getBacktestScenarioById, listBacktestScenarios, saveBacktestScenario } from '../services/backtestScenarioRepository';

export const Backtest: React.FC = () => {
  const portfolioId = getCurrentPortfolioId();
  const settings = useLiveQuery(() => db.settings.where('portfolioId').equals(portfolioId).first(), [portfolioId]);
  const instruments = useLiveQuery(() => db.instruments.where('portfolioId').equals(portfolioId).toArray(), [portfolioId], []);
  const imports = useLiveQuery(() => listBacktestImports(portfolioId), [portfolioId], []);
  const scenarios = useLiveQuery(() => listBacktestScenarios(portfolioId), [portfolioId], []);

  const [mode, setMode] = useState<'builder' | 'results'>('builder');
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [scenarioData, setScenarioData] = useState<Awaited<ReturnType<typeof loadBacktestScenarioData>> | null>(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [runLoading, setRunLoading] = useState(false);
  const [currentScenarioId, setCurrentScenarioId] = useState<number | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  const defaultStart = useMemo(() => format(subDays(new Date(), 365), 'yyyy-MM-dd'), []);
  const defaultEnd = useMemo(() => format(new Date(), 'yyyy-MM-dd'), []);

  const buildDefaultScenario = (baseCurrency: Currency): BacktestScenarioInput => ({
    title: 'Backtest modello',
    startDate: defaultStart,
    endDate: defaultEnd,
    initialCapital: 10000,
    annualContribution: 0,
    rebalanceFrequency: 'none',
    baseCurrency,
    assets: []
  });

  const [scenario, setScenario] = useState<BacktestScenarioInput>(() => buildDefaultScenario(Currency.CHF));

  useEffect(() => {
    if (!settings?.baseCurrency) return;
    if (scenario.baseCurrency !== settings.baseCurrency) {
      setScenario(prev => ({ ...prev, baseCurrency: settings.baseCurrency }));
    }
  }, [settings, scenario.baseCurrency]);

  const scenarioSnapshot = useMemo(() => JSON.stringify(scenario), [scenario]);
  const isDirty = useMemo(() => (savedSnapshot ? scenarioSnapshot !== savedSnapshot : false), [scenarioSnapshot, savedSnapshot]);
  const scenarioStateLabel = useMemo(() => {
    if (currentScenarioId) return isDirty ? 'Modifiche non salvate' : 'Scenario salvato';
    return 'Nuovo scenario';
  }, [currentScenarioId, isDirty]);

  const missingCsvImports = useMemo(() => {
    const importIds = new Set((imports || []).map(item => item.id));
    return scenario.assets
      .filter(asset => asset.source === 'CSV_IMPORT' && asset.importId && !importIds.has(asset.importId))
      .map(asset => asset.ticker);
  }, [scenario.assets, imports]);

  const applyScenarioRecord = (record: { id?: number; title: string; startDate: string; endDate: string; initialCapital: number; annualContribution: number; rebalanceFrequency: 'none' | 'annual'; baseCurrency: string; assets: BacktestScenarioInput['assets'] }) => {
    const nextScenario: BacktestScenarioInput = {
      title: record.title,
      startDate: record.startDate,
      endDate: record.endDate,
      initialCapital: record.initialCapital,
      annualContribution: record.annualContribution,
      rebalanceFrequency: record.rebalanceFrequency,
      baseCurrency: (record.baseCurrency as Currency) || scenario.baseCurrency,
      assets: record.assets || []
    };
    setScenario(nextScenario);
    setCurrentScenarioId(record.id ?? null);
    setSavedSnapshot(JSON.stringify(nextScenario));
    setMode('builder');
    setResult(null);
  };

  const handleNewScenario = () => {
    const base = settings?.baseCurrency || scenario.baseCurrency || Currency.CHF;
    const next = buildDefaultScenario(base as Currency);
    setScenario(next);
    setCurrentScenarioId(null);
    setSavedSnapshot(null);
    setMode('builder');
    setResult(null);
  };

  const handleSaveScenario = async () => {
    const id = await saveBacktestScenario({ id: currentScenarioId, scenario, portfolioId });
    setCurrentScenarioId(id);
    setSavedSnapshot(scenarioSnapshot);
    setSaveNotice(currentScenarioId ? 'Scenario aggiornato' : 'Scenario salvato');
    setTimeout(() => setSaveNotice(null), 2000);
  };

  const handleDuplicateScenario = async (id?: number) => {
    const sourceId = id ?? currentScenarioId ?? undefined;
    if (sourceId) {
      const newId = await duplicateBacktestScenario(sourceId);
      if (newId) {
        const record = await getBacktestScenarioById(newId);
        if (record) applyScenarioRecord(record);
      }
      setSaveNotice('Scenario duplicato');
      setTimeout(() => setSaveNotice(null), 2000);
      return;
    }
    const title = scenario.title ? `${scenario.title} (copia)` : 'Scenario (copia)';
    const copyScenario: BacktestScenarioInput = { ...scenario, title };
    const newId = await createBacktestScenario({ scenario: copyScenario, portfolioId });
    setScenario(copyScenario);
    setCurrentScenarioId(newId);
    setSavedSnapshot(JSON.stringify(copyScenario));
    setMode('builder');
    setSaveNotice('Scenario duplicato');
    setTimeout(() => setSaveNotice(null), 2000);
  };

  const handleOpenScenario = async (id: number) => {
    const record = await getBacktestScenarioById(id);
    if (record) applyScenarioRecord(record);
  };

  const handleDeleteScenario = async (id?: number) => {
    const targetId = id ?? currentScenarioId;
    if (!targetId) return;
    const ok = window.confirm('Eliminare lo scenario selezionato?');
    if (!ok) return;
    await deleteBacktestScenario(targetId);
    if (targetId === currentScenarioId) {
      handleNewScenario();
    }
  };

  const scenarioDataKey = useMemo(() => buildBacktestScenarioDataKey(scenario), [scenario]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!scenario.assets.length || !scenario.startDate || !scenario.endDate) {
        setScenarioData(null);
        return;
      }
      setDataLoading(true);
      const data = await loadBacktestScenarioData(scenario, portfolioId);
      if (cancelled) return;
      setScenarioData(data);
      setDataLoading(false);
    };
    load();
    return () => { cancelled = true; };
  }, [scenarioDataKey, portfolioId]);

  const handleRun = async () => {
    setRunLoading(true);
    const data = scenarioData && scenarioData.key === scenarioDataKey
      ? scenarioData
      : await loadBacktestScenarioData(scenario, portfolioId);
    setScenarioData(data);
    const backtestResult = runBacktest(scenario, data);
    setResult(backtestResult);
    setMode('results');
    setRunLoading(false);
  };

  const handleBack = () => {
    setMode('builder');
  };

  return (
    <div>
      {mode === 'builder' && (
        <div className="space-y-6">
          <BacktestScenarioList
            scenarios={scenarios || []}
            currentScenarioId={currentScenarioId}
            onOpen={handleOpenScenario}
            onDuplicate={handleDuplicateScenario}
            onDelete={handleDeleteScenario}
          />
          <BacktestBuilder
            scenario={scenario}
            instruments={instruments || []}
            imports={imports || []}
            portfolioId={portfolioId}
            quality={scenarioData?.quality || null}
            qualityLoading={dataLoading}
            currentScenarioId={currentScenarioId}
            scenarioStateLabel={scenarioStateLabel}
            isDirty={isDirty}
            saveNotice={saveNotice}
            missingCsvImports={missingCsvImports}
            onScenarioChange={setScenario}
            onRun={handleRun}
            isRunning={runLoading}
            onSaveScenario={handleSaveScenario}
            onDuplicateScenario={handleDuplicateScenario}
            onNewScenario={handleNewScenario}
            onDeleteScenario={() => handleDeleteScenario()}
          />
        </div>
      )}
      {mode === 'results' && result && (
        <BacktestResults
          scenario={scenario}
          result={result}
          onBack={handleBack}
        />
      )}
    </div>
  );
};
