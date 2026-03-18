import React, { useMemo } from 'react';
import { Transaction, Instrument, PricePoint } from '../types';
import { computeHoldingsPriceDateStats } from '../services/dataFreshness';
import { diffDaysYmd } from '../services/dateUtils';
import { InfoPopover } from './InfoPopover';

type DataStatusBarProps = {
  portfolioId: string;
  transactions: Transaction[];
  instruments: Instrument[];
  prices: PricePoint[];
  fxUsed?: string;
  variant?: 'default' | 'rebalance';
  rebalanceDate?: string;
  usedPriceDates?: { ticker: string; date?: string }[];
};

const safeGet = (key: string): string | null => {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const formatDateTime = (iso?: string | null) => {
  if (!iso) return 'mai';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString('it-IT');
};

export const DataStatusBar: React.FC<DataStatusBarProps> = ({
  portfolioId,
  transactions,
  instruments,
  prices,
  fxUsed,
  variant = 'default',
  rebalanceDate,
  usedPriceDates
}) => {
  const stats = useMemo(
    () => computeHoldingsPriceDateStats(transactions || [], instruments || [], prices || []),
    [transactions, instruments, prices]
  );
  const lastSyncAt = safeGet(`prices:lastSyncAt:${portfolioId}`);
  const lastBackfillAt = safeGet(`prices:lastBackfillAt:${portfolioId}`);

  const priceCommon = stats.priceCommonAsOf;
  const priceLatest = stats.priceLatestAsOf;

  const hasUsedDates = Boolean(
    variant === 'rebalance'
    && rebalanceDate
    && usedPriceDates
    && usedPriceDates.length > 0
  );

  const derivedStale = useMemo(() => {
    if (!hasUsedDates || !rebalanceDate || !usedPriceDates) return stats.staleTickers;
    return usedPriceDates
      .filter(entry => entry.date && entry.date < rebalanceDate)
      .map(entry => ({
        ticker: entry.ticker,
        canonical: entry.ticker,
        lastDate: entry.date as string,
        lagDays: diffDaysYmd(rebalanceDate, entry.date as string)
      }));
  }, [hasUsedDates, rebalanceDate, usedPriceDates, stats.staleTickers]);

  const derivedMissing = useMemo(() => {
    if (!hasUsedDates || !usedPriceDates) return stats.missingTickers;
    return usedPriceDates
      .filter(entry => !entry.date)
      .map(entry => ({ ticker: entry.ticker, canonical: entry.ticker }));
  }, [hasUsedDates, usedPriceDates, stats.missingTickers]);

  const hasCommonDetail = Boolean(priceCommon && priceLatest && priceCommon !== priceLatest);
  const rebalancePriceLabel = rebalanceDate || priceLatest || 'N/D';

  return (
    <div className="ui-panel-subtle px-3 py-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
        {variant === 'rebalance' ? (
          <>
            <span className="px-2 py-1 rounded-full bg-white border border-slate-200 text-slate-700 font-semibold">
              Prezzi (rebalance): {rebalancePriceLabel}
            </span>
            {hasCommonDetail && (
              <InfoPopover
                ariaLabel="Dettagli date prezzi"
                title="Dettagli prezzi"
                triggerContent={<span className="px-2 py-1 rounded-full bg-slate-100 text-slate-600 border border-slate-200">Dettagli</span>}
                triggerClassName="p-0 rounded-full focus:outline-none focus:ring-2 focus:ring-primary"
                renderContent={() => (
                  <div className="text-xs text-slate-600">
                    Prezzi (comune): <span className="font-semibold text-slate-900">{priceCommon}</span>
                  </div>
                )}
              />
            )}
          </>
        ) : (
          <>
            {priceCommon || priceLatest ? (
              priceCommon && priceLatest && priceCommon !== priceLatest ? (
                <>
                  <span className="px-2 py-1 rounded-full bg-white border border-slate-200 text-slate-700 font-semibold">
                    Prezzi (comune): {priceCommon}
                  </span>
                  <span className="px-2 py-1 rounded-full bg-white border border-slate-200 text-slate-700 font-semibold">
                    Ultimo: {priceLatest}
                  </span>
                </>
              ) : (
                <span className="px-2 py-1 rounded-full bg-white border border-slate-200 text-slate-700 font-semibold">
                  Prezzi: {priceCommon || priceLatest}
                </span>
              )
            ) : (
              <span className="px-2 py-1 rounded-full bg-white border border-slate-200 text-slate-500">
                Prezzi: N/D
              </span>
            )}
          </>
        )}

        {derivedStale.length > 0 && (
          <InfoPopover
            ariaLabel="Dettagli prezzi indietro"
            title="Prezzi indietro"
            triggerContent={
              <span className="px-2 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200 font-bold">
                {derivedStale.length} indietro
              </span>
            }
            triggerClassName="p-0 rounded-full focus:outline-none focus:ring-2 focus:ring-primary"
            renderContent={() => (
              <div className="space-y-1 text-xs">
                {derivedStale.slice(0, 8).map((item) => (
                  <div key={`${item.ticker}-${item.lastDate}`} className="flex items-center justify-between">
                    <span className="font-semibold text-slate-800">{item.ticker}</span>
                    <span className="text-slate-600">{item.lastDate} (-{item.lagDays} g)</span>
                  </div>
                ))}
                {derivedStale.length > 8 && (
                  <div className="text-slate-500">+ altri {derivedStale.length - 8}</div>
                )}
              </div>
            )}
          />
        )}

        {derivedMissing.length > 0 && (
          <InfoPopover
            ariaLabel="Dettagli prezzi mancanti"
            title="Prezzi mancanti"
            triggerContent={
              <span className="px-2 py-1 rounded-full bg-rose-50 text-rose-700 border border-rose-200 font-bold">
                {derivedMissing.length} mancanti
              </span>
            }
            triggerClassName="p-0 rounded-full focus:outline-none focus:ring-2 focus:ring-primary"
            renderContent={() => (
              <div className="space-y-1 text-xs">
                {derivedMissing.slice(0, 8).map((item) => (
                  <div key={`${item.ticker}-${item.canonical}`} className="flex items-center justify-between">
                    <span className="font-semibold text-slate-800">{item.ticker}</span>
                    <span className="text-slate-500">{item.canonical}</span>
                  </div>
                ))}
                {derivedMissing.length > 8 && (
                  <div className="text-slate-500">+ altri {derivedMissing.length - 8}</div>
                )}
              </div>
            )}
          />
        )}

        <span className="px-2 py-1 rounded-full bg-white border border-slate-200 text-slate-700">
          FX (usato): {fxUsed || 'N/D'}
        </span>
        <span className="px-2 py-1 rounded-full bg-white border border-slate-200 text-slate-700">
          Sync: {formatDateTime(lastSyncAt)}
        </span>
        <span className="px-2 py-1 rounded-full bg-white border border-slate-200 text-slate-700">
          Backfill: {formatDateTime(lastBackfillAt)}
        </span>
      </div>
    </div>
  );
};
