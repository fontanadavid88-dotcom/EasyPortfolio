import { db } from '../db';
import { PricePoint, Instrument } from '../types';
import { differenceInDays, format, subDays, parseISO } from 'date-fns';
import Dexie from 'dexie';

interface PriceProvider {
  getLatestPrice(ticker: string): Promise<Partial<PricePoint> | null>;
  getHistory(ticker: string, from: string, to: string): Promise<PricePoint[]>;
}

// 1. EODHD Provider
class EodhdPriceProvider implements PriceProvider {
  private apiKey: string;
  private baseUrl = 'https://eodhd.com/api';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async getLatestPrice(ticker: string): Promise<Partial<PricePoint> | null> {
    if (!this.apiKey) return null;
    try {
      // For real implementation, use EODHD real-time or EOD endpoint
      const response = await fetch(`${this.baseUrl}/real-time/${ticker}?api_token=${this.apiKey}&fmt=json`);
      const data = await response.json();
      return {
        close: data.close,
        date: format(new Date(), 'yyyy-MM-dd')
      };
    } catch (e) {
      console.error('EODHD Latest Error', e);
      return null;
    }
  }

  async getHistory(ticker: string, from: string, to: string): Promise<PricePoint[]> {
    if (!this.apiKey) return [];
    try {
      const url = `${this.baseUrl}/eod/${ticker}?api_token=${this.apiKey}&from=${from}&to=${to}&fmt=json`;
      const res = await fetch(url);
      const data = await res.json();
      
      if (!Array.isArray(data)) return [];

      return data.map((d: any) => ({
        ticker,
        date: d.date,
        close: d.close,
        currency: 'USD' as any // API usually doesn't return currency in EOD, needs master data. Assuming basic mapping or user input.
      }));
    } catch (e) {
      console.error('EODHD History Error', e);
      return [];
    }
  }
}

// 2. Google Sheet Provider
class GoogleSheetsPriceProvider implements PriceProvider {
  private sheetUrl: string;

  constructor(sheetUrl: string) {
    this.sheetUrl = sheetUrl;
  }

  private async fetchSheetData(): Promise<any[]> {
    if (!this.sheetUrl) return [];
    try {
      // Using Google Viz API logic to parse JSONP-like response
      const res = await fetch(this.sheetUrl);
      const text = await res.text();
      // Remove "/*O_o*/ google.visualization.Query.setResponse(" and ");"
      const jsonText = text.substring(47).slice(0, -2);
      const json = JSON.parse(jsonText);
      
      // Parse columns: [A] TICKER, [B] CLOSE, [C] CURRENCY
      const rows = json.table.rows.map((r: any) => {
        return {
          ticker: r.c[0]?.v,
          close: r.c[1]?.v,
          currency: r.c[2]?.v
        };
      });
      return rows;
    } catch (e) {
      console.error('Sheet fetch error', e);
      return [];
    }
  }

  async getLatestPrice(ticker: string): Promise<Partial<PricePoint> | null> {
    const data = await this.fetchSheetData();
    const row = data.find(r => r.ticker === ticker);
    if (!row) return null;
    return {
      close: row.close,
      date: format(new Date(), 'yyyy-MM-dd'),
      currency: row.currency
    };
  }

  async getHistory(_ticker: string, _from: string, _to: string): Promise<PricePoint[]> {
    // Sheet is assumed to only have latest prices based on prompt description
    return [];
  }
}

// 3. Orchestrator
export const syncPrices = async () => {
  const settings = await db.settings.toCollection().first();
  if (!settings) return;

  const instruments = await db.instruments.toArray();
  const eodhd = new EodhdPriceProvider(settings.eodhdApiKey);
  const sheet = new GoogleSheetsPriceProvider(settings.googleSheetUrl);

  const today = format(new Date(), 'yyyy-MM-dd');

  for (const instr of instruments) {
    if (instr.type === 'Cash') continue;

    const lastPrice = await db.prices
      .where('[ticker+date]')
      .between([instr.ticker, Dexie.minKey], [instr.ticker, Dexie.maxKey])
      .last();

    let startDate = '2023-01-01';
    if (lastPrice) {
      startDate = format(new Date(lastPrice.date), 'yyyy-MM-dd');
    }

    // Don't fetch if up to date
    if (startDate === today) continue;

    // 1. Try EODHD History
    let newPoints = await eodhd.getHistory(instr.ticker, startDate, today);
    
    // 2. If EODHD fails or is empty, try Sheet for at least the latest price
    if (newPoints.length === 0) {
      const latest = await sheet.getLatestPrice(instr.ticker);
      if (latest && latest.close) {
        newPoints.push({
          ticker: instr.ticker,
          date: latest.date || today,
          close: latest.close,
          currency: (latest.currency as any) || instr.currency
        });
      }
    }

    // 3. Save to DB
    if (newPoints.length > 0) {
      // Ensure currency is set correctly from instrument if missing
      const pointsToSave = newPoints.map(p => ({
        ...p,
        currency: p.currency || instr.currency
      }));
      await db.prices.bulkPut(pointsToSave);
    }
  }
};