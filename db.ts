import Dexie, { Table } from 'dexie';
import { Instrument, Transaction, PricePoint, MacroIndicator, AppSettings, Currency, AssetType, TransactionType } from './types';
import { subDays, format } from 'date-fns';

export class PortfolioDB extends Dexie {
  instruments!: Table<Instrument>;
  transactions!: Table<Transaction>;
  prices!: Table<PricePoint>;
  macro!: Table<MacroIndicator>;
  settings!: Table<AppSettings>;

  constructor() {
    super('EasyPortfolioDB');
    (this as any).version(1).stores({
      instruments: '++id, ticker, type',
      transactions: '++id, date, instrumentTicker, type, account',
      prices: '++id, [ticker+date], date',
      macro: '++id, date',
      settings: '++id' // Singleton table
    });
  }
}

export const db = new PortfolioDB();

// Helper to init settings if missing
export const initSettings = async () => {
  const count = await db.settings.count();
  if (count === 0) {
    // Safely access environment variables
    // Check if import.meta exists to prevent runtime errors
    // Casting to any to avoid TS error if types are not fully configured
    const env = (typeof import.meta !== 'undefined' && (import.meta as any).env) ? (import.meta as any).env : {};
    
    await db.settings.add({
      baseCurrency: Currency.CHF,
      eodhdApiKey: env.VITE_EODHD_API_KEY || '',
      googleSheetUrl: env.VITE_PRICE_SHEET_URL || ''
    });
  }
};

// Seed Database with Dummy Data
export const seedDatabase = async () => {
  try {
    const count = await db.instruments.count();
    if (count > 0) return; // Already seeded

    console.log('Seeding database with demo data...');

    // 1. Add Instruments
    await db.instruments.bulkAdd([
      { ticker: 'AAPL.US', name: 'Apple Inc.', type: AssetType.Stock, currency: Currency.USD, targetAllocation: 20 },
      { ticker: 'VWRL.AS', name: 'Vanguard All-World ETF', type: AssetType.ETF, currency: Currency.EUR, targetAllocation: 70 },
      { ticker: 'BTC-USD', name: 'Bitcoin', type: AssetType.Crypto, currency: Currency.USD, targetAllocation: 10 }
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
        account: 'Degiro'
      },
      {
        date: subDays(today, 150),
        type: TransactionType.Buy,
        instrumentTicker: 'AAPL.US',
        quantity: 10,
        price: 150.00,
        fees: 2,
        currency: Currency.USD,
        account: 'IBKR'
      },
      {
        date: subDays(today, 30),
        type: TransactionType.Buy,
        instrumentTicker: 'BTC-USD',
        quantity: 0.05,
        price: 42000,
        fees: 10,
        currency: Currency.USD,
        account: 'Ledger'
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
          currency: tk.curr
        });
      });
    }

    await db.prices.bulkAdd(priceData);

    // 4. Add Macro Indicator default
    await db.macro.add({
      date: new Date().toISOString(),
      value: 65, // Neutral/Positive
      note: 'Initial Seed'
    });

    console.log('Database seeded successfully.');
    // No reload needed, Dexie hooks will update the UI
  } catch (error) {
    console.error('Error seeding database:', error);
  }
};