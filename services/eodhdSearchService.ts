import { InstrumentListing, Currency } from '../types';
import { asCurrency, asString, normalizeIsin } from './symbolUtils';

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

const buildProxyUrl = (path: string, params: Record<string, string>) => {
  const search = new URLSearchParams({ path });
  Object.entries(params).forEach(([key, value]) => {
    if (value) search.append(key, value);
  });
  return `/api/eodhd-proxy?${search.toString()}`;
};

const fetchEodhdJson = async (path: string, params: Record<string, string>, apiKey?: string): Promise<unknown> => {
  const url = buildProxyUrl(path, params);
  const headers = apiKey?.trim() ? { 'x-eodhd-key': apiKey.trim() } : undefined;
  try {
    const res = await fetch(url, headers ? { headers } : undefined);
    if (!res.ok) {
      const msg = await res.text();
      throw new Error(msg || 'Impossibile raggiungere proxy API');
    }
    return await res.json();
  } catch (e) {
    if (e instanceof TypeError) {
      throw new Error('Impossibile raggiungere proxy API');
    }
    throw e;
  }
};

const readField = (obj: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = asString(obj[key]);
    if (value) return value;
  }
  return '';
};

const toListing = (raw: unknown, expectedIsin?: string): InstrumentListing | null => {
  if (!isRecord(raw)) return null;
  const isinRaw = readField(raw, ['ISIN', 'Isin', 'isin']);
  if (expectedIsin && isinRaw) {
    const normalized = normalizeIsin(isinRaw);
    if (normalized && normalized !== expectedIsin) return null;
  }
  const code = readField(raw, ['Code', 'code', 'Symbol', 'symbol', 'ticker', 'Ticker']);
  const exchange = readField(raw, ['Exchange', 'exchange', 'MIC', 'mic']);
  const name = readField(raw, ['Name', 'name']);
  const type = readField(raw, ['Type', 'type']);
  const currency = asCurrency(raw.Currency ?? raw.currency) || Currency.USD;

  const codeUpper = code.toUpperCase();
  const exchangeUpper = exchange.toUpperCase();
  let symbol = codeUpper;
  if (symbol && !symbol.includes('.') && exchangeUpper) {
    symbol = `${symbol}.${exchangeUpper}`;
  }
  const exchangeCode = exchangeUpper || (symbol.includes('.') ? symbol.split('.').pop() || '' : '');
  if (!symbol || !exchangeCode) return null;

  return {
    exchangeCode,
    symbol,
    currency,
    name: name || undefined,
    type: type || undefined
  };
};

const dedupeListings = (listings: InstrumentListing[]) => {
  return Array.from(new Map(listings.map(l => [l.symbol, l])).values());
};

// Risoluzione listing da ISIN usando EODHD Search API
export const resolveListingsByIsin = async (isin: string, apiKey?: string): Promise<InstrumentListing[]> => {
  const normalized = normalizeIsin(isin);
  const data = await fetchEodhdJson(`/api/search/${encodeURIComponent(normalized)}`, { fmt: 'json' }, apiKey);
  if (!Array.isArray(data)) return [];
  const listings = data.map(item => toListing(item, normalized)).filter(Boolean) as InstrumentListing[];
  return dedupeListings(listings);
};

export const resolveEodhdSymbolFromIsin = async (isin: string, apiKey?: string): Promise<InstrumentListing[]> => {
  const normalized = normalizeIsin(isin);
  let listings: InstrumentListing[] = [];
  try {
    const mappingData = await fetchEodhdJson('/api/id-mapping', { 'filter[isin]': normalized, fmt: 'json' }, apiKey);
    if (Array.isArray(mappingData)) {
      listings = mappingData.map(item => toListing(item, normalized)).filter(Boolean) as InstrumentListing[];
    }
  } catch (e) {
    console.warn('EODHD id-mapping error', e);
  }
  if (listings.length > 0) return dedupeListings(listings);

  const searchData = await fetchEodhdJson(`/api/search/${encodeURIComponent(normalized)}`, { fmt: 'json' }, apiKey);
  if (!Array.isArray(searchData)) return [];
  listings = searchData.map(item => toListing(item, normalized)).filter(Boolean) as InstrumentListing[];
  return dedupeListings(listings);
};
