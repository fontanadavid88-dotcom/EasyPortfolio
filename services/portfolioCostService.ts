import { Currency, Instrument, PortfolioPosition, Transaction, TransactionType } from '../types';
import { convertAmountFromSeries, FxRateRow } from './fxService';
import { isYmd } from './dateUtils';

export type CostPosition = Pick<PortfolioPosition, 'ticker' | 'currentValueCHF' | 'quantity'> & {
  currentValueBase?: number;
};

export type PortfolioCostMetricsArgs = {
  transactions: Transaction[];
  instruments: Instrument[];
  positions: CostPosition[];
  fxRates: FxRateRow[];
  rangeStartDate?: string;
  rangeEndDate?: string;
  baseCurrency: Currency;
  ytdStartDate?: string;
};

export type PortfolioCostMetrics = {
  weightedTerPct: number;
  annualTerCostBase: number;
  terCoveragePct: number;
  coveredValueBase: number;
  uncoveredValueBase: number;
  transactionFeesAllTimeBase: number;
  transactionFeesYtdBase: number;
  transactionFeesRangeBase: number;
  missingFxCount: number;
  missingTerTickers: string[];
};

const toDateString = (value: Date | string | number): string => {
  if (typeof value === 'string' && isYmd(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
};

const hasKnownTer = (value: unknown): value is number => {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
};

const getPositionValueBase = (position: CostPosition): number => {
  const value = position.currentValueBase ?? position.currentValueCHF;
  return Number.isFinite(value) ? value : 0;
};

const getFeeAmount = (transaction: Transaction): number => {
  if (transaction.type === TransactionType.Buy || transaction.type === TransactionType.Sell) {
    return Number(transaction.fees || 0);
  }
  if (transaction.type === TransactionType.Fee) {
    return Number(transaction.fees || transaction.quantity || 0);
  }
  return 0;
};

const buildInstrumentLookup = (instruments: Instrument[]): Map<string, Instrument> => {
  const map = new Map<string, Instrument>();
  instruments.forEach(instrument => {
    if (instrument.ticker) map.set(instrument.ticker, instrument);
    if (instrument.symbol) map.set(instrument.symbol, instrument);
    if (instrument.preferredListing?.symbol) map.set(instrument.preferredListing.symbol, instrument);
    instrument.listings?.forEach(listing => {
      if (listing?.symbol) map.set(listing.symbol, instrument);
    });
  });
  return map;
};

export const computePortfolioCostMetrics = ({
  transactions,
  instruments,
  positions,
  fxRates,
  rangeStartDate,
  rangeEndDate,
  baseCurrency,
  ytdStartDate
}: PortfolioCostMetricsArgs): PortfolioCostMetrics => {
  const instrumentByTicker = buildInstrumentLookup(instruments);
  const currentPositions = positions.filter(position => position.quantity > 0.000001 && getPositionValueBase(position) > 0);
  const portfolioValueBase = currentPositions.reduce((sum, position) => sum + getPositionValueBase(position), 0);

  let weightedTerPct = 0;
  let annualTerCostBase = 0;
  let coveredValueBase = 0;
  const missingTer = new Set<string>();

  currentPositions.forEach(position => {
    const valueBase = getPositionValueBase(position);
    const instrument = instrumentByTicker.get(position.ticker);
    const terPct = instrument?.terPct;
    if (!hasKnownTer(terPct)) {
      missingTer.add(position.ticker);
      return;
    }
    const weight = portfolioValueBase > 0 ? valueBase / portfolioValueBase : 0;
    weightedTerPct += weight * terPct;
    annualTerCostBase += valueBase * (terPct / 100);
    coveredValueBase += valueBase;
  });

  const uncoveredValueBase = Math.max(0, portfolioValueBase - coveredValueBase);
  const terCoveragePct = portfolioValueBase > 0 ? (coveredValueBase / portfolioValueBase) * 100 : 0;
  const effectiveRangeEnd = rangeEndDate || '9999-12-31';
  const effectiveYtdStart = ytdStartDate || (effectiveRangeEnd.slice(0, 4) ? `${effectiveRangeEnd.slice(0, 4)}-01-01` : '');

  let transactionFeesAllTimeBase = 0;
  let transactionFeesYtdBase = 0;
  let transactionFeesRangeBase = 0;
  let missingFxCount = 0;

  transactions.forEach(transaction => {
    const rawFee = getFeeAmount(transaction);
    if (!Number.isFinite(rawFee) || rawFee <= 0) return;
    const date = toDateString(transaction.date);
    if (!date) return;
    const converted = convertAmountFromSeries(rawFee, transaction.currency, baseCurrency, date, fxRates);
    if (!converted) {
      missingFxCount += 1;
      return;
    }

    transactionFeesAllTimeBase += converted.value;
    if (effectiveYtdStart && date >= effectiveYtdStart && date <= effectiveRangeEnd) {
      transactionFeesYtdBase += converted.value;
    }
    if ((!rangeStartDate || date >= rangeStartDate) && (!rangeEndDate || date <= rangeEndDate)) {
      transactionFeesRangeBase += converted.value;
    }
  });

  return {
    weightedTerPct,
    annualTerCostBase,
    terCoveragePct,
    coveredValueBase,
    uncoveredValueBase,
    transactionFeesAllTimeBase,
    transactionFeesYtdBase,
    transactionFeesRangeBase,
    missingFxCount,
    missingTerTickers: Array.from(missingTer).sort()
  };
};
