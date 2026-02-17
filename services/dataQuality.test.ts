import { describe, it, expect } from 'vitest';
import { analyzePriceSeries } from './dataQuality';
import { Currency } from '../types';

describe('analyzePriceSeries', () => {
  it('calculates gaps using calendar days', () => {
    const points = [
      { ticker: 'AAA', date: '2024-01-01', close: 10, currency: Currency.USD },
      { ticker: 'AAA', date: '2024-01-11', close: 11, currency: Currency.USD }
    ];
    const res = analyzePriceSeries(points, { gapDays: 7 });
    const gapIssue = res.issues.find(i => i.type === 'gap');
    expect(gapIssue).toBeTruthy();
    expect(gapIssue?.message).toContain('10');
  });
});
