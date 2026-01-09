import { Transaction, TransactionType, Instrument, PricePoint, PortfolioState, PortfolioPosition, PerformancePoint, AssetType, Currency, AssetClass } from '../types';
import { format, startOfMonth, endOfMonth, eachMonthOfInterval, subMonths, isValid, getYear, eachDayOfInterval, differenceInCalendarDays } from 'date-fns';

// Helper sicuro per gestire date che potrebbero essere stringhe o oggetti Date
const toDate = (dateInput: string | Date | number): Date => {
  if (dateInput instanceof Date) return dateInput;
  if (typeof dateInput === 'string') return new Date(dateInput);
  return new Date(dateInput);
};

// Helper sicuro per divisioni
const safeDiv = (num: number, den: number): number => {
  if (den === 0 || isNaN(den)) return 0;
  return num / den;
};

const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  [AssetClass.STOCK]: 'Azioni',
  [AssetClass.BOND]: 'Obbligazioni',
  [AssetClass.ETF_STOCK]: 'ETF Azionari',
  [AssetClass.ETF_BOND]: 'ETF Obbligazionari',
  [AssetClass.ETC]: 'ETC',
  [AssetClass.CRYPTO]: 'Cripto',
  [AssetClass.CASH]: 'Liquidità',
  [AssetClass.OTHER]: 'Altro'
};

export const getAssetClassLabel = (ac: AssetClass): string => ASSET_CLASS_LABELS[ac] || ac;
const REGION_LABELS: Record<RegionKey, string> = {
  CH: 'Svizzera',
  NA: 'Nord America',
  EU: 'Europa',
  AS: 'Asia',
  OC: 'Oceania',
  LATAM: 'America Latina',
  AF: 'Africa',
  UNASSIGNED: 'Non definito'
};
export const getRegionLabel = (rk: RegionKey) => REGION_LABELS[rk] || rk;

const containsAny = (source: string, keywords: string[]) =>
  keywords.some(k => source.toLowerCase().includes(k.toLowerCase()));

export const inferAssetClass = (instrument: Instrument): AssetClass => {
  if (instrument.assetClass) return instrument.assetClass;
  const name = instrument.name?.toLowerCase() || '';
  const ticker = instrument.ticker?.toUpperCase() || '';
  const type = instrument.type;

  // Crypto
  if (ticker.includes('BTC') || ticker.includes('ETH') || type === AssetType.Crypto) return AssetClass.CRYPTO;

  // ETC / ETN / commodity cues
  if (containsAny(name, ['etc', 'etn', 'physical gold', 'gold', 'commodity'])) return AssetClass.ETC;

  // ETF cues
  const isETF = name.includes('etf') || name.includes('ucits') || type === AssetType.ETF;
  if (isETF) {
    const bondKeywords = ['bond', 'treasury', 'aggregate', 'gov', 'government', 'corporate', 'credit', 'duration', 'tips', 'inflation'];
    const equityKeywords = ['equity', 'msci', 's&p', 'world', 'emerging', 'em ', 'growth', 'value', 'dividend', 'small'];
    if (containsAny(name, bondKeywords)) return AssetClass.ETF_BOND;
    if (containsAny(name, equityKeywords)) return AssetClass.ETF_STOCK;
    return AssetClass.ETF_STOCK; // default ETF as equity
  }

  // Bonds
  if (type === AssetType.Bond) return AssetClass.BOND;

  // Stocks
  if (type === AssetType.Stock) return AssetClass.STOCK;

  // Cash
  if (type === AssetType.Cash) return AssetClass.CASH;

  return AssetClass.OTHER;
};

// Helper to get price at specific date
const getPriceAtDate = (ticker: string, dateStr: string, prices: PricePoint[]): number => {
  // Filter prices for ticker and find the latest one on or before dateStr
  const relevantPrices = prices
    .filter(p => p.ticker === ticker && p.date <= dateStr)
    .sort((a, b) => b.date.localeCompare(a.date));

  return relevantPrices.length > 0 ? relevantPrices[0].close : 0;
};

