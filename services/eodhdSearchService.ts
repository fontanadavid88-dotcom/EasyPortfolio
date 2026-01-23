import { InstrumentListing, Currency } from '../types';

// Risoluzione listing da ISIN usando EODHD Search API
export const resolveListingsByIsin = async (isin: string, apiKey?: string): Promise<InstrumentListing[]> => {
  const params = new URLSearchParams({ path: `/api/search/${encodeURIComponent(isin)}`, fmt: 'json' });
  const url = `/api/eodhd-proxy?${params.toString()}`;
  try {
    const headers = apiKey?.trim() ? { 'x-eodhd-key': apiKey.trim() } : undefined;
    const res = await fetch(url, headers ? { headers } : undefined);
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
