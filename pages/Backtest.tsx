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

export const Backtest: React.FC = () => {
  const portfolioId = getCurrentPortfolioId();
  const settings = useLiveQuery(() => db.settings.where('portfolioId').equals(portfolioId).first(), [portfolioId]);
  const instruments = useLiveQuery(() => db.instruments.where('portfolioId').equals(portfolioId).toArray(), [portfolioId], []);

  const [mode, setMode] = useState<'builder' | 'results'>('builder');
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [scenarioData, setScenarioData] = useState<Awaited<ReturnType<typeof loadBacktestScenarioData>> | null>(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [runLoading, setRunLoading] = useState(false);

  const defaultStart = useMemo(() => format(subDays(new Date(), 365), 'yyyy-MM-dd'), []);
  const defaultEnd = useMemo(() => format(new Date(), 'yyyy-MM-dd'), []);

  const [scenario, setScenario] = useState<BacktestScenarioInput>(() => ({
    title: 'Backtest modello',
    startDate: defaultStart,
    endDate: defaultEnd,
    initialCapital: 10000,
    annualContribution: 0,
    rebalanceFrequency: 'none',
    baseCurrency: Currency.CHF,
    assets: []
  }));

  useEffect(() => {
    if (!settings?.baseCurrency) return;
    if (scenario.baseCurrency !== settings.baseCurrency) {
      setScenario(prev => ({ ...prev, baseCurrency: settings.baseCurrency }));
    }
  }, [settings, scenario.baseCurrency]);

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
        <BacktestBuilder
          scenario={scenario}
          instruments={instruments || []}
          quality={scenarioData?.quality || null}
          qualityLoading={dataLoading}
          onScenarioChange={setScenario}
          onRun={handleRun}
          isRunning={runLoading}
        />
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
