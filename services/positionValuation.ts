import { Currency, Instrument, PortfolioPosition, PricePoint } from '../types';
import { convertAmountFromSeries, FxRateRow } from './fxService';
import { getCanonicalTicker, getLatestPricePoint } from './financeUtils';

export type ValuationMeta = {
  priceCurrency: Currency;
  priceDate?: string;
  fxDate?: string;
  fxRateToChf?: number;
  valueLocal: number;
};

export type ValuedPosition = PortfolioPosition & {
  priceCurrency: Currency;
  unitPriceCHF?: number;
  priceDate?: string;
  fxDate?: string;
  fxRateToChf?: number;
  valueLocal: number;
};

export type ValuedPositionsResult = {
  positions: ValuedPosition[];
  totalValueCHF: number;
  valuationMeta: Map<string, ValuationMeta>;
  oldestFxDate: string;
};

export const computeCurrentValuedPositions = (params: {
  holdings: Map<string, number>;
  instruments: Instrument[];
  prices: PricePoint[];
  fxRates: FxRateRow[];
  valuationDate: string;
  baseCurrency?: Currency;
}): ValuedPositionsResult => {
  const {
    holdings,
    instruments,
    prices,
    fxRates,
    valuationDate,
    baseCurrency = Currency.CHF
  } = params;

  const uniqueInstruments = Array.from(
    new Map(instruments.map(inst => [inst.ticker, inst])).values()
  );
  const positions: ValuedPosition[] = [];
  const valuationMeta = new Map<string, ValuationMeta>();
  const fxDates: string[] = [];
  let totalValueCHF = 0;

  holdings.forEach((qty, ticker) => {
    if (qty <= 0.000001) return;
    const instr = uniqueInstruments.find(i => i.ticker === ticker);
    if (!instr) return;
    const priceTicker = getCanonicalTicker(instr) || instr.ticker;
    const pricePoint = getLatestPricePoint(priceTicker, valuationDate, prices);
    const price = pricePoint?.close || 0;
    const priceCurrency = (pricePoint?.currency || instr.currency || baseCurrency) as Currency;
    const valueLocal = qty * price;
    let fxRateToChf: number | undefined;
    let fxDate: string | undefined;
    let valueCHF = 0;
    let unitPriceCHF: number | undefined;

    if (priceCurrency === baseCurrency) {
      fxRateToChf = 1;
      fxDate = valuationDate;
      valueCHF = valueLocal;
      unitPriceCHF = price;
    } else {
      const converted = convertAmountFromSeries(valueLocal, priceCurrency, baseCurrency, valuationDate, fxRates);
      if (converted) {
        fxRateToChf = converted.lookup.rate;
        fxDate = converted.lookup.date;
        fxDates.push(converted.lookup.date);
        valueCHF = converted.value;
        unitPriceCHF = price * converted.lookup.rate;
      }
    }

    totalValueCHF += valueCHF;
    positions.push({
      ticker: instr.ticker,
      name: instr.name,
      assetType: instr.type,
      assetClass: instr.assetClass,
      currency: instr.currency || priceCurrency,
      quantity: qty,
      currentPrice: price,
      currentValueCHF: valueCHF,
      targetPct: instr.targetAllocation || 0,
      currentPct: 0,
      priceCurrency,
      unitPriceCHF,
      priceDate: pricePoint?.date,
      fxDate,
      fxRateToChf,
      valueLocal
    });

    valuationMeta.set(instr.ticker, {
      priceCurrency,
      priceDate: pricePoint?.date,
      fxDate,
      fxRateToChf,
      valueLocal
    });
  });

  positions.forEach(p => {
    p.currentPct = totalValueCHF > 0 ? (p.currentValueCHF / totalValueCHF) * 100 : 0;
  });

  const oldestFxDate = fxDates.length ? fxDates.sort()[0] : '';

  return { positions, totalValueCHF, valuationMeta, oldestFxDate };
};