// Build a lookup of transactions by ticker (sorted desc by date)
const buildTxPriceMap = (transactions: Transaction[]) => {
  const map = new Map<string, { dateStr: string, price: number }[]>();
  transactions.forEach(t => {
    if (!t.instrumentTicker) return;
    const dateStr = format(toDate(t.date), 'yyyy-MM-dd');
    const arr = map.get(t.instrumentTicker) || [];
    arr.push({ dateStr, price: t.price });
    map.set(t.instrumentTicker, arr);
  });
  map.forEach(arr => arr.sort((a, b) => b.dateStr.localeCompare(a.dateStr)));
  return map;
};

const getPriceWithFallback = (
  ticker: string,
  dateStr: string,
  prices: PricePoint[],
  txPriceMap: Map<string, { dateStr: string, price: number }[]>
): number => {
  const price = getPriceAtDate(ticker, dateStr, prices);
  if (price > 0) return price;
  const txArr = txPriceMap.get(ticker);
  if (!txArr || txArr.length === 0) return 0;
  const latest = txArr.find(tx => tx.dateStr <= dateStr);
  return latest ? latest.price : 0;
};

const cleanNumber = (value: unknown, fallback = 0) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

const computeTWRRFromNav = (history: PerformancePoint[], externalFlows: { date: string; amount: number }[]) => {
  if (history.length === 0) return history;
  const flowByDate = new Map<string, number>();
  externalFlows.forEach(f => flowByDate.set(f.date, (flowByDate.get(f.date) || 0) + f.amount));

  let twrrIndex = 1;
  let prevNav = history[0].value;

  return history.map((point, idx) => {
    if (idx === 0) return { ...point, cumulativeTWRRIndex: 1, cumulativeReturnPct: 0 };
    const cf = flowByDate.get(point.date) || 0;
    const r = prevNav > 0 ? ((point.value - cf - prevNav) / prevNav) : 0;
    twrrIndex = twrrIndex * (1 + r);
    prevNav = point.value;
    return { ...point, cumulativeTWRRIndex: twrrIndex, cumulativeReturnPct: (twrrIndex - 1) * 100 };
  });
};

const computeXIRR = (cashflows: { date: string; amount: number }[], guess = 0.1): number | null => {
  if (cashflows.length === 0) return null;
  const toDays = (d: string) => new Date(d).getTime();
  const t0 = toDays(cashflows[0].date);

  const npv = (rate: number) => cashflows.reduce((acc, cf) => {
    const days = (toDays(cf.date) - t0) / (1000 * 60 * 60 * 24);
    return acc + cf.amount / Math.pow(1 + rate, days / 365.25);
  }, 0);

  const dNpv = (rate: number) => cashflows.reduce((acc, cf) => {
    const days = (toDays(cf.date) - t0) / (1000 * 60 * 60 * 24);
    const frac = days / 365.25;
    return acc - (cf.amount * frac) / Math.pow(1 + rate, frac + 1);
  }, 0);

  let x = guess;
  for (let i = 0; i < 50; i++) {
    const f = npv(x);
    const df = dNpv(x);
    if (Math.abs(df) < 1e-10) break;
    const next = x - f / df;
    if (Math.abs(next - x) < 1e-7) return next;
    x = next;
  }
  return null;
};

// --- CORE PORTFOLIO LOGIC ---

