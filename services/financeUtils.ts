import { Transaction, TransactionType, Instrument, PricePoint, PortfolioState, PortfolioPosition, PerformancePoint, AssetType, Currency, AssetClass, RegionKey } from '../types';
import { format, startOfMonth, endOfMonth, eachMonthOfInterval, isValid, getYear, eachDayOfInterval } from 'date-fns';
import { fillMissingPrices, PriceFillMeta } from './priceBackfill';
import { diffDaysYmd, isYmd, parseYmdLocal } from './dateUtils';

// Helper sicuro per gestire date che potrebbero essere stringhe o oggetti Date
const toDateSafe = (dateInput: string | Date | number): Date => {
  if (dateInput instanceof Date) return dateInput;
  if (typeof dateInput === 'string') return isYmd(dateInput) ? parseYmdLocal(dateInput) : new Date(dateInput);
  return new Date(dateInput);
};

const toDateString = (dateInput: string | Date | number): string => {
  if (typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
    const [y, m, d] = dateInput.split('-').map(Number);
    return format(new Date(y, m - 1, d), 'yyyy-MM-dd');
  }
  return format(toDateSafe(dateInput), 'yyyy-MM-dd');
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
  [AssetClass.CASH]: 'Liquidita',
  [AssetClass.OTHER]: 'Altro'
};

export const getAssetClassLabel = (ac: AssetClass): string => ASSET_CLASS_LABELS[ac] || ac;
export const getCanonicalTicker = (instrument: Instrument): string => {
  return instrument.preferredListing?.symbol || instrument.symbol || instrument.ticker;
};
const getInstrumentKey = (instrument: Instrument): string => {
  return instrument.symbol || instrument.ticker;
};
const REGION_LABELS: Record<RegionKey, string> = {
  CH: 'Svizzera',
  NA: 'Nord America',
  EU: 'Europa',
  AS: 'Asia',
  OC: 'Oceania',
  LATAM: 'America Latina',
  AF: 'Africa',
  UNASSIGNED: 'Non definito',
  OTHER: 'Altri'
};
export const getRegionLabel = (rk: RegionKey) => REGION_LABELS[rk] || rk;

const containsAny = (source: string, keywords: string[]) =>
  keywords.some(k => source.toLowerCase().includes(k.toLowerCase()));

