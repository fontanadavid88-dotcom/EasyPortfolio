import Dexie, { Table } from 'dexie';
import { Instrument, Transaction, PricePoint, MacroIndicator, AppSettings, Currency, AssetType, TransactionType, AssetClass } from './types';
import { subDays, format } from 'date-fns';

export class PortfolioDB extends Dexie {
  instruments!: Table<Instrument>;
  transactions!: Table<Transaction>;
  prices!: Table<PricePoint>;
  macro!: Table<MacroIndicator>;
  settings!: Table<AppSettings>;
  portfolios!: Table<{ id?: number; portfolioId: string; name: string }>;
  instrumentListings!: Table<{ id?: number; isin: string; exchangeCode: string; symbol: string; currency: Currency; name?: string; portfolioId?: string }>;
  fxRates!: Table<{ id?: number; baseCurrency: Currency; quoteCurrency: Currency; date: string; rate: number; source?: string }>;

  constructor() {
    super('EasyPortfolioDB');
    (this as any).version(1).stores({
      instruments: '++id, ticker, type',
      transactions: '++id, date, instrumentTicker, type, account',
      prices: '++id, [ticker+date], date',
      macro: '++id, date',
      settings: '++id' // Singleton table
    });

    (this as any).version(2).stores({
      instruments: '++id, ticker, type, portfolioId',
      transactions: '++id, date, instrumentTicker, type, account, portfolioId',
      prices: '++id, [ticker+date], date, portfolioId',
      macro: '++id, date, portfolioId',
      settings: '++id, portfolioId',
      portfolios: '++id, portfolioId',
      instrumentListings: '++id, isin, exchangeCode, symbol, portfolioId',
      fxRates: '++id, [baseCurrency+quoteCurrency+date]'
    }).upgrade(tx => {
      const defaultId = 'default';
      tx.table('instruments').toCollection().modify((obj: any) => { obj.portfolioId = obj.portfolioId || defaultId; });
      tx.table('transactions').toCollection().modify((obj: any) => { obj.portfolioId = obj.portfolioId || defaultId; });
      tx.table('prices').toCollection().modify((obj: any) => { obj.portfolioId = obj.portfolioId || defaultId; });
      tx.table('macro').toCollection().modify((obj: any) => { obj.portfolioId = obj.portfolioId || defaultId; });
      tx.table('settings').toCollection().modify((obj: any) => { obj.portfolioId = obj.portfolioId || defaultId; });
    });
    // version bump if needed
    (this as any).version(3).stores({
      instruments: '++id, ticker, type, portfolioId, isin',
      transactions: '++id, date, instrumentTicker, type, account, portfolioId',
      prices: '++id, [ticker+date], date, portfolioId',
      macro: '++id, date, portfolioId',
      settings: '++id, portfolioId',
      portfolios: '++id, portfolioId',
      instrumentListings: '++id, isin, exchangeCode, symbol, portfolioId',
      fxRates: '++id, [baseCurrency+quoteCurrency+date]'
    }).upgrade(tx => {
      tx.table('settings').toCollection().modify((obj: any) => {
        obj.minHistoryDate = obj.minHistoryDate || '2020-01-01';
        obj.priceBackfillScope = obj.priceBackfillScope || 'current';
        obj.preferredExchangesOrder = obj.preferredExchangesOrder || ['SW','US','LSE','XETRA','MI','PA'];
      });
    });
    (this as any).version(4).stores({
      instruments: '++id, ticker, type, portfolioId, isin, assetClass',
      transactions: '++id, date, instrumentTicker, type, account, portfolioId',
      prices: '++id, [ticker+date], date, portfolioId',
      macro: '++id, date, portfolioId',
      settings: '++id, portfolioId',
      portfolios: '++id, portfolioId',
      instrumentListings: '++id, isin, exchangeCode, symbol, portfolioId',
      fxRates: '++id, [baseCurrency+quoteCurrency+date]'
    }).upgrade(tx => {
      tx.table('instruments').toCollection().modify((obj: any) => {
        if (!obj.assetClass) {
          if (obj.type === AssetType.Crypto) obj.assetClass = AssetClass.CRYPTO;
          else if (obj.type === AssetType.Cash) obj.assetClass = AssetClass.CASH;
          else if (obj.type === AssetType.Bond) obj.assetClass = AssetClass.BOND;
          else if (obj.type === AssetType.ETF) obj.assetClass = AssetClass.ETF_STOCK;
          else if (obj.type === AssetType.Stock) obj.assetClass = AssetClass.STOCK;
          else obj.assetClass = AssetClass.OTHER;
        }
      });
    });
    (this as any).version(5).stores({
      instruments: '++id, ticker, type, portfolioId, isin, assetClass, regionAllocation',
      transactions: '++id, date, instrumentTicker, type, account, portfolioId',
      prices: '++id, [ticker+date], date, portfolioId',
      macro: '++id, date, portfolioId',
      settings: '++id, portfolioId',
      portfolios: '++id, portfolioId',
      instrumentListings: '++id, isin, exchangeCode, symbol, portfolioId',
      fxRates: '++id, [baseCurrency+quoteCurrency+date]'
    }).upgrade(tx => {
      tx.table('instruments').toCollection().modify((obj: any) => {
        obj.regionAllocation = obj.regionAllocation || null;
      });
    });
  }
}