export const calculatePortfolioState = (
  transactions: Transaction[],
  instruments: Instrument[],
  prices: PricePoint[]
): PortfolioState => {
  // Deduplicate instruments by ticker to avoid duplicate render if DB has dupes
  const uniqueInstruments = Array.from(
    new Map(instruments.map(inst => [inst.ticker, inst])).values()
  );

  // 1. Calculate Invested Capital (Net Flows)
  const deposits = transactions.filter(t => t.type === TransactionType.Deposit).reduce((s, t) => s + (t.quantity || 0), 0);
  const withdrawals = transactions.filter(t => t.type === TransactionType.Withdrawal).reduce((s, t) => s + (t.quantity || 0), 0);

  let estimatedInvested = 0;
  if (deposits === 0 && withdrawals === 0) {
    // Fallback if no explicit deposits/withdrawals: Sum of Buys - Sells
    estimatedInvested = transactions.reduce((acc, t) => {
      const qty = t.quantity || 0;
      const price = t.price || 0;
      const fees = t.fees || 0;

      if (t.type === TransactionType.Buy) return acc + (qty * price) + fees;
      if (t.type === TransactionType.Sell) return acc - ((qty * price) - fees);
      return acc;
    }, 0);
  } else {
    estimatedInvested = deposits - withdrawals;
  }

  // 2. Calculate Positions (Quantity)
  const holdingsMap = new Map<string, number>();
  transactions.forEach(t => {
    if (!t.instrumentTicker) return;
    const current = holdingsMap.get(t.instrumentTicker) || 0;
    const qty = t.quantity || 0;

    if (t.type === TransactionType.Buy) holdingsMap.set(t.instrumentTicker, current + qty);
    else if (t.type === TransactionType.Sell) holdingsMap.set(t.instrumentTicker, current - qty);
  });

  // 3. Calculate Values
  let totalValue = 0;
  const positions: PortfolioPosition[] = [];
  const todayStr = format(new Date(), 'yyyy-MM-dd');
  const txPriceMap = buildTxPriceMap(transactions);

  uniqueInstruments.forEach(inst => {
    const qty = holdingsMap.get(inst.ticker) || 0;
    // Handle floating point dust
    if (qty > 0.000001) {
      const currentPrice = getPriceWithFallback(inst.ticker, todayStr, prices, txPriceMap);
      // NOTE: Here we assume Price is in Base Currency or converted. 
      // For MVP, if currency matches app base currency, use as is. 
      // A full Forex implementation would convert here.
      const val = qty * currentPrice;
      totalValue += val;

      positions.push({
        ticker: inst.ticker,
        name: inst.name,
        assetType: inst.type,
        assetClass: inst.assetClass,
        currency: inst.currency,
        quantity: qty,
        currentPrice,
        currentValueCHF: val,
        targetPct: inst.targetAllocation || 0,
        currentPct: 0 // Calc after total
      });
    }
  });

  // Update percentages
  positions.forEach(p => {
    p.currentPct = safeDiv(p.currentValueCHF, totalValue) * 100;
  });

  const balance = totalValue - estimatedInvested;

  return {
    positions,
    totalValue,
    investedCapital: estimatedInvested,
    balance,
    balancePct: safeDiv(balance, estimatedInvested) * 100
  };
};

export type Granularity = 'monthly' | 'daily';

