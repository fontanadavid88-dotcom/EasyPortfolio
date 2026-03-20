import React, { useMemo, useState } from 'react';
import clsx from 'clsx';
import { Instrument, AssetClass, AssetType, Currency } from '../../types';
import { BacktestAssetInput, BacktestAssetClass, BacktestAssetQuality } from '../../services/backtestTypes';
import { getCanonicalTicker } from '../../services/financeUtils';

const ASSET_CLASS_OPTIONS: BacktestAssetClass[] = ['Equity', 'Bond', 'Gold', 'Crypto', 'Cash', 'Other'];

const mapInstrumentToAssetClass = (instrument: Instrument): BacktestAssetClass => {
  if (instrument.assetClass === AssetClass.CRYPTO || instrument.type === AssetType.Crypto) return 'Crypto';
  if (instrument.assetClass === AssetClass.CASH || instrument.type === AssetType.Cash) return 'Cash';
  if (instrument.assetClass === AssetClass.BOND || instrument.assetClass === AssetClass.ETF_BOND || instrument.type === AssetType.Bond) return 'Bond';
  if (instrument.assetClass === AssetClass.STOCK || instrument.assetClass === AssetClass.ETF_STOCK || instrument.type === AssetType.Stock || instrument.type === AssetType.ETF) return 'Equity';
  if (instrument.assetClass === AssetClass.ETC) {
    const name = instrument.name?.toLowerCase() || '';
    if (name.includes('gold') || name.includes('oro') || name.includes('xau')) return 'Gold';
    return 'Other';
  }
  return 'Other';
};

const buildAssetFromInstrument = (instrument: Instrument): BacktestAssetInput => ({
  ticker: getCanonicalTicker(instrument),
  name: instrument.name,
  allocationPct: 0,
  assetClass: mapInstrumentToAssetClass(instrument),
  currency: (instrument.preferredListing?.currency || instrument.currency || Currency.CHF) as Currency,
  source: 'DB',
  priceSource: 'DB'
});

const qualityLabel = (quality?: BacktestAssetQuality) => {
  if (!quality) return { text: '—', className: 'bg-slate-100 text-slate-500 border-slate-200' };
  if (quality.status === 'OK') return { text: 'OK', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
  if (quality.status === 'PARTIAL') return { text: 'Parziale', className: 'bg-amber-50 text-amber-700 border-amber-200' };
  if (quality.status === 'FX_MISSING') return { text: 'FX mancante', className: 'bg-rose-50 text-rose-700 border-rose-200' };
  return { text: 'Mancante', className: 'bg-rose-50 text-rose-700 border-rose-200' };
};

export const BacktestAssetsTable: React.FC<{
  assets: BacktestAssetInput[];
  instruments: Instrument[];
  onChange: (assets: BacktestAssetInput[]) => void;
  qualityByTicker?: Record<string, BacktestAssetQuality>;
}> = ({ assets, instruments, onChange, qualityByTicker }) => {
  const [selectedTicker, setSelectedTicker] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  const options = useMemo(() => {
    return instruments
      .map(inst => {
        const ticker = getCanonicalTicker(inst);
        return {
          ticker,
          label: `${ticker} · ${inst.name}`,
          instrument: inst
        };
      })
      .filter(opt => opt.ticker)
      .sort((a, b) => a.ticker.localeCompare(b.ticker));
  }, [instruments]);

  const handleAdd = () => {
    const trimmed = selectedTicker.trim();
    if (!trimmed) return;
    const exists = assets.some(a => a.ticker === trimmed);
    if (exists) {
      setAddError('Ticker già presente nel backtest.');
      return;
    }
    const match = options.find(opt => opt.ticker === trimmed);
    if (!match) {
      setAddError('Ticker non trovato.');
      return;
    }
    const next = [...assets, buildAssetFromInstrument(match.instrument)];
    onChange(next);
    setSelectedTicker('');
    setAddError(null);
  };

  const handleRemove = (ticker: string) => {
    onChange(assets.filter(a => a.ticker !== ticker));
  };

  const handleAllocationChange = (ticker: string, value: string) => {
    const nextVal = Number(value);
    onChange(assets.map(asset => asset.ticker === ticker ? { ...asset, allocationPct: Number.isFinite(nextVal) ? nextVal : 0 } : asset));
  };

  const handleAssetClassChange = (ticker: string, value: BacktestAssetClass) => {
    onChange(assets.map(asset => asset.ticker === ticker ? { ...asset, assetClass: value } : asset));
  };

  return (
    <div className="ui-panel-dense p-4 space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="flex-1">
          <label className="text-sm font-semibold text-slate-700">Aggiungi strumento</label>
          <div className="flex flex-col md:flex-row gap-2 mt-2">
            <input
              className="ui-input"
              list="backtest-instruments"
              value={selectedTicker}
              onChange={e => setSelectedTicker(e.target.value)}
              placeholder="Cerca ticker o nome"
            />
            <button type="button" onClick={handleAdd} className="ui-btn-secondary">
              Aggiungi strumento
            </button>
          </div>
          {addError && (
            <div className="text-xs text-amber-700 mt-2">{addError}</div>
          )}
          <datalist id="backtest-instruments">
            {options.map(opt => (
              <option key={opt.ticker} value={opt.ticker}>{opt.label}</option>
            ))}
          </datalist>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left">
          <thead className="text-xs uppercase text-slate-500 bg-slate-50">
            <tr>
              <th className="px-3 py-2">Ticker</th>
              <th className="px-3 py-2">Nome</th>
              <th className="px-3 py-2">Asset Class</th>
              <th className="px-3 py-2">Valuta</th>
              <th className="px-3 py-2 text-right">Allocazione %</th>
              <th className="px-3 py-2">Qualità dati</th>
              <th className="px-3 py-2 text-right">Azioni</th>
            </tr>
          </thead>
          <tbody>
            {assets.map(asset => {
              const quality = qualityByTicker?.[asset.ticker];
              const badge = qualityLabel(quality);
              return (
                <tr key={asset.ticker} className="border-t border-slate-200 hover:bg-slate-50">
                  <td className="px-3 py-3 font-semibold text-slate-700">{asset.ticker}</td>
                  <td className="px-3 py-3 text-slate-600">{asset.name}</td>
                  <td className="px-3 py-3">
                    <select
                      className="ui-input-sm"
                      value={asset.assetClass}
                      onChange={e => handleAssetClassChange(asset.ticker, e.target.value as BacktestAssetClass)}
                    >
                      {ASSET_CLASS_OPTIONS.map(opt => (
                        <option key={opt} value={opt}>{opt}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-3 text-slate-600">{asset.currency || '—'}</td>
                  <td className="px-3 py-3 text-right">
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      className="ui-input-sm text-right font-mono"
                      value={Number.isFinite(asset.allocationPct) ? asset.allocationPct : 0}
                      onChange={e => handleAllocationChange(asset.ticker, e.target.value)}
                    />
                  </td>
                  <td className="px-3 py-3">
                    <span className={clsx('text-[11px] uppercase tracking-wide font-semibold px-2 py-1 rounded-full border', badge.className)}>
                      {badge.text}
                    </span>
                    {quality?.message && (
                      <div className="text-[11px] text-slate-500 mt-1">{quality.message}</div>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right">
                    <button
                      type="button"
                      className="ui-btn-ghost px-2 py-1 text-xs"
                      onClick={() => handleRemove(asset.ticker)}
                    >
                      Rimuovi
                    </button>
                  </td>
                </tr>
              );
            })}
            {assets.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-slate-400">
                  Nessuno strumento selezionato.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
