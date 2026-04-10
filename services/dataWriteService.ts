import { db } from '../db';
import { Currency, type Instrument, type PricePoint } from '../types';
import type { FxRateRow } from './fxService';
import { format } from 'date-fns';
import { parseYmdLocal } from './dateUtils';

export type NaturalKeyWriteSummary = {
  received: number;
  deduped: number;
  created: number;
  updated: number;
  unchanged: number;
  deletedDuplicates: number;
  written: number;
};

const DEFAULT_PORTFOLIO_ID = 'default';

const normalizePortfolioId = (portfolioId?: string) => portfolioId || DEFAULT_PORTFOLIO_ID;

const normalizeDateKey = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const isoPrefix = raw.match(/^(\d{4}-\d{2}-\d{2})[T\s]/)?.[1];
  if (isoPrefix && /^\d{4}-\d{2}-\d{2}$/.test(isoPrefix)) return isoPrefix;
  const parsed = raw.includes('T')
    ? new Date(raw)
    : raw.includes('-')
      ? parseYmdLocal(raw)
      : new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return format(parsed, 'yyyy-MM-dd');
};

const toPriceKey = (row: Pick<PricePoint, 'portfolioId' | 'ticker' | 'date'>) =>
  `${normalizePortfolioId(row.portfolioId)}|${row.ticker}|${normalizeDateKey(row.date) || row.date}`;

const toFxKey = (row: Pick<FxRateRow, 'baseCurrency' | 'quoteCurrency' | 'date'>) =>
  `${row.baseCurrency}|${row.quoteCurrency}|${normalizeDateKey(row.date) || row.date}`;

const buildInstrumentKeyCandidates = (instrument: Instrument): string[] => {
  const keys = new Set<string>();
  if (instrument.ticker) keys.add(instrument.ticker);
  if (instrument.symbol) keys.add(instrument.symbol);
  if (instrument.preferredListing?.symbol) keys.add(instrument.preferredListing.symbol);
  (instrument.listings || []).forEach(listing => {
    if (listing?.symbol) keys.add(listing.symbol);
  });
  return Array.from(keys.values());
};

const buildInstrumentIdLookup = async (portfolioIds: string[]) => {
  const byPortfolio = new Map<string, Map<string, string>>();
  await Promise.all(portfolioIds.map(async portfolioId => {
    const instruments = await db.instruments.where('portfolioId').equals(portfolioId).toArray();
    const lookup = new Map<string, string>();
    instruments.forEach(instrument => {
      if (instrument.id === undefined || instrument.id === null) return;
      buildInstrumentKeyCandidates(instrument).forEach(key => lookup.set(key, String(instrument.id)));
    });
    byPortfolio.set(portfolioId, lookup);
  }));
  return byPortfolio;
};

const samePriceRow = (a: PricePoint, b: PricePoint) =>
  a.ticker === b.ticker
  && normalizeDateKey(a.date) === normalizeDateKey(b.date)
  && normalizePortfolioId(a.portfolioId) === normalizePortfolioId(b.portfolioId)
  && Number(a.close) === Number(b.close)
  && String(a.currency || '') === String(b.currency || '')
  && String(a.instrumentId || '') === String(b.instrumentId || '');

const sameFxRow = (a: FxRateRow, b: FxRateRow) =>
  a.baseCurrency === b.baseCurrency
  && a.quoteCurrency === b.quoteCurrency
  && normalizeDateKey(a.date) === normalizeDateKey(b.date)
  && Number(a.rate) === Number(b.rate)
  && String(a.source || '') === String(b.source || '');

