import { InstrumentListing, Currency } from '../types';

// Risoluzione listing da ISIN usando EODHD Search API
export const resolveListingsByIsin = async (isin: string, apiKey: string): Promise<InstrumentListing[]> => {
  if (!apiKey) return [];
  const url = `https://eodhd.com/api/search/${isin}?api_token=${apiKey}&fmt=json`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data
      .filter((d: any) => d.Isin === isin || d.Code === isin || (d.ISIN && d.ISIN === isin))
      .map((d: any) => ({
        exchangeCode: (d.Exchange || '').toUpperCase(),
        symbol: d.Code,
        currency: (d.Currency || 'USD') as Currency,
        name: d.Name,
        type: d.Type
      }));
  } catch (e) {
    console.error('EODHD search error', e);
    return [];
  }
};
