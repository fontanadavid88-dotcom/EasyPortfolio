import { describe, it, expect } from 'vitest';
import { addDaysYmd, subDaysYmd, diffDaysYmd, isYmd } from './dateUtils';

describe('dateUtils', () => {
  it('adds/subtracts across month boundaries', () => {
    expect(addDaysYmd('2024-01-31', 1)).toBe('2024-02-01');
    expect(subDaysYmd('2024-03-01', 1)).toBe('2024-02-29');
  });

  it('diffDaysYmd is stable across DST boundaries', () => {
    expect(diffDaysYmd('2024-03-10', '2024-03-09')).toBe(1);
  });

  it('validates YMD format', () => {
    expect(isYmd('2024-12-31')).toBe(true);
    expect(isYmd('2024/12/31')).toBe(false);
  });
});
