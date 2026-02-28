import { Currency, FxRate } from '../types';
import { convertAmountFromSeries } from './fxService';

export type RebalanceUnitsResult = { units?: number; reason?: 'missing_price' | 'missing_fx' | 'currency_mismatch' | 'invalid' };

export const computeRebalanceUnits = (params: {
  deltaBase: number;
  baseCurrency: Currency;
  instrumentCurrency: Currency;
  price: number;
  priceCurrency: Currency;
  fxRates: FxRate[];
  valuationDate: string;
}): RebalanceUnitsResult => {
  const { deltaBase, baseCurrency, instrumentCurrency, price, priceCurrency, fxRates, valuationDate } = params;
  if (!Number.isFinite(deltaBase)) return { reason: 'invalid' };
  if (!Number.isFinite(price) || price <= 0) return { reason: 'missing_price' };
  if (priceCurrency !== instrumentCurrency) return { reason: 'currency_mismatch' };

  let deltaInPriceCurrency = deltaBase;
  if (baseCurrency !== priceCurrency) {
    const converted = convertAmountFromSeries(deltaBase, baseCurrency, priceCurrency, valuationDate, fxRates);
    if (!converted) return { reason: 'missing_fx' };
    deltaInPriceCurrency = converted.value;
  }
  if (!Number.isFinite(deltaInPriceCurrency)) return { reason: 'invalid' };
  return { units: deltaInPriceCurrency / price };
};