export const calculateHistoricalPerformance = (
  transactions: Transaction[],
  instruments: Instrument[],
  prices: PricePoint[],
  monthsBack: number = 60, // Increased default history
  granularity: Granularity = 'monthly'
): {
  history: PerformancePoint[],
  assetHistory: Record<string, { date: string, pct: number }[]>,
  currencyHistory: Record<string, { date: string, pct: number }[]>
} => {

  const uniqueInstruments = Array.from(
    new Map(instruments.map(inst => [inst.ticker, inst])).values()
  );

  const end = new Date();
  const firstTx = transactions.length > 0 ? transactions[transactions.length - 1].date : new Date();
  let start = subMonths(startOfMonth(end), monthsBack);
  if (firstTx < start) start = startOfMonth(firstTx);

  const history: PerformancePoint[] = [];
  const assetHistory: Record<string, { date: string, pct: number }[]> = {};
  const currencyHistory: Record<string, { date: string, pct: number }[]> = {};
  const txPriceMap = buildTxPriceMap(transactions);

  Object.values(AssetType).forEach(t => assetHistory[t] = []);
  Object.values(Currency).forEach(c => currencyHistory[c] = []);

  if (granularity === 'monthly') {
    const months = eachMonthOfInterval({ start, end });

    months.forEach((date, idx) => {
      const dateStr = format(endOfMonth(date), 'yyyy-MM-dd');

      const txUntilNow = transactions.filter(t => {
        const d = toDate(t.date);
        return isValid(d) && format(d, 'yyyy-MM-dd') <= dateStr;
      });

      const holdingsMap = new Map<string, number>();
      let investedAtDate = 0;

      txUntilNow.forEach(t => {
        const qty = t.quantity || 0;
        const price = t.price || 0;
        const fees = t.fees || 0;

        if (t.instrumentTicker) {
          const current = holdingsMap.get(t.instrumentTicker) || 0;
          if (t.type === TransactionType.Buy) holdingsMap.set(t.instrumentTicker, current + qty);
          else if (t.type === TransactionType.Sell) holdingsMap.set(t.instrumentTicker, current - qty);
        }

        if (t.type === TransactionType.Buy) investedAtDate += (qty * price) + fees;
        if (t.type === TransactionType.Sell) investedAtDate -= ((qty * price) - fees);
        if (t.type === TransactionType.Deposit) investedAtDate += (t.quantity || 0);
        if (t.type === TransactionType.Withdrawal) investedAtDate -= (t.quantity || 0);
      });

      let totalValueAtDate = 0;
      const assetValues: Record<string, number> = {};
      const currencyValues: Record<string, number> = {};

      holdingsMap.forEach((qty, ticker) => {
        if (qty <= 0.000001) return;
        const price = getPriceWithFallback(ticker, dateStr, prices, txPriceMap);
        const val = qty * price;
        totalValueAtDate += val;

        const instr = uniqueInstruments.find(i => i.ticker === ticker);
        if (instr) {
          assetValues[instr.type] = (assetValues[instr.type] || 0) + val;
          currencyValues[instr.currency] = (currencyValues[instr.currency] || 0) + val;
        }
      });

      const cumulativeReturnPct = investedAtDate > 0 ? ((totalValueAtDate / investedAtDate) - 1) * 100 : 0;

      let periodReturn = 0;
      if (idx > 0 && history[idx - 1].value > 0) {
        periodReturn = ((totalValueAtDate / history[idx - 1].value) - 1) * 100;
      }

      const prevTWRRIndex = idx > 0 ? (history[idx - 1].cumulativeTWRRIndex || 1) : 1;
      const currentTWRRIndex = prevTWRRIndex * (1 + (periodReturn / 100));

    history.push({
      date: format(date, 'yyyy-MM-dd'),
      value: totalValueAtDate,
      invested: investedAtDate,
      monthlyReturnPct: periodReturn,
      cumulativeReturnPct: cumulativeReturnPct,
        cumulativeTWRRIndex: currentTWRRIndex
      });

      Object.keys(assetHistory).forEach(key => {
        const val = assetValues[key] || 0;
        const pct = safeDiv(val, totalValueAtDate) * 100;
        assetHistory[key].push({ date: dateStr, pct });
      });
      Object.keys(currencyHistory).forEach(key => {
        const val = currencyValues[key] || 0;
        const pct = safeDiv(val, totalValueAtDate) * 100;
        currencyHistory[key].push({ date: dateStr, pct });
      });

    });

    return { history, assetHistory, currencyHistory };
  }

  // DAILY PATH
  const days = eachDayOfInterval({ start, end });
  const dateIndex = days.map(d => format(d, 'yyyy-MM-dd'));

  // group transactions by ticker sorted asc
  const txByTicker = new Map<string, Transaction[]>();
  transactions
    .slice()
    .sort((a, b) => toDate(a.date).getTime() - toDate(b.date).getTime())
    .forEach(t => {
      if (!t.instrumentTicker) return;
      const arr = txByTicker.get(t.instrumentTicker) || [];
      arr.push(t);
      txByTicker.set(t.instrumentTicker, arr);
    });

  // price map sorted asc for forward fill
  const priceMap = new Map<string, PricePoint[]>();
  prices
    .filter(p => !!p?.date && !!p?.ticker)
    .slice()
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
    .forEach(p => {
      const arr = priceMap.get(p.ticker) || [];
      arr.push(p);
      priceMap.set(p.ticker, arr);
    });

  const runningQty = new Map<string, number>();
  const txPtr = new Map<string, number>();
  const pricePtr = new Map<string, number>();
  const lastClose = new Map<string, number>();
  let investedRunning = 0;
  let cashRunning = 0;

  // Precompute cashflows esterni (Deposit/Withdrawal) per TWRR/MWRR
  const externalFlows: { date: string; amount: number }[] = [];
  transactions.forEach(t => {
    const d = format(toDate(t.date), 'yyyy-MM-dd');
    if (t.type === TransactionType.Deposit) externalFlows.push({ date: d, amount: t.quantity || 0 });
    if (t.type === TransactionType.Withdrawal) externalFlows.push({ date: d, amount: -(t.quantity || 0) });
  });

  dateIndex.forEach((dateStr, idx) => {
    // apply transactions for the day (all tickers)
    transactions.forEach(t => {
      const tDateStr = format(toDate(t.date), 'yyyy-MM-dd');
      if (tDateStr !== dateStr) return;
      const qty = t.quantity || 0;
      const price = t.price || 0;
      const fees = t.fees || 0;

      if (t.instrumentTicker) {
        const current = runningQty.get(t.instrumentTicker) || 0;
        if (t.type === TransactionType.Buy) runningQty.set(t.instrumentTicker, current + qty);
        else if (t.type === TransactionType.Sell) runningQty.set(t.instrumentTicker, current - qty);
      }

      if (t.type === TransactionType.Buy) {
        investedRunning += (qty * price) + fees;
        cashRunning -= (qty * price) + fees;
      }
      if (t.type === TransactionType.Sell) {
        investedRunning -= ((qty * price) - fees);
        cashRunning += (qty * price) - fees;
      }
      if (t.type === TransactionType.Deposit) {
        investedRunning += (t.quantity || 0);
        cashRunning += (t.quantity || 0);
      }
      if (t.type === TransactionType.Withdrawal) {
        investedRunning -= (t.quantity || 0);
        cashRunning -= (t.quantity || 0);
      }
      if (t.type === TransactionType.Fee) {
        cashRunning -= fees;
      }
    });

    let totalValueAtDate = 0;
    const assetValues: Record<string, number> = {};
    const currencyValues: Record<string, number> = {};

    uniqueInstruments.forEach(instr => {
      const ticker = instr.ticker;
      const qty = runningQty.get(ticker) || 0;
      if (qty <= 0.000001) return;

      const pArr = priceMap.get(ticker) || [];
      const pIdx = pricePtr.get(ticker) || 0;
      let i = pIdx;
      while (i < pArr.length && pArr[i].date <= dateStr) {
        lastClose.set(ticker, pArr[i].close);
        i++;
      }
      pricePtr.set(ticker, i);
      const price = lastClose.get(ticker) ?? 0;
      const val = qty * price;
      totalValueAtDate += val;
      assetValues[instr.type] = (assetValues[instr.type] || 0) + val;
      currencyValues[instr.currency] = (currencyValues[instr.currency] || 0) + val;
    });

    const nav = totalValueAtDate + cashRunning;

    let periodReturn = 0;
    if (idx > 0 && history[idx - 1].value > 0) {
      periodReturn = ((nav / history[idx - 1].value) - 1) * 100;
    }
    const prevTWRRIndex = idx > 0 ? (history[idx - 1].cumulativeTWRRIndex || 1) : 1;
    const currentTWRRIndex = prevTWRRIndex * (1 + (periodReturn / 100));
    const cumulativeReturnPct = investedRunning > 0 ? ((nav / investedRunning) - 1) * 100 : 0;

    history.push({
      date: dateStr,
      value: nav,
      invested: investedRunning,
      monthlyReturnPct: periodReturn,
      cumulativeReturnPct,
      cumulativeTWRRIndex: currentTWRRIndex
    });

    Object.keys(assetHistory).forEach(key => {
      const val = assetValues[key] || 0;
      const pct = safeDiv(val, totalValueAtDate) * 100;
      assetHistory[key].push({ date: dateStr, pct });
    });
    Object.keys(currencyHistory).forEach(key => {
      const val = currencyValues[key] || 0;
      const pct = safeDiv(val, totalValueAtDate) * 100;
      currencyHistory[key].push({ date: dateStr, pct });
    });
  });

  return { history, assetHistory, currencyHistory };
};

