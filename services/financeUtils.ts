import { Transaction, TransactionType, Instrument, PricePoint, PortfolioState, PortfolioPosition, PerformancePoint, AssetType, Currency } from '../types';
import { format, startOfMonth, endOfMonth, eachMonthOfInterval, subMonths, isValid } from 'date-fns';

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

// Helper to get price at specific date
const getPriceAtDate = (ticker: string, dateStr: string, prices: PricePoint[]): number => {
  // Filter prices for ticker and find the latest one on or before dateStr
  const relevantPrices = prices
    .filter(p => p.ticker === ticker && p.date <= dateStr)
    .sort((a, b) => b.date.localeCompare(a.date));
  
  return relevantPrices.length > 0 ? relevantPrices[0].close : 0;
};

// --- CORE PORTFOLIO LOGIC ---

export const calculatePortfolioState = (
  transactions: Transaction[], 
  instruments: Instrument[], 
  prices: PricePoint[]
): PortfolioState => {
  
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

  instruments.forEach(inst => {
    const qty = holdingsMap.get(inst.ticker) || 0;
    // Handle floating point dust
    if (qty > 0.000001) { 
      const currentPrice = getPriceAtDate(inst.ticker, todayStr, prices);
      // NOTE: Here we assume Price is in Base Currency or converted. 
      // For MVP, if currency matches app base currency, use as is. 
      // A full Forex implementation would convert here.
      const val = qty * currentPrice; 
      totalValue += val;

      positions.push({
        ticker: inst.ticker,
        name: inst.name,
        assetType: inst.type,
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

export const calculateHistoricalPerformance = (
  transactions: Transaction[],
  instruments: Instrument[],
  prices: PricePoint[],
  monthsBack: number = 12
): { 
  history: PerformancePoint[], 
  assetHistory: Record<string, {date: string, pct: number}[]>,
  currencyHistory: Record<string, {date: string, pct: number}[]>
} => {
  
  const end = new Date();
  const start = subMonths(startOfMonth(end), monthsBack);
  const months = eachMonthOfInterval({ start, end });

  const history: PerformancePoint[] = [];
  const assetHistory: Record<string, {date: string, pct: number}[]> = {};
  const currencyHistory: Record<string, {date: string, pct: number}[]> = {};

  // Initialize History Arrays
  Object.values(AssetType).forEach(t => assetHistory[t] = []);
  Object.values(Currency).forEach(c => currencyHistory[c] = []);

  months.forEach((date, idx) => {
    const dateStr = format(endOfMonth(date), 'yyyy-MM-dd');
    
    // Filter transactions up to this date
    const txUntilNow = transactions.filter(t => {
      const d = toDate(t.date);
      return isValid(d) && format(d, 'yyyy-MM-dd') <= dateStr;
    });
    
    // 1. Reconstruct Holdings at this date
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
    });

    // 2. Calculate Value at this date
    let totalValueAtDate = 0;
    const assetValues: Record<string, number> = {};
    const currencyValues: Record<string, number> = {};

    holdingsMap.forEach((qty, ticker) => {
       if (qty <= 0.000001) return;
       const price = getPriceAtDate(ticker, dateStr, prices);
       const val = qty * price;
       totalValueAtDate += val;

       const instr = instruments.find(i => i.ticker === ticker);
       if (instr) {
         assetValues[instr.type] = (assetValues[instr.type] || 0) + val;
         currencyValues[instr.currency] = (currencyValues[instr.currency] || 0) + val;
       }
    });

    // 3. Performance Metrics
    const performancePct = investedAtDate > 0 ? ((totalValueAtDate / investedAtDate) - 1) * 100 : 0;
    
    // Approximate monthly return
    let monthlyReturn = 0;
    if (idx > 0 && history[idx-1].value > 0) {
        monthlyReturn = ((totalValueAtDate / history[idx-1].value) - 1) * 100;
    }

    history.push({
      date: format(date, 'MMM yy'),
      value: totalValueAtDate,
      invested: investedAtDate,
      monthlyReturnPct: monthlyReturn,
      cumulativeReturnPct: performancePct
    });

    // 4. Record Asset/Currency Allocation
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