import { db } from '../db';
import { BacktestScenarioRecord } from '../types';
import { BacktestScenarioInput } from './backtestTypes';

const nowIso = () => new Date().toISOString();

const buildScenarioRecord = (scenario: BacktestScenarioInput, portfolioId: string): BacktestScenarioRecord => {
  return {
    portfolioId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    title: scenario.title.trim(),
    startDate: scenario.startDate,
    endDate: scenario.endDate,
    initialCapital: scenario.initialCapital,
    periodicContributionAmount: scenario.periodicContributionAmount,
    contributionFrequency: scenario.contributionFrequency,
    rebalanceFrequency: scenario.rebalanceFrequency,
    baseCurrency: String(scenario.baseCurrency),
    assets: scenario.assets.map(asset => ({
      id: asset.id,
      source: asset.source,
      ticker: asset.ticker,
      name: asset.name,
      allocationPct: asset.allocationPct,
      assetClass: asset.assetClass,
      currency: asset.currency,
      importId: asset.importId
    }))
  };
};

export const createBacktestScenario = async (params: {
  scenario: BacktestScenarioInput;
  portfolioId: string;
}): Promise<number> => {
  const { scenario, portfolioId } = params;
  const record = buildScenarioRecord(scenario, portfolioId);
  const id = await db.backtestScenarios.add(record);
  return Number(id);
};

export const updateBacktestScenario = async (params: {
  id: number;
  scenario: BacktestScenarioInput;
  portfolioId: string;
}): Promise<void> => {
  const { id, scenario, portfolioId } = params;
  const updated: Partial<BacktestScenarioRecord> = {
    portfolioId,
    updatedAt: nowIso(),
    title: scenario.title.trim(),
    startDate: scenario.startDate,
    endDate: scenario.endDate,
    initialCapital: scenario.initialCapital,
    periodicContributionAmount: scenario.periodicContributionAmount,
    contributionFrequency: scenario.contributionFrequency,
    rebalanceFrequency: scenario.rebalanceFrequency,
    baseCurrency: String(scenario.baseCurrency),
    assets: scenario.assets.map(asset => ({
      id: asset.id,
      source: asset.source,
      ticker: asset.ticker,
      name: asset.name,
      allocationPct: asset.allocationPct,
      assetClass: asset.assetClass,
      currency: asset.currency,
      importId: asset.importId
    }))
  };
  await db.backtestScenarios.update(id, updated);
};

export const saveBacktestScenario = async (params: {
  id?: number | null;
  scenario: BacktestScenarioInput;
  portfolioId: string;
}): Promise<number> => {
  const { id, scenario, portfolioId } = params;
  if (id) {
    await updateBacktestScenario({ id, scenario, portfolioId });
    return id;
  }
  return createBacktestScenario({ scenario, portfolioId });
};

export const listBacktestScenarios = async (portfolioId: string): Promise<BacktestScenarioRecord[]> => {
  const rows = await db.backtestScenarios
    .where('portfolioId')
    .equals(portfolioId)
    .toArray();
  return rows.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
};

export const getBacktestScenarioById = async (id: number): Promise<BacktestScenarioRecord | undefined> => {
  return db.backtestScenarios.get(id);
};

export const duplicateBacktestScenario = async (id: number): Promise<number | null> => {
  const existing = await db.backtestScenarios.get(id);
  if (!existing) return null;
  const now = nowIso();
  const legacyAnnual = typeof existing.annualContribution === 'number' ? existing.annualContribution : 0;
  const periodicContributionAmount = typeof existing.periodicContributionAmount === 'number'
    ? existing.periodicContributionAmount
    : legacyAnnual;
  const contributionFrequency = existing.contributionFrequency
    ?? (legacyAnnual > 0 ? 'annual' : 'none');
  const record: BacktestScenarioRecord = {
    ...existing,
    id: undefined,
    createdAt: now,
    updatedAt: now,
    title: `${existing.title} (copia)`,
    periodicContributionAmount,
    contributionFrequency
  };
  const newId = await db.backtestScenarios.add(record);
  return Number(newId);
};

export const deleteBacktestScenario = async (id: number): Promise<void> => {
  await db.backtestScenarios.delete(id);
};
