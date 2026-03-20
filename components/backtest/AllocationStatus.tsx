import React from 'react';
import clsx from 'clsx';

export const AllocationStatus: React.FC<{
  total: number;
  onNormalize: () => void;
  canNormalize: boolean;
}> = ({ total, onNormalize, canNormalize }) => {
  const delta = total - 100;
  const status = Math.abs(delta) < 0.01 ? 'ok' : delta < 0 ? 'low' : 'high';
  const badgeClass = status === 'ok'
    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : status === 'low'
      ? 'bg-amber-50 text-amber-700 border-amber-200'
      : 'bg-rose-50 text-rose-700 border-rose-200';
  const label = status === 'ok' ? 'Allocazione OK' : status === 'low' ? 'Allocazione sotto 100%' : 'Allocazione sopra 100%';

  return (
    <div className="ui-panel-subtle p-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <div className="flex items-center gap-3">
        <div className="text-sm text-slate-500">Somma allocazioni</div>
        <div className="text-2xl font-bold text-slate-900 tabular-nums">
          {total.toFixed(2)}%
        </div>
        <span className={clsx('text-[11px] uppercase tracking-wide font-semibold px-2 py-1 rounded-full border', badgeClass)}>
          {label}
        </span>
      </div>
      <button
        type="button"
        onClick={onNormalize}
        disabled={!canNormalize}
        className="ui-btn-ghost px-3 py-2 text-xs font-semibold border border-slate-200 bg-white disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Normalizza al 100%
      </button>
    </div>
  );
};
