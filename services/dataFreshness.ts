import { calculateHoldings, getCanonicalTicker } from './financeUtils';
import { diffDaysYmd } from './dateUtils';
import { Instrument, PricePoint, Transaction } from '../types';

export type HoldingPriceDateStats = {
  priceCommonAsOf?: string;
  priceLatestAsOf?: string;
  staleTickers: { ticker: string; canonical: string; lastDate: string; lagDays: number }[];
  missingTickers: { ticker: string; canonical: string }[];
};

export const computeHoldingsPriceDateStats = (
  transactions: Transaction[],
  instruments: Instrument[],
  prices: PricePoint[]
): HoldingPriceDateStats => {
  const holdings = calculateHoldings(transactions || []);
  const instrumentByTicker = new Map<string, Instrument>();
  (instruments || []).forEach(inst => {
    if (inst.ticker) instrumentByTicker.set(inst.ticker, inst);
  });

  const lastDateByTicker = new Map<string, string>();
  (prices || []).forEach(p => {
    if (!p?.ticker || !p?.date) return;
    const prev = lastDateByTicker.get(p.ticker);
    if (!prev || p.date > prev) lastDateByTicker.set(p.ticker, p.date);
  });

  const staleTickers: HoldingPriceDateStats['staleTickers'] = [];
  const missingTickers: HoldingPriceDateStats['missingTickers'] = [];
  const lastDates: { ticker: string; canonical: string; lastDate: string }[] = [];

  holdings.forEach((qty, ticker) => {
    if (!ticker || qty <= 0) return;
    const inst = instrumentByTicker.get(ticker);
    if (!inst) {
      missingTickers.push({ ticker, canonical: ticker });
      return;
    }
    const canonical = getCanonicalTicker(inst) || inst.ticker || ticker;
    const lastDate = lastDateByTicker.get(canonical) || lastDateByTicker.get(inst.ticker);
    if (!lastDate) {
      missingTickers.push({ ticker, canonical });
      return;
    }
    lastDates.push({ ticker, canonical, lastDate });
  });

  const priceLatestAsOf = lastDates.reduce<string | undefined>((max, cur) => {
    if (!max) return cur.lastDate;
    return cur.lastDate > max ? cur.lastDate : max;
  }, undefined);
  const priceCommonAsOf = lastDates.reduce<string | undefined>((min, cur) => {
    if (!min) return cur.lastDate;
    return cur.lastDate < min ? cur.lastDate : min;
  }, undefined);

  if (priceLatestAsOf) {
    lastDates.forEach(({ ticker, canonical, lastDate }) => {
      if (lastDate < priceLatestAsOf) {
        const lagDays = diffDaysYmd(priceLatestAsOf, lastDate);
        staleTickers.push({ ticker, canonical, lastDate, lagDays });
      }
    });
  }

  return {
    priceCommonAsOf,
    priceLatestAsOf,
    staleTickers,
    missingTickers
  };
};
