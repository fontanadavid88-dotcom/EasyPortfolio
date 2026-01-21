import { InstrumentListing, Currency } from '../types';

// Risoluzione listing da ISIN usando EODHD Search API
export const resolveListingsByIsin = async (isin: string): Promise<InstrumentListing[]> => {
  const url = `/api/eodhd/api/search/${encodeURIComponent(isin)}?fmt=json`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const msg = await res.text();
      throw new Error(msg || 'Impossibile raggiungere proxy API');
    }
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
    if (e instanceof TypeError) {
      throw new Error('Impossibile raggiungere proxy API');
    }
    throw e;
  }
};