export const inferAssetClass = (instrument: Instrument): AssetClass => {
  if (instrument.assetClass) return instrument.assetClass;
  const name = instrument.name?.toLowerCase() || '';
  const ticker = (instrument.symbol || instrument.ticker || '').toUpperCase();
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

export const getLatestPricePoint = (
  ticker: string,
  dateStr: string,
  prices: PricePoint[]
): PricePoint | null => {
  let latest: PricePoint | null = null;
  prices.forEach(p => {
    if (p.ticker !== ticker) return;
    if (p.date > dateStr) return;
    if (!latest || p.date > latest.date) latest = p;
  });
  return latest;
};

export const getValuationDateForHoldings = (
  transactions: Transaction[],
  prices: PricePoint[],
  instruments?: Instrument[]
): string | undefined => {
  const holdings = calculateHoldings(transactions);
  let minLastDate: string | undefined;
  let fallbackLastDate: string | undefined;
  const canonicalByTicker = instruments
    ? new Map(instruments.map(inst => [getInstrumentKey(inst), getCanonicalTicker(inst)]))
    : null;
  prices.forEach(p => {
    if (!fallbackLastDate || p.date > fallbackLastDate) fallbackLastDate = p.date;
  });
  holdings.forEach((qty, ticker) => {
    if (qty <= 0.000001) return;
    const priceTicker = canonicalByTicker?.get(ticker) || ticker;
    let lastDate: string | undefined;
    prices.forEach(p => {
      if (p.ticker !== priceTicker) return;
      if (!lastDate || p.date > lastDate) lastDate = p.date;
    });
    if (!lastDate) return;
    if (!minLastDate || lastDate < minLastDate) minLastDate = lastDate;
  });
  return minLastDate || fallbackLastDate;
};

// Build a lookup of transactions by ticker (sorted desc by date)
const buildTxPriceMap = (transactions: Transaction[]) => {
  const map = new Map<string, { dateStr: string, price: number }[]>();
  transactions.forEach(t => {
    if (!t.instrumentTicker) return;
    const dateStr = toDateString(t.date);
    const arr = map.get(t.instrumentTicker) || [];
    arr.push({ dateStr, price: t.price });
    map.set(t.instrumentTicker, arr);
  });
  map.forEach(arr => arr.sort((a, b) => b.dateStr.localeCompare(a.dateStr)));
  return map;
};

export const cleanNumber = (value: unknown, fallback = 0) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

export const computeTWRRFromNav = (history: PerformancePoint[], externalFlows: { date: string; amount: number }[]) => {
  if (history.length === 0) return history;
  const flowByDate = new Map<string, number>();
  externalFlows.forEach(f => flowByDate.set(f.date, (flowByDate.get(f.date) || 0) + f.amount));

  let twrrIndex = 1;
  let prevNav = history[0].value;

  return history.map((point, idx) => {
    if (idx === 0) return { ...point, cumulativeTWRRIndex: 1, cumulativeReturnPct: 0, monthlyReturnPct: 0 };
    const cf = flowByDate.get(point.date) || 0;
    const r = prevNav > 0 ? ((point.value - cf - prevNav) / prevNav) : 0;
    twrrIndex = twrrIndex * (1 + r);
    prevNav = point.value;
    return { ...point, cumulativeTWRRIndex: twrrIndex, cumulativeReturnPct: (twrrIndex - 1) * 100, monthlyReturnPct: r * 100 };
  });
};

export const computeXIRR = (cashflows: { date: string; amount: number }[], guess = 0.1): number | null => {
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
    new Map(instruments.map(inst => [inst.id || getInstrumentKey(inst), inst])).values()
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
  const priceTickers = Array.from(new Set(uniqueInstruments.map(inst => getCanonicalTicker(inst)))).filter(Boolean);
  const { filledByTicker } = fillMissingPrices(prices, [todayStr], { tickers: priceTickers });

  uniqueInstruments.forEach(inst => {
    const instrumentKey = getInstrumentKey(inst);
    const qty = holdingsMap.get(instrumentKey) || 0;
    // Handle floating point dust
    if (qty > 0.000001) {
      const priceTicker = getCanonicalTicker(inst);
      const filled = filledByTicker.get(priceTicker)?.get(todayStr);
      let currentPrice = filled?.close;
      if (currentPrice === undefined) {
        const txArr = txPriceMap.get(instrumentKey);
        const latestTx = txArr?.find(tx => tx.dateStr <= todayStr);
        if (latestTx) currentPrice = latestTx.price;
      }
      if (currentPrice === undefined) currentPrice = 0;
      // NOTE: Here we assume Price is in Base Currency or converted. 
      // For MVP, if currency matches app base currency, use as is. 
      // A full Forex implementation would convert here.
      const val = qty * currentPrice;
      totalValue += val;

      positions.push({
        ticker: instrumentKey,
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

type Cashflow = { date: string; amount: number };
export type NavDetailPoint = {
  date: string;
  navBaseCcy: number;
  holdingsValue: number;
  cashBalance: number;
  externalFlow: number;
  internalFlow: number;
  fxUsed: Record<string, number>;
  missingPriceTickers: string[];
  backfilledPriceTickers: string[];
  missingFxPairs: string[];
};

const sumCashflowsByDate = (cashflows: Cashflow[]) => {
  const map = new Map<string, number>();
  cashflows.forEach(cf => {
    map.set(cf.date, (map.get(cf.date) || 0) + cf.amount);
  });
  return Array.from(map.entries())
    .map(([date, amount]) => ({ date, amount }))
    .sort((a, b) => a.date.localeCompare(b.date));
};

export const getPortfolioDateBounds = (
  transactions: Transaction[],
  prices: PricePoint[],
  instruments?: Instrument[]
): { firstTransactionDate?: string; firstPriceDate?: string; lastPriceDate?: string; effectiveStartDate?: string } => {
  let firstTransactionDate: string | undefined;
  transactions.forEach(t => {
    const dateStr = toDateString(t.date);
    if (!firstTransactionDate || dateStr < firstTransactionDate) firstTransactionDate = dateStr;
  });

  let lastPriceDate: string | undefined;
  let firstPriceDate: string | undefined;
  const tickerSet = instruments && instruments.length > 0
    ? new Set(instruments.map(i => getCanonicalTicker(i)))
    : null;

  prices.forEach(p => {
    if (tickerSet && !tickerSet.has(p.ticker)) return;
    const dateStr = p.date;
    if (!lastPriceDate || dateStr > lastPriceDate) lastPriceDate = dateStr;
    if (firstTransactionDate && dateStr >= firstTransactionDate) {
      if (!firstPriceDate || dateStr < firstPriceDate) firstPriceDate = dateStr;
    }
  });

  const effectiveStartDate = firstTransactionDate || firstPriceDate;

  return {
    firstTransactionDate,
    firstPriceDate,
    lastPriceDate,
    effectiveStartDate
  };
};

export const buildNavSeriesDetailed = (
  transactions: Transaction[],
  instruments: Instrument[],
  prices: PricePoint[],
  granularity: Granularity = 'daily',
  fromDate?: string,
  endDate?: string
): NavDetailPoint[] => {
  if (!transactions.length) return [];

  const bounds = getPortfolioDateBounds(transactions, prices, instruments);
  if (!bounds.effectiveStartDate) return [];

  const startDateStr = fromDate && fromDate > bounds.effectiveStartDate
    ? toDateString(fromDate)
    : bounds.effectiveStartDate;
  const today = new Date();
  const lastPriceDate = bounds.lastPriceDate ? toDateSafe(bounds.lastPriceDate) : null;
  const endDateStr = toDateString(endDate || (lastPriceDate && lastPriceDate <= today ? bounds.lastPriceDate! : today));
  const startDateObj = toDateSafe(startDateStr);
  const endDateObj = toDateSafe(endDateStr);

  const startDate = granularity === 'monthly' ? startOfMonth(startDateObj) : startDateObj;
  const rangeEndDate = endDateObj < startDate ? startDate : endDateObj;

  const txPriceMap = buildTxPriceMap(transactions);
  const uniqueInstruments = Array.from(
    new Map(instruments.map(inst => [inst.id || getInstrumentKey(inst), inst])).values()
  );
  const canonicalByTicker = new Map(uniqueInstruments.map(inst => [getInstrumentKey(inst), getCanonicalTicker(inst)]));
  const dateIndex = granularity === 'monthly'
    ? eachMonthOfInterval({ start: startDate, end: rangeEndDate }).map(d => format(endOfMonth(d), 'yyyy-MM-dd'))
    : eachDayOfInterval({ start: startDate, end: rangeEndDate }).map(d => format(d, 'yyyy-MM-dd'));

  const priceTickers = Array.from(
    new Set(uniqueInstruments.map(instr => canonicalByTicker.get(getInstrumentKey(instr)) || getInstrumentKey(instr)))
  ).filter(Boolean);
  const { filledByTicker } = fillMissingPrices(prices, dateIndex, { tickers: priceTickers });

  const trackCash = transactions.some(t => t.type === TransactionType.Deposit || t.type === TransactionType.Withdrawal);
  const runningQty = new Map<string, number>();
  let cashRunning = 0;

  const applyTransactionToRunning = (t: Transaction) => {
    const qty = t.quantity || 0;
    const price = t.price || 0;
    const fees = t.fees || 0;

    if (t.instrumentTicker) {
      const current = runningQty.get(t.instrumentTicker) || 0;
      if (t.type === TransactionType.Buy) runningQty.set(t.instrumentTicker, current + qty);
      else if (t.type === TransactionType.Sell) runningQty.set(t.instrumentTicker, current - qty);
    }

    if (trackCash) {
      if (t.type === TransactionType.Buy) cashRunning -= (qty * price) + fees;
      if (t.type === TransactionType.Sell) cashRunning += (qty * price) - fees;
      if (t.type === TransactionType.Deposit) cashRunning += (t.quantity || 0);
      if (t.type === TransactionType.Withdrawal) cashRunning -= (t.quantity || 0);
      if (t.type === TransactionType.Dividend) cashRunning += (t.quantity || 0);
      if (t.type === TransactionType.Fee) cashRunning -= fees;
    }
  };

  const rangeStartStr = format(startDate, 'yyyy-MM-dd');
  transactions.forEach(t => {
    const tDateStr = toDateString(t.date);
    if (tDateStr < rangeStartStr) applyTransactionToRunning(t);
  });

  const hasExternal = transactions.some(t => t.type === TransactionType.Deposit || t.type === TransactionType.Withdrawal);

  return dateIndex.map(dateStr => {
    let externalFlow = 0;
    let internalFlow = 0;

    transactions.forEach(t => {
      const tDateStr = toDateString(t.date);
      if (tDateStr !== dateStr) return;
      const qty = t.quantity || 0;
      const price = t.price || 0;
      const fees = t.fees || 0;

      if (hasExternal) {
        if (t.type === TransactionType.Deposit) externalFlow += qty;
        if (t.type === TransactionType.Withdrawal) externalFlow -= qty;
        if (t.type === TransactionType.Buy) internalFlow -= (qty * price) + fees;
        if (t.type === TransactionType.Sell) internalFlow += (qty * price) - fees;
      } else {
        if (!t.instrumentTicker) return;
        if (t.type === TransactionType.Buy) externalFlow += (qty * price) + fees;
        if (t.type === TransactionType.Sell) externalFlow -= (qty * price) - fees;
      }

      applyTransactionToRunning(t);
    });

    let holdingsValue = 0;
    const missingPriceTickers: string[] = [];
    const backfilledPriceSet = new Set<string>();

    uniqueInstruments.forEach(instr => {
      const instrumentKey = getInstrumentKey(instr);
      const priceTicker = canonicalByTicker.get(instrumentKey) || instrumentKey;
      const qty = runningQty.get(instrumentKey) || 0;
      if (qty <= 0.000001) return;

      const filled = filledByTicker.get(priceTicker)?.get(dateStr);
      let price = filled?.close;
      let isBackfilled = Boolean(filled?.synthetic);

      if (price === undefined) {
        const txArr = txPriceMap.get(instrumentKey);
        const latestTx = txArr?.find(tx => tx.dateStr <= dateStr);
        if (latestTx) {
          price = latestTx.price;
          isBackfilled = true;
        }
      }

      if (price === undefined) {
        missingPriceTickers.push(priceTicker);
        return;
      }

      if (isBackfilled) {
        backfilledPriceSet.add(priceTicker);
      }

      holdingsValue += qty * price;
    });

    const navBaseCcy = holdingsValue + (trackCash ? cashRunning : 0);

    return {
      date: dateStr,
      navBaseCcy,
      holdingsValue,
      cashBalance: trackCash ? cashRunning : 0,
      externalFlow,
      internalFlow,
      fxUsed: {},
      missingPriceTickers,
      backfilledPriceTickers: Array.from(backfilledPriceSet),
      missingFxPairs: []
    };
  });
};

const buildExternalFlows = (transactions: Transaction[], granularity: Granularity): Cashflow[] => {
  const flows: Cashflow[] = [];
  const hasExternal = transactions.some(t => t.type === TransactionType.Deposit || t.type === TransactionType.Withdrawal);
  transactions.forEach(t => {
    const baseDate = toDateSafe(t.date);
    const dateStr = granularity === 'monthly'
      ? format(endOfMonth(baseDate), 'yyyy-MM-dd')
      : format(baseDate, 'yyyy-MM-dd');

    if (hasExternal) {
      if (t.type !== TransactionType.Deposit && t.type !== TransactionType.Withdrawal) return;
      const amount = t.type === TransactionType.Deposit ? (t.quantity || 0) : -(t.quantity || 0);
      flows.push({ date: dateStr, amount });
      return;
    }

    if (!t.instrumentTicker) return;
    const qty = t.quantity || 0;
    const price = t.price || 0;
    const fees = t.fees || 0;
    if (t.type === TransactionType.Buy) {
      flows.push({ date: dateStr, amount: (qty * price) + fees });
    }
    if (t.type === TransactionType.Sell) {
      flows.push({ date: dateStr, amount: -((qty * price) - fees) });
    }
  });
  return sumCashflowsByDate(flows);
};

const buildMwrrCashflows = (transactions: Transaction[]): Cashflow[] => {
  const hasExternal = transactions.some(t => t.type === TransactionType.Deposit || t.type === TransactionType.Withdrawal);
  const cashflows: Cashflow[] = [];

  transactions.forEach(t => {
    const dateStr = toDateString(t.date);
    const qty = t.quantity || 0;
    const price = t.price || 0;
    const fees = t.fees || 0;

    if (t.type === TransactionType.Deposit) cashflows.push({ date: dateStr, amount: -qty });
    if (t.type === TransactionType.Withdrawal) cashflows.push({ date: dateStr, amount: qty });
    if (t.type === TransactionType.Dividend) cashflows.push({ date: dateStr, amount: qty });
    if (t.type === TransactionType.Fee) cashflows.push({ date: dateStr, amount: -(fees || qty) });

    if (!hasExternal && t.instrumentTicker) {
      if (t.type === TransactionType.Buy) cashflows.push({ date: dateStr, amount: -((qty * price) + fees) });
      if (t.type === TransactionType.Sell) cashflows.push({ date: dateStr, amount: (qty * price) - fees });
    }
  });

  return sumCashflowsByDate(cashflows);
};

export const computeMwrrSeries = (
  history: PerformancePoint[],
  transactions: Transaction[]
): { date: string; mwrrPct: number }[] => {
  if (history.length === 0) return [];

  const startDate = history[0].date;
  const endDate = history[history.length - 1].date;
  const cashflowsAll = buildMwrrCashflows(transactions);
  const hasBeforeStart = cashflowsAll.some(cf => cf.date < startDate);
  const cashflowsInRange = cashflowsAll.filter(cf => cf.date >= startDate && cf.date <= endDate);

  const startValue = history[0].value || 0;
  const startNetFlow = cashflowsInRange
    .filter(cf => cf.date === startDate)
    .reduce((sum, cf) => sum + cf.amount, 0);
  const initialAmount = startValue - startNetFlow;
  const initialFlow = hasBeforeStart && initialAmount > 0
    ? { date: startDate, amount: -initialAmount }
    : null;

  const flowsSorted = [...cashflowsInRange].sort((a, b) => a.date.localeCompare(b.date));
  const activeFlows: Cashflow[] = initialFlow ? [initialFlow] : [];
  let flowIdx = 0;

  return history.map(point => {
    while (flowIdx < flowsSorted.length && flowsSorted[flowIdx].date <= point.date) {
      activeFlows.push(flowsSorted[flowIdx]);
      flowIdx += 1;
    }
    if (point.date === startDate) {
      return { date: point.date, mwrrPct: 0 };
    }
    const irrFlows = [...activeFlows, { date: point.date, amount: point.value }];
    const rate = computeXIRR(irrFlows);
    return { date: point.date, mwrrPct: rate !== null ? rate * 100 : 0 };
  });
};

export const calculateHistoricalPerformance = (
  transactions: Transaction[],
  instruments: Instrument[],
  prices: PricePoint[],
  monthsBack: number = 60, // Increased default history
  granularity: Granularity = 'monthly'
): {
  history: PerformancePoint[],
  assetHistory: Record<string, { date: string, pct: number }[]>,
  currencyHistory: Record<string, { date: string, pct: number }[]>,
  priceFillMeta?: PriceFillMeta
} => {

  const uniqueInstruments = Array.from(
    new Map(instruments.map(inst => [inst.id || getInstrumentKey(inst), inst])).values()
  );
  const canonicalByTicker = new Map(uniqueInstruments.map(inst => [getInstrumentKey(inst), getCanonicalTicker(inst)]));
  const instrumentByKey = new Map(uniqueInstruments.map(inst => [getInstrumentKey(inst), inst]));
  void monthsBack;

  const history: PerformancePoint[] = [];
  const assetHistory: Record<string, { date: string, pct: number }[]> = {};
  const currencyHistory: Record<string, { date: string, pct: number }[]> = {};
  const txPriceMap = buildTxPriceMap(transactions);
  let priceFillMeta: PriceFillMeta | undefined;

  Object.values(AssetType).forEach(t => assetHistory[t] = []);
  Object.values(Currency).forEach(c => currencyHistory[c] = []);

  if (transactions.length === 0) {
    return { history, assetHistory, currencyHistory, priceFillMeta };
  }

  const bounds = getPortfolioDateBounds(transactions, prices, instruments);
  if (!bounds.effectiveStartDate) {
    return { history, assetHistory, currencyHistory, priceFillMeta };
  }

  const today = new Date();
  const lastPriceDate = bounds.lastPriceDate ? toDateSafe(bounds.lastPriceDate) : null;
  let end = lastPriceDate && lastPriceDate <= today ? lastPriceDate : today;
  let start = toDateSafe(bounds.effectiveStartDate);
  if (granularity === 'monthly') {
    start = startOfMonth(start);
  }
  if (end < start) end = start;

  const externalFlows = buildExternalFlows(transactions, granularity);
  const trackCash = transactions.some(t => t.type === TransactionType.Deposit || t.type === TransactionType.Withdrawal);

  if (granularity === 'monthly') {
    const months = eachMonthOfInterval({ start, end });
    const dateIndex = months.map(date => format(endOfMonth(date), 'yyyy-MM-dd'));
  const priceTickers = Array.from(
    new Set(uniqueInstruments.map(inst => canonicalByTicker.get(getInstrumentKey(inst)) || getInstrumentKey(inst)))
  ).filter(Boolean);
    const fillResult = fillMissingPrices(prices, dateIndex, { tickers: priceTickers });
    const filledByTicker = fillResult.filledByTicker;
    priceFillMeta = fillResult.meta;

    months.forEach((date, idx) => {
      void date;
      const dateStr = dateIndex[idx];

      const txUntilNow = transactions.filter(t => {
        const d = toDateSafe(t.date);
        return isValid(d) && format(d, 'yyyy-MM-dd') <= dateStr;
      });

      const holdingsMap = new Map<string, number>();
      let investedAtDate = 0;
      let cashAtDate = 0;

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

        if (trackCash) {
          if (t.type === TransactionType.Buy) cashAtDate -= (qty * price) + fees;
          if (t.type === TransactionType.Sell) cashAtDate += (qty * price) - fees;
          if (t.type === TransactionType.Deposit) cashAtDate += (t.quantity || 0);
          if (t.type === TransactionType.Withdrawal) cashAtDate -= (t.quantity || 0);
          if (t.type === TransactionType.Dividend) cashAtDate += (t.quantity || 0);
          if (t.type === TransactionType.Fee) cashAtDate -= (fees || 0);
        }
      });

      let totalValueAtDate = 0;
      const assetValues: Record<string, number> = {};
      const currencyValues: Record<string, number> = {};
      const backfilledPriceSet = new Set<string>();

      holdingsMap.forEach((qty, ticker) => {
        if (qty <= 0.000001) return;
        const priceTicker = canonicalByTicker.get(ticker) || ticker;
        const filled = filledByTicker.get(priceTicker)?.get(dateStr);
        let price = filled?.close;
        let isBackfilled = Boolean(filled?.synthetic);
        if (price === undefined) {
          const txArr = txPriceMap.get(ticker);
          const latestTx = txArr?.find(tx => tx.dateStr <= dateStr);
          if (latestTx) {
            price = latestTx.price;
            isBackfilled = true;
          }
        }
        if (price === undefined || price <= 0) return;
        const val = qty * price;
        totalValueAtDate += val;

        const instr = instrumentByKey.get(ticker);
        if (instr) {
          assetValues[instr.type] = (assetValues[instr.type] || 0) + val;
          currencyValues[instr.currency] = (currencyValues[instr.currency] || 0) + val;
        }
        if (isBackfilled) {
          backfilledPriceSet.add(priceTicker);
        }
      });

      const navValue = totalValueAtDate + (trackCash ? cashAtDate : 0);
      const cumulativeReturnPct = investedAtDate > 0 ? ((navValue / investedAtDate) - 1) * 100 : 0;

      let periodReturn = 0;
      if (idx > 0 && history[idx - 1].value > 0) {
        periodReturn = ((navValue / history[idx - 1].value) - 1) * 100;
      }

      const prevTWRRIndex = idx > 0 ? (history[idx - 1].cumulativeTWRRIndex || 1) : 1;
      const currentTWRRIndex = prevTWRRIndex * (1 + (periodReturn / 100));

      history.push({
        date: dateStr,
        value: navValue,
        invested: investedAtDate,
        monthlyReturnPct: periodReturn,
        cumulativeReturnPct: cumulativeReturnPct,
        cumulativeTWRRIndex: currentTWRRIndex,
        backfilledPriceTickers: Array.from(backfilledPriceSet)
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

    const twrrHistory = computeTWRRFromNav(history, externalFlows);
    return { history: twrrHistory, assetHistory, currencyHistory, priceFillMeta };
  }

  // DAILY PATH
  const days = eachDayOfInterval({ start, end });
  const dateIndex = days.map(d => format(d, 'yyyy-MM-dd'));

  const priceTickers = Array.from(
    new Set(uniqueInstruments.map(instr => canonicalByTicker.get(getInstrumentKey(instr)) || getInstrumentKey(instr)))
  ).filter(Boolean);
  const fillResult = fillMissingPrices(prices, dateIndex, { tickers: priceTickers });
  const filledByTicker = fillResult.filledByTicker;
  priceFillMeta = fillResult.meta;

  const runningQty = new Map<string, number>();
  let investedRunning = 0;
  let cashRunning = 0;
  const startDateStr = format(start, 'yyyy-MM-dd');

  const applyTransactionToRunning = (t: Transaction) => {
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
      if (trackCash) cashRunning -= (qty * price) + fees;
    }
    if (t.type === TransactionType.Sell) {
      investedRunning -= ((qty * price) - fees);
      if (trackCash) cashRunning += (qty * price) - fees;
    }
    if (t.type === TransactionType.Deposit) {
      investedRunning += (t.quantity || 0);
      if (trackCash) cashRunning += (t.quantity || 0);
    }
    if (t.type === TransactionType.Withdrawal) {
      investedRunning -= (t.quantity || 0);
      if (trackCash) cashRunning -= (t.quantity || 0);
    }
    if (t.type === TransactionType.Dividend) {
      if (trackCash) cashRunning += (t.quantity || 0);
    }
    if (t.type === TransactionType.Fee) {
      if (trackCash) cashRunning -= fees;
    }
  };

  transactions.forEach(t => {
    const tDateStr = toDateString(t.date);
    if (tDateStr < startDateStr) applyTransactionToRunning(t);
  });

  dateIndex.forEach((dateStr, idx) => {
    // apply transactions for the day (all tickers)
    transactions.forEach(t => {
      const tDateStr = toDateString(t.date);
      if (tDateStr !== dateStr) return;
      applyTransactionToRunning(t);
    });

    let totalValueAtDate = 0;
    const assetValues: Record<string, number> = {};
    const currencyValues: Record<string, number> = {};
    const backfilledPriceSet = new Set<string>();

    uniqueInstruments.forEach(instr => {
      const instrumentKey = getInstrumentKey(instr);
      const priceTicker = canonicalByTicker.get(instrumentKey) || instrumentKey;
      const qty = runningQty.get(instrumentKey) || 0;
      if (qty <= 0.000001) return;

      const filled = filledByTicker.get(priceTicker)?.get(dateStr);
      let price = filled?.close;
      let isBackfilled = Boolean(filled?.synthetic);
      if (price === undefined) {
        const txArr = txPriceMap.get(instrumentKey);
        const latestTx = txArr?.find(tx => tx.dateStr <= dateStr);
        if (latestTx) {
          price = latestTx.price;
          isBackfilled = true;
        }
      }
      if (price === undefined || price <= 0) return;
      const val = qty * price;
      totalValueAtDate += val;
      assetValues[instr.type] = (assetValues[instr.type] || 0) + val;
      currencyValues[instr.currency] = (currencyValues[instr.currency] || 0) + val;
      if (isBackfilled) {
        backfilledPriceSet.add(priceTicker);
      }
    });

    const nav = totalValueAtDate + (trackCash ? cashRunning : 0);

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
      cumulativeTWRRIndex: currentTWRRIndex,
      backfilledPriceTickers: Array.from(backfilledPriceSet)
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

  const twrrHistory = computeTWRRFromNav(history, externalFlows);
  return { history: twrrHistory, assetHistory, currencyHistory, priceFillMeta };
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

  const getIndex = (p: PerformancePoint) => p.cumulativeTWRRIndex && p.cumulativeTWRRIndex > 0
    ? p.cumulativeTWRRIndex
    : (p.value > 0 ? p.value : 0);

  const buildPeriodReturns = (points: PerformancePoint[]) => {
    const returns: number[] = [];
    for (let i = 1; i < points.length; i++) {
      const prevIdx = getIndex(points[i - 1]);
      const currIdx = getIndex(points[i]);
      if (prevIdx > 0 && currIdx > 0) {
        returns.push((currIdx / prevIdx) - 1);
      }
    }
    return returns;
  };

  // 1. Annual Returns (calendar-year performance)
  const yearlyRanges: Record<number, { start: PerformancePoint; end: PerformancePoint }> = {};
  history.forEach(point => {
    const year = getYear(new Date(point.date));
    if (!yearlyRanges[year]) {
      yearlyRanges[year] = { start: point, end: point };
    } else {
      yearlyRanges[year].end = point;
    }
  });

  const annualReturns = Object.entries(yearlyRanges)
    .map(([year, range]) => {
      const startIdx = getIndex(range.start);
      const endIdx = getIndex(range.end);
      const returnPct = startIdx > 0 ? ((endIdx / startIdx) - 1) * 100 : 0;
      return { year: parseInt(year, 10), returnPct };
    })
    .sort((a, b) => a.year - b.year);

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
  const firstPoint = history.find(h => getIndex(h) > 0) || history[0];

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
  const startIndex = getIndex(firstPoint);
  const endIndex = getIndex(lastPoint);

  if (granularity === 'daily') {
    const returns = buildPeriodReturns(history);
    const mean = returns.reduce((a, b) => a + b, 0) / (returns.length || 1);
    const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (returns.length || 1);
    const stdDaily = Math.sqrt(variance);
    stdDevAnnualized = stdDaily * Math.sqrt(252);

    const days = diffDaysYmd(lastPoint.date, firstPoint.date) || 1;
    annualizedReturn = startIndex > 0
      ? Math.pow(endIndex / startIndex, 365.25 / days) - 1
      : 0;

    const rf = 0.02;
    sharpeRatio = stdDevAnnualized > 0 ? ((mean * 252) - rf) / stdDevAnnualized : 0;
  } else {
    const monthsCount = history.filter(h => h.value > 0).length;
    const totalTWRRGrowth = startIndex > 0 ? (endIndex / startIndex) : 1;
    const years = monthsCount / 12;
    annualizedReturn = years > 0
      ? Math.pow(totalTWRRGrowth, 1 / years) - 1
      : 0;

    const returns = buildPeriodReturns(history);
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
    const stdDevMonthly = Math.sqrt(variance);
    stdDevAnnualized = stdDevMonthly * Math.sqrt(12);

    const rf = 0.02;
    sharpeRatio = stdDevAnnualized > 0 ? (annualizedReturn - rf) / stdDevAnnualized : 0;
  }

  return {
    annualReturns,
    maxDrawdown: maxDrawdown * 100,
    drawdownSeries,
    annualizedReturn: annualizedReturn * 100,
    stdDev: stdDevAnnualized * 100,
    sharpeRatio
  };
};

export const downsampleHistoryToMonthly = (history: PerformancePoint[]): PerformancePoint[] => {
  if (!history.length) return [];
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const map = new Map<string, PerformancePoint>();
  sorted.forEach(point => {
    const key = point.date.slice(0, 7);
    map.set(key, point);
  });
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
};

export const calculateRebalancing = (
  positions: PortfolioPosition[],
  totalPortfolioValue: number,
  strategy: string,
  cashInjection: number
) => {

  const effectiveTotal = totalPortfolioValue + (strategy === 'Accumulate' ? cashInjection : 0);
  const threshold = effectiveTotal * 0.01;

  const baseRows = positions.map(p => {
    const targetValue = effectiveTotal * (p.targetPct / 100);
    const currentValue = p.currentValueCHF;
    const diff = targetValue - currentValue;

    let action = 'NEUTRO';
    if (p.targetPct === 0 && p.quantity > 0) action = 'VENDI'; // Exit position
    else {
      if (diff > threshold) action = 'COMPRA';
      else if (diff < -threshold) action = 'VENDI';
    }

    if (strategy === 'Accumulate' && action === 'VENDI') action = 'NEUTRO'; // Only buys

    return { p, diff, action };
  });

  let buyScale = 1;
  if (strategy === 'Accumulate' && cashInjection > 0) {
    const totalBuyDiff = baseRows
      .filter(row => row.action === 'COMPRA')
      .reduce((sum, row) => sum + Math.max(0, row.diff), 0);
    if (totalBuyDiff > 0) {
      buyScale = Math.min(1, cashInjection / totalBuyDiff);
    }
  }

  return baseRows.map(({ p, diff, action }) => {
    const scaledDiff = action === 'COMPRA' ? diff * buyScale : diff;
    const absAmount = action === 'NEUTRO' ? 0 : Math.abs(scaledDiff);
    return {
      ticker: p.ticker,
      name: p.name,
      action,
      amount: absAmount,
      quantity: absAmount > 0 && p.currentPrice > 0 ? absAmount / p.currentPrice : 0,
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
  if (prefix === 'GB') return 'EU'; // UK -> Europa per semplicita
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
  const instByTicker = new Map(instruments.map(i => [getInstrumentKey(i), i]));
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
  const instByTicker = new Map(instruments.map(i => [getInstrumentKey(i), i]));
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