// --- NEW ANALYTICS HELPERS ---

export interface PortfolioAnalytics {
  annualReturns: { year: number; returnPct: number }[];
  maxDrawdown: number;
  drawdownSeries: { date: string; depth: number }[];
  annualizedReturn: number;
  stdDev: number;
  sharpeRatio: number;
}

export const calculateAnalytics = (history: PerformancePoint[], granularity: Granularity = 'monthly'): PortfolioAnalytics => {
  if (history.length < 2) {
    return {
      annualReturns: [],
      maxDrawdown: 0,
      drawdownSeries: [],
      annualizedReturn: 0,
      stdDev: 0,
      sharpeRatio: 0
    };
  }

  // 1. Annual Returns
  const returnsByYear: Record<number, number[]> = {};

  if (granularity === 'daily') {
    // group by year using start/end value
    const byYearValue: Record<number, { start?: number; end?: number }> = {};
    history.forEach(p => {
      const y = getYear(new Date(p.date));
      if (!byYearValue[y]) byYearValue[y] = {};
      if (byYearValue[y].start === undefined) byYearValue[y].start = p.value;
      byYearValue[y].end = p.value;
    });
    Object.entries(byYearValue).forEach(([y, v]) => {
      if (v.start && v.end) {
        const ret = v.start > 0 ? (v.end / v.start) - 1 : 0;
        returnsByYear[+y] = [ret];
      }
    });
  } else {
    history.forEach(p => {
      const y = getYear(new Date(p.date));
      if (!returnsByYear[y]) returnsByYear[y] = [];
      returnsByYear[y].push(p.monthlyReturnPct / 100);
    });
  }

  const annualReturns = Object.entries(returnsByYear).map(([year, returns]) => {
    if (returns.length === 0) return { year: parseInt(year), returnPct: 0 };
    const compound = returns.reduce((acc, r) => acc * (1 + r), 1) - 1;
    return { year: parseInt(year), returnPct: compound * 100 };
  });

  // 2. Drawdowns
  let maxPeak = -Infinity;
  let maxDrawdown = 0;
  const drawdownSeries = history.map(p => {
    if (p.value > maxPeak) maxPeak = p.value;
    const depth = maxPeak > 0 ? (p.value / maxPeak) - 1 : 0;
    if (depth < maxDrawdown) maxDrawdown = depth;
    return { date: p.date, depth: depth * 100 };
  });

  const lastPoint = history[history.length - 1];
  const firstPoint = history.find(h => h.value > 0) || history[0];

  if (!lastPoint || !firstPoint) {
    return {
      annualReturns,
      maxDrawdown: maxDrawdown * 100,
      drawdownSeries,
      annualizedReturn: 0,
      stdDev: 0,
      sharpeRatio: 0
    };
  }

  let annualizedReturn = 0;
  let stdDevAnnualized = 0;
  let sharpeRatio = 0;

  if (granularity === 'daily') {
    const returns = history
      .map((p, i) => i === 0 ? null : (history[i - 1].value > 0 ? (p.value / history[i - 1].value) - 1 : null))
      .filter((r): r is number => r !== null);
    const mean = returns.reduce((a, b) => a + b, 0) / (returns.length || 1);
    const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (returns.length || 1);
    const stdDaily = Math.sqrt(variance);
    stdDevAnnualized = stdDaily * Math.sqrt(252);

    const days = differenceInCalendarDays(new Date(lastPoint.date), new Date(firstPoint.date)) || 1;
    annualizedReturn = firstPoint.value > 0
      ? (Math.pow(lastPoint.value / firstPoint.value, 365.25 / days) - 1) * 100
      : 0;

    const rf = 0.02;
    sharpeRatio = stdDevAnnualized > 0 ? ((mean * 252 * 100) - (rf * 100)) / stdDevAnnualized : 0;
  } else {
    const monthsCount = history.filter(h => h.value > 0).length;
    const totalTWRRGrowth = lastPoint.cumulativeTWRRIndex || 1;
    const years = monthsCount / 12;
    annualizedReturn = years > 0
      ? (Math.pow(totalTWRRGrowth, 1 / years) - 1) * 100
      : 0;

    const returns = history.map(h => h.monthlyReturnPct);
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
    const stdDevMonthly = Math.sqrt(variance);
    stdDevAnnualized = stdDevMonthly * Math.sqrt(12);

    const rf = 2;
    sharpeRatio = stdDevAnnualized > 0 ? (annualizedReturn - rf) / stdDevAnnualized : 0;
  }

  return {
    annualReturns,
    maxDrawdown: maxDrawdown * 100,
    drawdownSeries,
    annualizedReturn,
    stdDev: stdDevAnnualized,
    sharpeRatio
  };
};

