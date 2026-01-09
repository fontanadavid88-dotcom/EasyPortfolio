import { InstrumentListing, Currency } from '../types';

export const pickDefaultListing = (
  listings: InstrumentListing[],
  preferredExchangesOrder: string[],
  baseCurrency: Currency
): InstrumentListing | null => {
  if (listings.length === 0) return null;
  // Priorità per exchange
  for (const ex of preferredExchangesOrder) {
    const found = listings.find(l => l.exchangeCode.toUpperCase() === ex.toUpperCase());
    if (found) return found;
  }
  // Se currency base matcha
  const currencyMatch = listings.find(l => l.currency === baseCurrency);
  if (currencyMatch) return currencyMatch;
  return listings[0];
};

const isUcits = (isin: string) => isin.startsWith('IE') || isin.startsWith('LU');
const isUs = (isin: string) => isin.startsWith('US');

export const pickRecommendedListings = (
  listings: InstrumentListing[],
  isin: string,
  preferredExchangesOrder: string[],
  baseCurrency: Currency
): { recommended: InstrumentListing[]; others: InstrumentListing[] } => {
  const rec: InstrumentListing[] = [];
  const remaining = [...listings];

  const getAndRemove = (predicate: (l: InstrumentListing) => boolean) => {
    const idx = remaining.findIndex(predicate);
    if (idx >= 0) {
      const item = remaining.splice(idx, 1)[0];
      rec.push(item);
    }
  };

  // A) SW
  if (preferredExchangesOrder.includes('SW') || baseCurrency === Currency.CHF) {
    getAndRemove(l => l.exchangeCode.toUpperCase() === 'SW');
  }

  // B) Primary listing
  if (isUs(isin)) {
    getAndRemove(l => ['US', 'NYSE', 'NASDAQ'].includes(l.exchangeCode.toUpperCase()));
  } else if (isUcits(isin)) {
    getAndRemove(l => ['LSE', 'XLON', 'L'].includes(l.exchangeCode.toUpperCase()));
    if (rec.length < 2) {
      getAndRemove(l => ['XETRA', 'XETR'].includes(l.exchangeCode.toUpperCase()));
    }
  }

  // C) Alt liquidity / base currency
  getAndRemove(l => l.currency === baseCurrency);
  if (rec.length < 3) {
    const majors = ['US', 'LSE', 'XETRA', 'PA', 'MI'];
    getAndRemove(l => majors.includes(l.exchangeCode.toUpperCase()));
  }

  // fill up to 3
  while (rec.length < 3 && remaining.length > 0) {
    rec.push(remaining.shift() as InstrumentListing);
  }

  const uniqueRec = Array.from(new Map(rec.map(r => [r.symbol, r])).values());
  const others = remaining.filter(r => !uniqueRec.some(u => u.symbol === r.symbol));
  return { recommended: uniqueRec, others };
};