export const db = new PortfolioDB();

const CURRENT_PORTFOLIO_KEY = 'current_portfolio_id';
export const getCurrentPortfolioId = (): string => {
  if (typeof localStorage === 'undefined') return 'default';
  return localStorage.getItem(CURRENT_PORTFOLIO_KEY) || 'default';
};
export const setCurrentPortfolioId = (id: string) => {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(CURRENT_PORTFOLIO_KEY, id);
};

// Helper to init settings if missing
export const initSettings = async () => {
  const portfolioId = getCurrentPortfolioId();
  const count = await db.settings.where('portfolioId').equals(portfolioId).count();
  if (count === 0) {
    console.log('[DB] settings empty, creating defaults');
    // Safely access environment variables
    // Check if import.meta exists to prevent runtime errors
    // Casting to any to avoid TS error if types are not fully configured
    const env = (typeof import.meta !== 'undefined' && (import.meta as any).env) ? (import.meta as any).env : {};
    
    await db.settings.add({
      baseCurrency: Currency.CHF,
      eodhdApiKey: env.VITE_EODHD_API_KEY || '',
      googleSheetUrl: env.VITE_PRICE_SHEET_URL || '',
      portfolioId
    });
  } else {
    console.log('[DB] settings already present');
  }
};

// Seed Database with Dummy Data
export const seedDatabase = async () => {
  try {
    const portfolioId = getCurrentPortfolioId();
    const count = await db.instruments.where('portfolioId').equals(portfolioId).count();
    if (count > 0) {
      console.log('[DB] instruments already seeded');
      return; // Already seeded
    }

    console.log('Seeding database with demo data...');

    // 1. Add Instruments
    await db.instruments.bulkAdd([
      { ticker: 'AAPL.US', name: 'Apple Inc.', type: AssetType.Stock, assetClass: AssetClass.STOCK, currency: Currency.USD, targetAllocation: 20, portfolioId },
      { ticker: 'VWRL.AS', name: 'Vanguard All-World ETF', type: AssetType.ETF, assetClass: AssetClass.ETF_STOCK, currency: Currency.EUR, targetAllocation: 70, portfolioId },
      { ticker: 'BTC-USD', name: 'Bitcoin', type: AssetType.Crypto, assetClass: AssetClass.CRYPTO, currency: Currency.USD, targetAllocation: 10, portfolioId }
    ]);

    // 2. Add Transactions
    const today = new Date();
    await db.transactions.bulkAdd([
      {
        date: subDays(today, 300),
        type: TransactionType.Buy,
        instrumentTicker: 'VWRL.AS',
        quantity: 50,
        price: 95.50,
        fees: 5,
        currency: Currency.EUR,
        account: 'Degiro',
        portfolioId
      },
      {
        date: subDays(today, 150),
        type: TransactionType.Buy,
        instrumentTicker: 'AAPL.US',
        quantity: 10,
        price: 150.00,
        fees: 2,
        currency: Currency.USD,
        account: 'IBKR',
        portfolioId
      },
      {
        date: subDays(today, 30),
        type: TransactionType.Buy,
        instrumentTicker: 'BTC-USD',
        quantity: 0.05,
        price: 42000,
        fees: 10,
        currency: Currency.USD,
        account: 'Ledger',
        portfolioId
      }
    ]);

    // 3. Generate Historical Prices (Mock Data)
    const priceData: PricePoint[] = [];
    const tickers = [
      { t: 'AAPL.US', base: 150, vol: 2, curr: Currency.USD },
      { t: 'VWRL.AS', base: 95, vol: 1, curr: Currency.EUR },
      { t: 'BTC-USD', base: 40000, vol: 1000, curr: Currency.USD }
    ];

    for (let i = 365; i >= 0; i--) {
      const d = subDays(today, i);
      const dateStr = format(d, 'yyyy-MM-dd');
      
      tickers.forEach(tk => {
        // Random Walk
        const change = (Math.random() - 0.5) * tk.vol;
        tk.base += change;
        if (tk.base < 0) tk.base = 0.1;

        priceData.push({
          ticker: tk.t,
          date: dateStr,
          close: parseFloat(tk.base.toFixed(2)),
          currency: tk.curr,
          portfolioId
        });
      });
    }

    await db.prices.bulkAdd(priceData);

    // 4. Add Macro Indicator default
    await db.macro.add({
      date: new Date().toISOString(),
      value: 65, // Neutral/Positive
      note: 'Initial Seed',
      portfolioId
    });

    console.log('Database seeded successfully.');
    // No reload needed, Dexie hooks will update the UI
  } catch (error) {
    console.error('Error seeding database:', error);
  }
};

export const ensureDefaultPortfolio = async () => {
  const count = await db.portfolios.count();
  if (count === 0) {
    await db.portfolios.add({ portfolioId: 'default', name: 'Portafoglio Principale' });
    setCurrentPortfolioId('default');
  }
};