export const calculateRebalancing = (
  positions: PortfolioPosition[],
  totalPortfolioValue: number,
  strategy: string,
  cashInjection: number
) => {

  const effectiveTotal = totalPortfolioValue + (strategy === 'Accumulate' ? cashInjection : 0);

  return positions.map(p => {
    const targetValue = effectiveTotal * (p.targetPct / 100);
    const currentValue = p.currentValueCHF;
    const diff = targetValue - currentValue;

    let action = 'NEUTRO';
    if (p.targetPct === 0 && p.quantity > 0) action = 'VENDI'; // Exit position
    else {
      // Threshold 1% (could be dynamic)
      const threshold = effectiveTotal * 0.01;
      if (diff > threshold) action = 'COMPRA';
      else if (diff < -threshold) action = 'VENDI';
    }

    if (strategy === 'Accumulate' && action === 'VENDI') action = 'NEUTRO'; // Only buys

    return {
      ticker: p.ticker,
      name: p.name,
      action,
      amount: action === 'NEUTRO' ? 0 : Math.abs(diff),
      quantity: action === 'NEUTRO' ? 0 : (p.currentPrice > 0 ? Math.abs(diff) / p.currentPrice : 0),
      currentPct: p.currentPct,
      targetPct: p.targetPct
    };
  });
};

