import { AssetType, Currency } from '../types';

export const ISIN_REGEX = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
export const EODHD_SYMBOL_REGEX = /^[A-Z0-9-]+\.[A-Z0-9]+$/;

export const normalizeIsin = (value: string) => value.toUpperCase().replace(/\s+/g, '');
export const normalizeTicker = (value: string) => value.trim().toUpperCase();

export const isIsin = (value: string) => ISIN_REGEX.test(normalizeIsin(value));

export const normalizeCryptoSymbol = (value: string) => {
  const normalized = normalizeTicker(value);
  if (!normalized) return normalized;
  if (normalized.includes('.')) return normalized;
  if (/^[A-Z0-9-]+$/.test(normalized) && normalized.includes('-')) {
    return `${normalized}.CC`;
  }
  return normalized;
};

export const hasExchangeSuffix = (value: string) => EODHD_SYMBOL_REGEX.test(normalizeTicker(value));

export const resolveEodhdSymbol = (value: string, assetType?: AssetType): string => {
  if (assetType === AssetType.Crypto) {
    return normalizeCryptoSymbol(value);
  }
  return normalizeTicker(value);
};

export const isValidEodhdSymbol = (value: string, assetType?: AssetType): boolean => {
  const resolved = resolveEodhdSymbol(value, assetType);
  return EODHD_SYMBOL_REGEX.test(resolved);
};

export const asCurrency = (value: unknown): Currency | undefined => {
  const str = typeof value === 'string' ? value.toUpperCase() : '';
  if (str === 'CHF' || str === 'EUR' || str === 'USD' || str === 'GBP') {
    return str as Currency;
  }
  return undefined;
};

export const asString = (value: unknown) => {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
};
