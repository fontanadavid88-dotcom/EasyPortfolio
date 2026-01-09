export enum AssetType {
  Stock = 'Stock',
  ETF = 'ETF',
  Bond = 'Bond',
  Crypto = 'Crypto',
  Cash = 'Cash',
  Commodity = 'Commodity'
}

export enum Currency {
  CHF = 'CHF',
  EUR = 'EUR',
  USD = 'USD',
  GBP = 'GBP'
}

export enum TransactionType {
  Buy = 'Buy',
  Sell = 'Sell',
  Dividend = 'Dividend',
  Deposit = 'Deposit', // Cash in
  Withdrawal = 'Withdrawal', // Cash out
  Fee = 'Fee'
}

export interface Instrument {
  id?: number;
  ticker: string; // E.g., 'AAPL.US'
  name: string;
  type: AssetType;
  currency: Currency;
  sector?: string;
  region?: string;
  targetAllocation?: number; // Percentage 0-100
}

export interface Transaction {
  id?: number;
  date: Date;
  instrumentTicker?: string; // Null for pure Cash deposit/withdrawal
  type: TransactionType;
  quantity: number;
  price: number; // Unit price in instrument currency
  fees: number;
  currency: Currency;
  account: string; // e.g., 'IBKR', 'Degiro'
  note?: string;
}

export interface PricePoint {
  id?: number;
  ticker: string;
  date: string; // YYYY-MM-DD
  close: number;
  currency: Currency;
}

export interface MacroIndicator {
  id?: number;
  date: string;
  value: number; // 0-100
  note?: string;
  inputs?: Record<string, number>; // Stored raw inputs
}

export enum RebalanceStrategy {
  Accumulate = 'Accumulate', // Buy only
  Maintain = 'Maintain' // Sell high, buy low
}

export interface AppSettings {
  id?: number;
  baseCurrency: Currency;
  eodhdApiKey: string;
  googleSheetUrl: string;
}

// --- NEW ANALYTICS TYPES ---

export interface PortfolioPosition {
  ticker: string;
  name: string;
  assetType: AssetType;
  currency: Currency;
  quantity: number;
  currentPrice: number;
  currentValueCHF: number; // Unified base currency value (assuming CHF for simplicity or converted)
  targetPct: number;
  currentPct: number;
}

export interface PortfolioState {
  positions: PortfolioPosition[];
  totalValue: number;
  investedCapital: number;
  balance: number;
  balancePct: number;
}

export interface PerformancePoint {
  date: string;
  value: number;
  invested: number;
  monthlyReturnPct: number;
  cumulativeReturnPct: number;
}