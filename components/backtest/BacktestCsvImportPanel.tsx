import React, { useMemo, useState } from 'react';
import { parseBacktestCsv, BacktestCsvPreview, getBacktestAssetClassOptions } from '../../services/backtestCsvImport';
import { saveBacktestImport } from '../../services/backtestImportRepository';
import { BacktestAssetClass } from '../../types';

export const BacktestCsvImportPanel: React.FC<{
  portfolioId: string;
  onClose: () => void;
}> = ({ portfolioId, onClose }) => {
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<BacktestCsvPreview | null>(null);
  const [rows, setRows] = useState<Array<{ date: string; close: number }>>([]);
  const [name, setName] = useState('');
  const [ticker, setTicker] = useState('');
  const [currency, setCurrency] = useState('');
  const [assetClass, setAssetClass] = useState<BacktestAssetClass>('Equity');
  const [notes, setNotes] = useState('');
  const [isSaving, setSaving] = useState(false);

  const hasErrors = Boolean(preview?.errors?.length);
  const canSave = Boolean(preview && rows.length > 0 && name.trim() && ticker.trim() && currency.trim() && !hasErrors);

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const parsed = parseBacktestCsv(text);
    setFileName(file.name);
    setPreview(parsed.preview);
    setRows(parsed.rows);
    setName(parsed.preview.inferredName || '');
    setTicker(parsed.preview.inferredTicker || '');
    setCurrency(parsed.preview.inferredCurrency || '');
  };

  const sampleRows = useMemo(() => preview?.sampleRows || [], [preview]);
  const assetClassOptions = useMemo(() => getBacktestAssetClassOptions(), []);

  const handleSave = async () => {
    if (!preview || !canSave) return;
    setSaving(true);
    try {
      await saveBacktestImport({
        portfolioId,
        preview,
        rows,
        meta: {
          name: name.trim(),
          ticker: ticker.trim(),
          currency: currency.trim().toUpperCase(),
          assetClass,
          notes: notes.trim() || undefined
        },
        originalFileName: fileName || 'import.csv'
      });
      setPreview(null);
      setRows([]);
      setFileName('');
      setName('');
      setTicker('');
      setCurrency('');
      setNotes('');
      setAssetClass('Equity');
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ui-panel-subtle p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-700">Importa CSV (1 file = 1 strumento)</div>
        <button type="button" onClick={onClose} className="ui-btn-ghost px-2 py-1 text-xs">Chiudi</button>
      </div>

      <div>
        <input type="file" accept=".csv" onChange={handleFileChange} className="text-sm" />
      </div>

      {preview && (
        <div className="space-y-3">
          <div className="ui-panel-dense p-3 text-xs text-slate-700 space-y-1">
            <div className="font-semibold">Preview file</div>
            <div>File: {fileName}</div>
            <div>Righe lette: {preview.rowCountRaw}</div>
            <div>Righe valide: {preview.rowCountValid}</div>
            <div>Righe scartate: {preview.rowCountInvalid}</div>
            <div>Date duplicate rimosse: {preview.duplicateDatesRemoved}</div>
            <div>Prima data: {preview.firstDate || '—'}</div>
            <div>Ultima data: {preview.lastDate || '—'}</div>
          </div>

          {preview.errors.length > 0 && (
            <div className="ui-panel-subtle border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 space-y-1">
              <div className="font-semibold">Errori</div>
              <ul className="list-disc pl-4">
                {preview.errors.map((err, idx) => <li key={idx}>{err}</li>)}
              </ul>
            </div>
          )}

          {preview.warnings.length > 0 && (
            <div className="ui-panel-subtle border-amber-200 bg-amber-50 p-3 text-xs text-amber-700 space-y-1">
              <div className="font-semibold">Avvisi</div>
              <ul className="list-disc pl-4">
                {preview.warnings.map((warn, idx) => <li key={idx}>{warn}</li>)}
              </ul>
            </div>
          )}

          <div className="ui-panel-subtle p-3 space-y-2 text-xs">
            <div className="font-semibold text-slate-700">Sample righe</div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-[11px] uppercase text-slate-500 bg-slate-50">
                  <tr>
                    <th className="px-2 py-1">Date</th>
                    <th className="px-2 py-1 text-right">Close</th>
                  </tr>
                </thead>
                <tbody>
                  {sampleRows.map((row, idx) => (
                    <tr key={`${row.date}-${idx}`} className="border-t border-slate-200">
                      <td className="px-2 py-1">{row.date}</td>
                      <td className="px-2 py-1 text-right">{row.close.toFixed(2)}</td>
                    </tr>
                  ))}
                  {sampleRows.length === 0 && (
                    <tr>
                      <td colSpan={2} className="px-2 py-2 text-center text-slate-400">Nessuna riga valida</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="ui-panel-subtle p-3 space-y-3">
            <div className="text-xs font-semibold text-slate-700">Metadata strumento</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-semibold text-slate-600">Nome</label>
                <input className="ui-input mt-1" value={name} onChange={e => setName(e.target.value)} placeholder="Nome strumento" />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-600">Ticker</label>
                <input className="ui-input mt-1" value={ticker} onChange={e => setTicker(e.target.value)} placeholder="Ticker" />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-600">Valuta</label>
                <input className="ui-input mt-1" value={currency} onChange={e => setCurrency(e.target.value.toUpperCase())} placeholder="USD" />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-600">Asset class</label>
                <select className="ui-input mt-1" value={assetClass} onChange={e => setAssetClass(e.target.value as BacktestAssetClass)}>
                  {assetClassOptions.map(opt => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              </div>
              <div className="md:col-span-2">
                <label className="text-xs font-semibold text-slate-600">Note (opzionale)</label>
                <input className="ui-input mt-1" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Note import" />
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button type="button" className="ui-btn-primary" onClick={handleSave} disabled={!canSave || isSaving}>
                {isSaving ? 'Salvataggio...' : 'Salva import'}
              </button>
              {!canSave && (
                <div className="text-xs text-slate-500">Compila i campi obbligatori e verifica che non ci siano errori.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
