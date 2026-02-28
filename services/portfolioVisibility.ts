const buildHiddenKey = (portfolioId: string) => `hiddenTickers.${portfolioId}`;

const safeParseList = (raw: string | null): string[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter(Boolean);
  } catch {
    return [];
  }
  return [];
};

const unique = (list: string[]) => Array.from(new Set(list.filter(Boolean)));

export const getHiddenTickersForPortfolio = (portfolioId: string): string[] => {
  if (typeof localStorage === 'undefined') return [];
  return safeParseList(localStorage.getItem(buildHiddenKey(portfolioId)));
};

export const setHiddenTickersForPortfolio = (portfolioId: string, tickers: string[]) => {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(buildHiddenKey(portfolioId), JSON.stringify(unique(tickers)));
};

export const addHiddenTicker = (portfolioId: string, ticker: string) => {
  if (!ticker) return;
  const next = unique([...getHiddenTickersForPortfolio(portfolioId), ticker]);
  setHiddenTickersForPortfolio(portfolioId, next);
};

export const removeHiddenTicker = (portfolioId: string, ticker: string) => {
  if (!ticker) return;
  const next = getHiddenTickersForPortfolio(portfolioId).filter(t => t !== ticker);
  setHiddenTickersForPortfolio(portfolioId, next);
};

export const removeHiddenTickerEverywhere = (ticker: string) => {
  if (typeof localStorage === 'undefined') return;
  if (!ticker) return;
  const keys = Object.keys(localStorage).filter(key => key.startsWith('hiddenTickers.'));
  keys.forEach(key => {
    const next = safeParseList(localStorage.getItem(key)).filter(t => t !== ticker);
    localStorage.setItem(key, JSON.stringify(unique(next)));
  });
};
