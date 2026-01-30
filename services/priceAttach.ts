import { Currency, InstrumentListing, PriceTickerConfig } from '../types';
import { pickDefaultListing } from './listingService';

export type AutoAttachPlan = {
  preferredListing?: InstrumentListing;
  listings?: InstrumentListing[];
  warning?: string;
};

const normalizeSymbol = (value: string) => value.trim().toUpperCase();
const hasExplicitSuffix = (value: string) => normalizeSymbol(value).includes('.');

const dedupeListings = (listings: InstrumentListing[]) => {
  return Array.from(new Map(listings.map(l => [l.symbol, l])).values());
};

export const planAutoAttachListing = (params: {
  typedTicker: string;
  listings: InstrumentListing[];
  preferredExchangesOrder: string[];
  baseCurrency: Currency;
  confirmOverride?: (message: string) => boolean;
}): AutoAttachPlan => {
  const { typedTicker, listings, preferredExchangesOrder, baseCurrency, confirmOverride } = params;
  if (listings.length === 0) {
    return { warning: 'Nessun listing trovato per questo ISIN.' };
  }

  const selected = pickDefaultListing(listings, preferredExchangesOrder, baseCurrency);
  if (!selected) {
    return { warning: 'Nessun listing valido trovato.' };
  }

  const normalizedTicker = normalizeSymbol(typedTicker);
  if (normalizedTicker && hasExplicitSuffix(normalizedTicker) && normalizeSymbol(selected.symbol) !== normalizedTicker) {
    const confirm = confirmOverride
      ? confirmOverride(`Il ticker inserito (${normalizedTicker}) è diverso dal listing consigliato (${selected.symbol}). Vuoi usare ${selected.symbol} per i prezzi?`)
      : false;
    if (!confirm) {
      return { warning: 'Listing non applicato: ticker già specificato.' };
    }
  }

  return {
    preferredListing: selected,
    listings: dedupeListings(listings)
  };
};

export const buildPriceTickerConfigWithDefault = (
  existing: Record<string, PriceTickerConfig> | undefined,
  ticker: string,
  defaults: PriceTickerConfig
): { config: Record<string, PriceTickerConfig>; changed: boolean } => {
  const trimmed = ticker.trim();
  const current = existing || {};
  if (!trimmed) {
    return { config: current, changed: false };
  }
  if (current[trimmed]) {
    return { config: current, changed: false };
  }
  return {
    config: {
      ...current,
      [trimmed]: defaults
    },
    changed: true
  };
};
