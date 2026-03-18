import { AssetClass, AssetType, Instrument } from '../types';

const CRYPTO_TICKER_HINTS = ['BTC', 'ETH', 'SOL', 'ADA', 'XRP', 'DOT', 'BNB', 'LTC', 'DOGE', 'AVAX', 'LINK'];

const isLikelyCryptoTicker = (ticker?: string) => {
  if (!ticker) return false;
  const tokens = ticker.toUpperCase().split(/[^A-Z0-9]/).filter(Boolean);
  return tokens.some(token => CRYPTO_TICKER_HINTS.includes(token));
};

const resolveQuantityDecimals = (instrument?: Instrument, ticker?: string) => {
  const override = instrument?.tradePrecisionDecimals;
  if (typeof override === 'number' && Number.isFinite(override) && override >= 0) {
    return Math.floor(override);
  }
  const isCrypto = instrument?.assetClass === AssetClass.CRYPTO
    || instrument?.type === AssetType.Crypto
    || isLikelyCryptoTicker(ticker ?? instrument?.ticker);
  return isCrypto ? 6 : 0;
};

export const formatQuantity = (value: number, instrument?: Instrument, ticker?: string) => {
  if (!Number.isFinite(value)) return '—';
  const decimals = resolveQuantityDecimals(instrument, ticker);
  return new Intl.NumberFormat('it-CH', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals
  }).format(value);
};