export const upsertPriceRowsByNaturalKey = async (rows: PricePoint[]): Promise<NaturalKeyWriteSummary> => {
  if (!rows.length) {
    return { received: 0, deduped: 0, created: 0, updated: 0, unchanged: 0, deletedDuplicates: 0, written: 0 };
  }

  const normalizedInput = rows
    .filter(row => row?.ticker && row?.date)
    .map(row => ({
      ...row,
      id: undefined,
      portfolioId: normalizePortfolioId(row.portfolioId),
      date: normalizeDateKey(row.date) || row.date
    }))
    .filter(row => Boolean(row.date));

  const dedupedMap = new Map<string, PricePoint>();
  normalizedInput.forEach(row => {
    dedupedMap.set(toPriceKey(row), row);
  });
  const dedupedRows = Array.from(dedupedMap.values());

  const portfolioIds = Array.from(new Set(dedupedRows.map(row => normalizePortfolioId(row.portfolioId))));
  const instrumentLookupByPortfolio = await buildInstrumentIdLookup(portfolioIds);

  const existingByKey = new Map<string, PricePoint[]>();
  const groups = new Map<string, PricePoint[]>();
  dedupedRows.forEach(row => {
    const groupKey = `${normalizePortfolioId(row.portfolioId)}|${row.ticker}`;
    const list = groups.get(groupKey) || [];
    list.push(row);
    groups.set(groupKey, list);
  });

  await Promise.all(Array.from(groups.entries()).map(async ([groupKey, groupRows]) => {
    const [portfolioId, ticker] = groupKey.split('|');
    const dates = groupRows.map(row => row.date).sort();
    const existing = await db.prices
      .where('[ticker+date]')
      .between([ticker, dates[0]], [ticker, `${dates[dates.length - 1]}\uffff`])
      .and(row => normalizePortfolioId(row.portfolioId) === portfolioId)
      .toArray();
    existing.forEach(row => {
      const key = toPriceKey(row);
      const list = existingByKey.get(key) || [];
      list.push(row);
      existingByKey.set(key, list);
    });
  }));

  const toPut: PricePoint[] = [];
  const duplicateIdsToDelete = new Set<number>();
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  dedupedRows.forEach(row => {
    const portfolioId = normalizePortfolioId(row.portfolioId);
    const instrumentId = row.instrumentId
      || instrumentLookupByPortfolio.get(portfolioId)?.get(row.ticker)
      || undefined;
    const nextRow: PricePoint = {
      ...row,
      id: undefined,
      portfolioId,
      instrumentId,
      currency: (row.currency || Currency.CHF) as Currency
    };
    const key = toPriceKey(nextRow);
    const existingRows = (existingByKey.get(key) || []).slice().sort((a, b) => (a.id || 0) - (b.id || 0));
    const keeper = existingRows[0];
    existingRows.slice(1).forEach(existing => {
      if (typeof existing.id === 'number') duplicateIdsToDelete.add(existing.id);
    });

    if (!keeper) {
      created += 1;
      toPut.push(nextRow);
      return;
    }

    const mergedRow: PricePoint = {
      ...nextRow,
      id: keeper.id,
      instrumentId: nextRow.instrumentId || keeper.instrumentId
    };

    if (samePriceRow(keeper, mergedRow)) {
      unchanged += 1;
      return;
    }

    updated += 1;
    toPut.push(mergedRow);
  });

  await db.transaction('rw', db.prices, async () => {
    if (toPut.length > 0) await db.prices.bulkPut(toPut);
    if (duplicateIdsToDelete.size > 0) await db.prices.bulkDelete(Array.from(duplicateIdsToDelete.values()));
  });

  return {
    received: rows.length,
    deduped: dedupedRows.length,
    created,
    updated,
    unchanged,
    deletedDuplicates: duplicateIdsToDelete.size,
    written: created + updated
  };
};

export const upsertFxRowsByNaturalKey = async (rows: FxRateRow[]): Promise<NaturalKeyWriteSummary> => {
  if (!rows.length) {
    return { received: 0, deduped: 0, created: 0, updated: 0, unchanged: 0, deletedDuplicates: 0, written: 0 };
  }

  const normalizedInput = rows
    .filter(row => row?.baseCurrency && row?.quoteCurrency && row?.date)
    .map(row => ({
      ...row,
      date: normalizeDateKey(row.date) || row.date
    }))
    .filter(row => Boolean(row.date));
  const dedupedMap = new Map<string, FxRateRow>();
  normalizedInput.forEach(row => {
    dedupedMap.set(toFxKey(row), row);
  });
  const dedupedRows = Array.from(dedupedMap.values());

  const existingByKey = new Map<string, FxRateRow[]>();
  const groups = new Map<string, FxRateRow[]>();
  dedupedRows.forEach(row => {
    const groupKey = `${row.baseCurrency}|${row.quoteCurrency}`;
    const list = groups.get(groupKey) || [];
    list.push(row);
    groups.set(groupKey, list);
  });

  await Promise.all(Array.from(groups.entries()).map(async ([groupKey, groupRows]) => {
    const [baseCurrency, quoteCurrency] = groupKey.split('|') as [Currency, Currency];
    const dates = groupRows.map(row => row.date).sort();
    const existing = await db.fxRates
      .where('[baseCurrency+quoteCurrency+date]')
      .between([baseCurrency, quoteCurrency, dates[0]], [baseCurrency, quoteCurrency, `${dates[dates.length - 1]}\uffff`])
      .toArray();
    existing.forEach(row => {
      const key = toFxKey(row);
      const list = existingByKey.get(key) || [];
      list.push(row as FxRateRow);
      existingByKey.set(key, list);
    });
  }));

  const toPut: Array<FxRateRow & { id?: number }> = [];
  const duplicateIdsToDelete = new Set<number>();
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  dedupedRows.forEach(row => {
    const key = toFxKey(row);
    const existingRows = (existingByKey.get(key) || []).slice().sort((a: any, b: any) => ((a.id || 0) - (b.id || 0)));
    const keeper = existingRows[0] as (FxRateRow & { id?: number }) | undefined;
    existingRows.slice(1).forEach((existing: any) => {
      if (typeof existing.id === 'number') duplicateIdsToDelete.add(existing.id);
    });

    if (!keeper) {
      created += 1;
      toPut.push({ ...row });
      return;
    }

    const mergedRow = {
      ...row,
      id: keeper.id
    };

    if (sameFxRow(keeper, mergedRow)) {
      unchanged += 1;
      return;
    }

    updated += 1;
    toPut.push(mergedRow);
  });

  await db.transaction('rw', db.fxRates, async () => {
    if (toPut.length > 0) await db.fxRates.bulkPut(toPut);
    if (duplicateIdsToDelete.size > 0) await db.fxRates.bulkDelete(Array.from(duplicateIdsToDelete.values()));
  });

  return {
    received: rows.length,
    deduped: dedupedRows.length,
    created,
    updated,
    unchanged,
    deletedDuplicates: duplicateIdsToDelete.size,
    written: created + updated
  };
};
