import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deletePlan, duplicatePlan, listPlans, savePlan } from './rebalancePlanService';
import { db } from '../db';

vi.mock('../db', () => {
  const rebalancePlansTable = {
    where: vi.fn().mockReturnThis(),
    equals: vi.fn().mockReturnThis(),
    sortBy: vi.fn().mockResolvedValue([]),
    get: vi.fn(),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined)
  };
  return {
    db: {
      rebalancePlans: rebalancePlansTable
    }
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('rebalancePlanService', () => {
  it('savePlan stores and returns created plan', async () => {
    const plan = await savePlan({
      portfolioId: 'p1',
      baseCurrency: 'CHF',
      totalAmount: 1000,
      items: [],
      label: 'Plan 1'
    } as any);

    expect(plan.id).toBeTruthy();
    expect(plan.createdAt).toBeTypeOf('number');
    expect(db.rebalancePlans.put).toHaveBeenCalled();
  });

  it('listPlans returns plans for portfolio ordered desc', async () => {
    const table = db.rebalancePlans as any;
    table.sortBy.mockResolvedValueOnce([
      { id: 'a', createdAt: 1 },
      { id: 'b', createdAt: 2 }
    ]);
    const plans = await listPlans('p1');
    expect(db.rebalancePlans.where).toHaveBeenCalledWith('portfolioId');
    expect((db.rebalancePlans as any).equals).toHaveBeenCalledWith('p1');
    expect(plans.map(p => p.id)).toEqual(['b', 'a']);
  });

  it('deletePlan removes plan by id', async () => {
    await deletePlan('id-1');
    expect(db.rebalancePlans.delete).toHaveBeenCalledWith('id-1');
  });

  it('duplicatePlan creates a new plan with copied items', async () => {
    const basePlan = {
      id: 'base-1',
      portfolioId: 'p1',
      createdAt: 100,
      items: [],
      label: 'Plan Base'
    };
    (db.rebalancePlans.get as any).mockResolvedValueOnce(basePlan);
    const duplicated = await duplicatePlan('base-1');
    expect(db.rebalancePlans.get).toHaveBeenCalledWith('base-1');
    expect(db.rebalancePlans.put).toHaveBeenCalled();
    expect(duplicated.id).not.toBe(basePlan.id);
    expect(duplicated.label).toContain('copia');
  });
});
