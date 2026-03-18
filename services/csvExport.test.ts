import { describe, expect, it } from 'vitest';
import { buildRebalancePlanCsv } from './csvExport';
import { RebalancePlan } from '../types';

describe('csvExport', () => {
  it('buildRebalancePlanCsv includes header and only actionable rows', () => {
    const plan: RebalancePlan = {
      id: 'p1',
      portfolioId: 'port-1',
      createdAt: Date.parse('2026-02-20T10:00:00.000Z'),
      valuationDate: '2026-02-18',
      baseCurrency: 'CHF',
      items: [
        { ticker: 'AAA', action: 'COMPRA', amountBase: 1000, units: 10, instrumentCurrency: 'CHF', price: 100, priceCurrency: 'CHF' },
        { ticker: 'BBB', action: 'VENDI', amountBase: 500, units: 5, instrumentCurrency: 'USD', price: 50, priceCurrency: 'USD', reason: 'note, with comma' },
        { ticker: 'CCC', action: 'NEUTRO', amountBase: 0 }
      ],
      label: 'Plan'
    };

    const csv = buildRebalancePlanCsv(plan);
    const lines = csv.split('\n');
    expect(lines[0]).toContain('CreatedAt,ValuationDate,PortfolioId,Ticker,Action,AmountCHF,Units,InstrumentCurrency,Price,PriceCurrency,Note');
    expect(lines.length).toBe(3); // header + 2 rows
    expect(lines[1]).toContain('AAA');
    expect(lines[2]).toContain('BBB');
    expect(lines[2]).toContain('"note, with comma"');
  });
});