export const calculateHoldings = (transactions: Transaction[]) => {
  const holdings = new Map<string, number>();
  transactions.forEach(t => {
    if (!t.instrumentTicker) return;
    const current = holdings.get(t.instrumentTicker) || 0;
    const qty = t.quantity || 0;
    if (t.type === TransactionType.Buy) holdings.set(t.instrumentTicker, current + qty);
    else if (t.type === TransactionType.Sell) holdings.set(t.instrumentTicker, current - qty);
  });
  return holdings;
};

const regionFallbackFromISIN = (isin?: string): RegionKey | null => {
  if (!isin || isin.length < 2) return null;
  const prefix = isin.slice(0, 2).toUpperCase();
  if (prefix === 'CH') return 'CH';
  if (prefix === 'US') return 'NA';
  if (prefix === 'GB') return 'EU'; // UK -> Europa per semplicità
  if (['IE', 'LU', 'FR', 'DE', 'NL', 'ES', 'IT', 'BE', 'DK', 'SE', 'FI', 'NO', 'PT', 'AT'].includes(prefix)) return 'EU';
  if (['JP', 'CN', 'HK', 'KR', 'SG', 'IN', 'TW'].includes(prefix)) return 'AS';
  if (['AU', 'NZ'].includes(prefix)) return 'OC';
  if (['BR', 'MX', 'CL', 'AR'].includes(prefix)) return 'LATAM';
  if (['ZA', 'EG', 'NG'].includes(prefix)) return 'AF';
  return null;
};

