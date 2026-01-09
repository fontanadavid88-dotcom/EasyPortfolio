import { db, getCurrentPortfolioId } from '../db';
import { Instrument, PricePoint, TransactionType } from '../types';
import { format, subDays, addDays, differenceInCalendarDays } from 'date-fns';
import Dexie from 'dexie';

interface PriceProvider {
  getLatestPrice(ticker: string): Promise<Partial<PricePoint> | null>;
  getHistory(ticker: string, from: string, to: string): Promise<PricePoint[]>;
}

export interface CoverageRow {
  ticker: string;
  isin?: string | null;
  name?: string | null;
  instrumentId?: string | number;
  from: string;
  to: string;
  status: 'OK' | 'INCOMPLETO' | 'PARZIALE';
}

const resolveInstrumentForTicker = (instruments: Instrument[], ticker: string): Instrument | undefined => {
  return instruments.find(i => i.preferredListing?.symbol === ticker)
    || instruments.find(i => i.ticker === ticker)
    || instruments.find(i => i.listings?.some(l => l.symbol === ticker));
};

export const buildCoverageRows = (
  tickers: string[],
  ranges: Record<string, { firstDate?: string; lastDate?: string }>,
  instruments: Instrument[],
  minHistoryDate: string,
  today: string
): CoverageRow[] => {
  return tickers.map((rawTicker) => {
    const ticker = rawTicker && rawTicker.trim() ? rawTicker : '—';
    const range = ranges[rawTicker] || {};
    const from = range.firstDate || 'N/D';
    const to = range.lastDate || 'N/D';
    const okStart = range.firstDate
      ? differenceInCalendarDays(new Date(range.firstDate), new Date(minHistoryDate)) <= 7
      : false;
    const okEnd = range.lastDate
      ? differenceInCalendarDays(new Date(today), new Date(range.lastDate)) <= 7
      : false;
    const status: CoverageRow['status'] = okStart && okEnd ? 'OK' : okStart || okEnd ? 'PARZIALE' : 'INCOMPLETO';
    const instrument = rawTicker ? resolveInstrumentForTicker(instruments, rawTicker) : undefined;

    return {
      ticker,
      isin: instrument?.isin ?? null,
      name: instrument?.name ?? null,
      instrumentId: instrument?.id,
      from,
      to,
      status
    };
  });
};

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
  const portfolioId = getCurrentPortfolioId();
  const settings = await db.settings.where('portfolioId').equals(portfolioId).first();
  if (!settings) return;

  const instruments = await db.instruments.where('portfolioId').equals(portfolioId).toArray();
  const eodhd = new EodhdPriceProvider(settings.eodhdApiKey);
  const sheet = new GoogleSheetsPriceProvider(settings.googleSheetUrl);

  const today = format(new Date(), 'yyyy-MM-dd');

  const allTx = await db.transactions.where('portfolioId').equals(portfolioId).sortBy('date');
  const earliestDateNeeded = allTx.length > 0 ? format(subDays(allTx[0].date, 7), 'yyyy-MM-dd') : format(subDays(new Date(), 365), 'yyyy-MM-dd');

  for (const instr of instruments) {
    if (instr.type === 'Cash') continue;

    const existing = await db.prices
      .where('[ticker+date]')
      .between([instr.ticker, Dexie.minKey], [instr.ticker, Dexie.maxKey])
      .and(p => p.portfolioId === portfolioId)
      .sortBy('date');

    const minPriceDate = existing[0]?.date;
    const maxPriceDate = existing[existing.length - 1]?.date;

    let startDate = earliestDateNeeded;
    if (minPriceDate && minPriceDate > earliestDateNeeded) {
      startDate = earliestDateNeeded;
    } else if (maxPriceDate) {
      startDate = format(new Date(maxPriceDate), 'yyyy-MM-dd');
    }

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
      await db.prices.bulkPut(pointsToSave.map(p => ({ ...p, portfolioId })));
    }
  }
};

