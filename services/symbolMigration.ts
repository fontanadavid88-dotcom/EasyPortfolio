import { db, getCurrentPortfolioId } from '../db';
import { AppSettings, AssetType, Currency, Instrument, InstrumentListing, PriceTickerConfig } from '../types';
import { pickDefaultListing } from './listingService';
import { resolveEodhdSymbolFromIsin } from './eodhdSearchService';
import { isIsin, normalizeIsin, normalizeTicker, resolveEodhdSymbol } from './symbolUtils';

const MIGRATION_KEY_PREFIX = 'symbol_migration_v1';
const DEFAULT_EXCHANGES = ['SW', 'US', 'LSE', 'XETRA', 'MI', 'PA'];

const extractIsinFromTicker = (ticker: string): string | null => {
  const normalized = normalizeTicker(ticker);
  if (isIsin(normalized)) return normalized;
  const parts = normalized.split('.');
  if (parts.length > 1 && isIsin(parts[0])) return parts[0];
  return null;
};

const setConfigEntry = (
  config: Record<string, PriceTickerConfig>,
  ticker: string,
  patch: PriceTickerConfig
): { config: Record<string, PriceTickerConfig>; changed: boolean } => {
  const current = config[ticker] || {};
  const next = { ...current, ...patch };
  const changed = JSON.stringify(current) !== JSON.stringify(next);
  return { config: { ...config, [ticker]: next }, changed };
};

const markNeedsMapping = (
  config: Record<string, PriceTickerConfig>,
  ticker: string
): { config: Record<string, PriceTickerConfig>; changed: boolean } => {
  const current = config[ticker] || {};
  if (current.needsMapping) return { config, changed: false };
  return setConfigEntry(config, ticker, {
    provider: current.provider || 'EODHD',
    needsMapping: true
  });
};

export const runSymbolMigrationOnce = async (portfolioOverride?: string) => {
  const portfolioId = portfolioOverride || getCurrentPortfolioId();
  const storageKey = `${MIGRATION_KEY_PREFIX}:${portfolioId}`;
  if (typeof localStorage !== 'undefined' && localStorage.getItem(storageKey)) return;

  const settings = await db.settings.where('portfolioId').equals(portfolioId).first();
  if (!settings) {
    if (typeof localStorage !== 'undefined') localStorage.setItem(storageKey, new Date().toISOString());
    return;
  }

  const instruments = await db.instruments.where('portfolioId').equals(portfolioId).toArray();
  const instrumentsByTicker = new Map<string, Instrument>();
  instruments.forEach(inst => {
    if (inst.ticker) instrumentsByTicker.set(inst.ticker, inst);
  });

  const config: Record<string, PriceTickerConfig> = { ...(settings.priceTickerConfig || {}) };
  const allTickers = new Set<string>(Object.keys(config));
  instruments.forEach(inst => inst.ticker && allTickers.add(inst.ticker));

  const txs = await db.transactions.where('portfolioId').equals(portfolioId).toArray();
  txs.forEach(tx => tx.instrumentTicker && allTickers.add(tx.instrumentTicker));

  const prices = await db.prices.where('portfolioId').equals(portfolioId).toArray();
  prices.forEach(p => p.ticker && allTickers.add(p.ticker));

  let configChanged = false;
  const exchanges = settings.preferredExchangesOrder || DEFAULT_EXCHANGES;
  const baseCurrency = settings.baseCurrency || Currency.CHF;

  for (const ticker of allTickers) {
    const instrument = instrumentsByTicker.get(ticker);
    const currentCfg = config[ticker] || {};

    if (currentCfg.exclude) continue;
    if (currentCfg.eodhdSymbol && !currentCfg.needsMapping) continue;

    if (instrument?.type === AssetType.Crypto) {
      const resolved = resolveEodhdSymbol(ticker, AssetType.Crypto);
      if (resolved && resolved !== normalizeTicker(ticker)) {
        const updated = setConfigEntry(config, ticker, {
          provider: currentCfg.provider || 'EODHD',
          eodhdSymbol: resolved,
          needsMapping: false
        });
        configChanged = configChanged || updated.changed;
        Object.assign(config, updated.config);
      }
      continue;
    }

    const extractedIsin = extractIsinFromTicker(ticker);
    if (!extractedIsin) continue;

    const normalizedIsin = instrument?.isin ? normalizeIsin(instrument.isin) : extractedIsin;
    if (instrument?.id && normalizedIsin && normalizedIsin !== instrument.isin) {
      await db.instruments.update(instrument.id, { isin: normalizedIsin });
    }

    let selected: InstrumentListing | undefined;
    try {
      const candidates = await resolveEodhdSymbolFromIsin(normalizedIsin, settings.eodhdApiKey);
      if (candidates.length > 0) {
        selected = pickDefaultListing(candidates, exchanges, baseCurrency) || candidates[0];
      }
    } catch (e) {
      console.warn('[symbol-migration] ISIN resolve failed', { ticker, isin: normalizedIsin, error: e });
    }

    if (selected?.symbol) {
      const updated = setConfigEntry(config, ticker, {
        provider: currentCfg.provider || 'EODHD',
        eodhdSymbol: selected.symbol,
        needsMapping: false
      });
      configChanged = configChanged || updated.changed;
      Object.assign(config, updated.config);
    } else {
      const flagged = markNeedsMapping(config, ticker);
      configChanged = configChanged || flagged.changed;
      Object.assign(config, flagged.config);
    }
  }

  if (configChanged) {
    await db.settings.put({ ...settings, priceTickerConfig: config } as AppSettings);
  }

  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(storageKey, new Date().toISOString());
  }
};

export const resetSymbolMigrationFlag = () => {
  const portfolioId = getCurrentPortfolioId();
  const storageKey = `${MIGRATION_KEY_PREFIX}:${portfolioId}`;
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(storageKey);
  }
};