export const calculateRegionExposure = (
  state: PortfolioState,
  instruments: Instrument[]
): { region: RegionKey; label: string; pct: number; value: number }[] => {
  if (!state) return [];
  const instByTicker = new Map(instruments.map(i => [i.ticker, i]));
  const totals = new Map<RegionKey, number>();
  let unassignedValue = 0;

  state.positions.forEach(p => {
    const inst = instByTicker.get(p.ticker);
    const value = p.currentValueCHF;
    if (!inst || value <= 0) return;

    const alloc = inst.regionAllocation;
    if (alloc && Object.keys(alloc).length > 0) {
      let sum = 0;
      (Object.entries(alloc) as [RegionKey, number][]).forEach(([rk, perc]) => {
        if (!rk || perc === undefined || perc === null) return;
        sum += perc;
      });
      const valid = sum > 0 ? (sum / 100) : 0;
      if (valid > 0) {
        (Object.entries(alloc) as [RegionKey, number][]).forEach(([rk, perc]) => {
          if (!rk || perc === undefined || perc === null) return;
          const val = value * (perc / 100);
          totals.set(rk, (totals.get(rk) || 0) + val);
        });
        return;
      }
    }

    const regionFromIsin = regionFallbackFromISIN(inst.isin);
    if (regionFromIsin) {
      totals.set(regionFromIsin, (totals.get(regionFromIsin) || 0) + value);
    } else {
      unassignedValue += value;
    }
  });

  const totalValue = state.totalValue;
  if (unassignedValue > 0) {
    totals.set('UNASSIGNED', (totals.get('UNASSIGNED') || 0) + unassignedValue);
  }

  const entries = Array.from(totals.entries()).map(([region, value]) => ({
    region,
    label: getRegionLabel(region),
    value,
    pct: totalValue > 0 ? (value / totalValue) * 100 : 0
  })).sort((a, b) => b.value - a.value);

  return entries;
};

export const calculateAllocationByAssetClass = (
  state: PortfolioState,
  instruments: Instrument[]
): { key: AssetClass; label: string; value: number; pct: number }[] => {
  if (!state) return [];
  const map = new Map<AssetClass, number>();
  const instByTicker = new Map(instruments.map(i => [i.ticker, i]));
  state.positions.forEach(p => {
    const inst = instByTicker.get(p.ticker);
    const ac = inst ? (inst.assetClass || inferAssetClass(inst)) : AssetClass.OTHER;
    const cur = map.get(ac) || 0;
    map.set(ac, cur + p.currentValueCHF);
  });
  const total = state.totalValue || 0;
  const entries = Array.from(map.entries())
    .map(([key, value]) => ({
      key,
      label: getAssetClassLabel(key),
      value,
      pct: total > 0 ? (value / total) * 100 : 0
    }))
    .filter(d => d.value > 0)
    .sort((a, b) => b.value - a.value);

  const major = entries.filter(e => e.pct >= 2);
  const minor = entries.filter(e => e.pct < 2);
  const minorSum = minor.reduce((s, m) => s + m.value, 0);
  if (minorSum > 0) {
    const pct = total > 0 ? (minorSum / total) * 100 : 0;
    major.push({ key: AssetClass.OTHER, label: 'Altro', value: minorSum, pct });
  }
  return major;
};