// Helpers per backfill
export const getTickersForBackfill = async (portfolioId: string, scope: 'current' | 'all'): Promise<string[]> => {
  const tx = await db.transactions.where('portfolioId').equals(portfolioId).toArray();
  if (scope === 'all') {
    const all = Array.from(new Set(tx.map(t => t.instrumentTicker).filter(Boolean))) as string[];
    return all;
  }

  const qtyMap = new Map<string, number>();
  tx.forEach(t => {
    if (!t.instrumentTicker) return;
    const cur = qtyMap.get(t.instrumentTicker) || 0;
    if (t.type === TransactionType.Buy) qtyMap.set(t.instrumentTicker, cur + (t.quantity || 0));
    if (t.type === TransactionType.Sell) qtyMap.set(t.instrumentTicker, cur - (t.quantity || 0));
  });
  const current = Array.from(qtyMap.entries())
    .filter(([, qty]) => qty > 1e-8)
    .map(([ticker]) => ticker);
  if (current.length === 0) {
    const all = Array.from(new Set(tx.map(t => t.instrumentTicker).filter(Boolean))) as string[];
    return all;
  }
  return current;
};

export const getPriceCoverage = async (portfolioId: string, tickers: string[], minHistoryDate: string) => {
  const ranges: Record<string, { firstDate?: string; lastDate?: string }> = {};
  let earliestCoveredDate: string | undefined;
  let latestCoveredDate: string | undefined;

  for (const t of tickers) {
    if (!t) {
      ranges[t] = {};
      continue;
    }
    const rows = await db.prices
      .where('[ticker+date]')
      .between([t, Dexie.minKey], [t, Dexie.maxKey])
      .and(p => p.portfolioId === portfolioId)
      .sortBy('date');
    const first = rows[0]?.date;
    const last = rows[rows.length - 1]?.date;
    ranges[t] = { firstDate: first, lastDate: last };
    if (first && last) {
      earliestCoveredDate = earliestCoveredDate ? (first > earliestCoveredDate ? first : earliestCoveredDate) : first;
      latestCoveredDate = latestCoveredDate ? (last < latestCoveredDate ? last : latestCoveredDate) : last;
    }
  }

  const instruments = await db.instruments.where('portfolioId').equals(portfolioId).toArray();
  const today = format(new Date(), 'yyyy-MM-dd');
  const perTicker = buildCoverageRows(tickers, ranges, instruments, minHistoryDate, today);
  const okCount = perTicker.filter(p => p.status === 'OK').length;
  return { earliestCoveredDate, latestCoveredDate, perTicker, okCount };
};

export const backfillPricesForPortfolio = async (
  portfolioId: string,
  tickers: string[],
  minHistoryDate: string,
  onProgress?: (info: { ticker: string; index: number; total: number; phase: 'backfill' | 'forward' | 'done'; error?: string }) => void
) => {
  const settings = await db.settings.where('portfolioId').equals(portfolioId).first();
  if (!settings || !settings.eodhdApiKey) {
    const msg = 'API key EODHD mancante';
    if (onProgress) onProgress({ ticker: '', index: 0, total: tickers.length, phase: 'done', error: msg });
    throw new Error(msg);
  }

  const eodhd = new EodhdPriceProvider(settings.eodhdApiKey);
  const today = format(new Date(), 'yyyy-MM-dd');

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    try {
      if (onProgress) onProgress({ ticker, index: i + 1, total: tickers.length, phase: 'backfill' });
      const existing = await db.prices
        .where('[ticker+date]')
        .between([ticker, Dexie.minKey], [ticker, Dexie.maxKey])
        .and(p => p.portfolioId === portfolioId)
        .sortBy('date');

      const minInDb = existing[0]?.date;
      const maxInDb = existing[existing.length - 1]?.date;

      const ranges: { from: string; to: string }[] = [];
      if (!minInDb || minInDb > minHistoryDate) {
        ranges.push({ from: minHistoryDate, to: minInDb ? format(subDays(new Date(minInDb), 1), 'yyyy-MM-dd') : today });
      }
      if (!maxInDb || maxInDb < today) {
        ranges.push({ from: maxInDb ? format(addDays(new Date(maxInDb), 1), 'yyyy-MM-dd') : minHistoryDate, to: today });
      }

      for (const r of ranges) {
        if (onProgress) onProgress({ ticker, index: i + 1, total: tickers.length, phase: 'forward' });
        const pts = await eodhd.getHistory(ticker, r.from, r.to);
        if (pts.length > 0) {
          const toSave = pts.map(p => ({ ...p, portfolioId }));
          await db.prices.bulkPut(toSave);
        }
        await new Promise(res => setTimeout(res, 400)); // rate-limit soft
      }
    } catch (e: any) {
      if (onProgress) onProgress({ ticker, index: i + 1, total: tickers.length, phase: 'backfill', error: e?.message || String(e) });
    }
  }
  if (onProgress) onProgress({ ticker: '', index: tickers.length, total: tickers.length, phase: 'done' });
};
