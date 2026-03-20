import { Currency } from '../types';

export type BacktestAssetClass = 'Equity' | 'Bond' | 'Gold' | 'Crypto' | 'Cash' | 'Other';

export type BacktestAssetInput = {
  ticker: string;
  name: string;
  allocationPct: number;
  assetClass: BacktestAssetClass;
  currency?: Currency;
  source: 'DB';
  priceSource?: 'DB' | 'CSV';
};

export type BacktestScenarioInput = {
  title: string;
  startDate: string;
  endDate: string;
  initialCapital: number;
  annualContribution: number;
  rebalanceFrequency: 'none' | 'annual';
  baseCurrency: Currency;
  assets: BacktestAssetInput[];
};

export type BacktestResult = {
  effectiveStartDate?: string;
  effectiveEndDate?: string;
  navSeries: Array<{ date: string; nav: number; contributionCumulative?: number; drawdown?: number }>;
  annualReturns: Array<{ year: string; value: number }>;
  summary: {
    initialCapital: number;
    totalContributions: number;
    finalValue: number;
    totalReturnPct: number;
    cagr?: number;
    volatility?: number;
    maxDrawdown?: number;
    sharpe?: number;
    bestYear?: number;
    worstYear?: number;
  };
  warnings: string[];
  errors?: string[];
};

export type BacktestAssetQualityStatus = 'OK' | 'PARTIAL' | 'MISSING' | 'FX_MISSING';

export type BacktestAssetQuality = {
  ticker: string;
  status: BacktestAssetQualityStatus;
  priceStart?: string;
  priceEnd?: string;
  priceCount?: number;
  currency?: Currency;
  message?: string;
};

export type BacktestDataQualitySummary = {
  total: number;
  ok: number;
  partial: number;
  missing: number;
  fxMissing: number;
  messages: string[];
  blockingIssues: string[];
  byTicker: Record<string, BacktestAssetQuality>;
  requestedStartDate?: string;
  requestedEndDate?: string;
  availableStartDate?: string;
  availableEndDate?: string;
  effectiveStartDate?: string;
  effectiveEndDate?: string;
  canRun: boolean;
  blockingReason?: string;
  warningMessage?: string;
  status?: 'full' | 'partial-runnable' | 'partial-blocking' | 'missing';
};

export type BacktestScenarioData = {
  key: string;
  prices: Array<{ ticker: string; date: string; close: number; currency: Currency; portfolioId?: string }>;
  fxRates: Array<{ baseCurrency: Currency; quoteCurrency: Currency; date: string; rate: number; source?: string }>;
  quality: BacktestDataQualitySummary;
};
