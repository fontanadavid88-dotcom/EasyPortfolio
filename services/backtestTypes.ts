import { Currency, BacktestAssetClass } from '../types';

export type BacktestAssetSource = 'APP_DB' | 'CSV_IMPORT';

export type BacktestAssetInput = {
  id: string;
  source: BacktestAssetSource;
  ticker: string;
  name: string;
  allocationPct: number;
  assetClass: BacktestAssetClass;
  currency: string;
  importId?: number;
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
  assetId: string;
  ticker: string;
  source: BacktestAssetSource;
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
  byAssetId: Record<string, BacktestAssetQuality>;
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

export type BacktestSourceSeriesPoint = {
  assetId: string;
  date: string;
  close: number;
  currency: Currency;
  source: BacktestAssetSource;
  ticker: string;
  importId?: number;
};

export type BacktestScenarioData = {
  key: string;
  series: BacktestSourceSeriesPoint[];
  fxRates: Array<{ baseCurrency: Currency; quoteCurrency: Currency; date: string; rate: number; source?: string }>;
  quality: BacktestDataQualitySummary;
};
