import { describe, it, expect } from 'vitest';
import { downsampleSeries } from './chartUtils';

describe('downsampleSeries', () => {
  it('preserves first and last points', () => {
    const data = Array.from({ length: 10 }, (_v, i) => ({ x: i }));
    const sampled = downsampleSeries(data, 5);
    expect(sampled.length).toBe(5);
    expect(sampled[0].x).toBe(0);
    expect(sampled[sampled.length - 1].x).toBe(9);
  });

  it('returns original when under max points', () => {
    const data = Array.from({ length: 3 }, (_v, i) => ({ x: i }));
    const sampled = downsampleSeries(data, 10);
    expect(sampled).toEqual(data);
  });
});
