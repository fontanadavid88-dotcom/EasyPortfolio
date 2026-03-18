import { db } from '../db';
import { RebalancePlan } from '../types';
import { createUuid } from './idUtils';

export const savePlan = async (plan: Omit<RebalancePlan, 'id' | 'createdAt'>): Promise<RebalancePlan> => {
  const entry: RebalancePlan = {
    ...plan,
    id: createUuid(),
    createdAt: Date.now()
  };
  await db.rebalancePlans.put(entry);
  return entry;
};

export const listPlans = async (portfolioId: string): Promise<RebalancePlan[]> => {
  const rows = await db.rebalancePlans.where('portfolioId').equals(portfolioId).sortBy('createdAt');
  return rows.reverse();
};

export const getPlan = async (id: string): Promise<RebalancePlan | undefined> => {
  return db.rebalancePlans.get(id);
};

export const deletePlan = async (id: string): Promise<void> => {
  await db.rebalancePlans.delete(id);
};

export const duplicatePlan = async (id: string): Promise<RebalancePlan> => {
  const existing = await db.rebalancePlans.get(id);
  if (!existing) {
    throw new Error('plan_not_found');
  }
  const baseLabel = existing.label ? `${existing.label} (copia)` : `Rebalance ${new Date().toISOString().slice(0, 10)}`;
  const duplicated: RebalancePlan = {
    ...existing,
    id: createUuid(),
    createdAt: Date.now(),
    label: baseLabel
  };
  await db.rebalancePlans.put(duplicated);
  return duplicated;
};
