import { BacktestAssetClass } from '../types';

export type BacktestCsvPreview = {
  detectedColumns: string[];
  rowCountRaw: number;
  rowCountValid: number;
  rowCountInvalid: number;
  duplicateDatesRemoved: number;
  firstDate?: string;
  lastDate?: string;
  inferredTicker?: string;
  inferredCurrency?: string;
  inferredName?: string;
  sampleRows: Array<{ date: string; close: number }>;
  errors: string[];
  warnings: string[];
};

export type BacktestCsvParsedRow = { date: string; close: number };

const REQUIRED_COLUMNS = ['date', 'close'];

const isYmd = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

const parseNumber = (raw: string): number | null => {
  const cleaned = raw.replace(/\s/g, '');
  if (!cleaned) return null;
  const normalized = cleaned.includes(',') && !cleaned.includes('.')
    ? cleaned.replace(',', '.')
    : cleaned;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
};

const splitCsvLine = (line: string): string[] => {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  result.push(current);
  return result.map(cell => cell.trim());
};

export const parseBacktestCsv = (text: string): { preview: BacktestCsvPreview; rows: BacktestCsvParsedRow[] } => {
  const errors: string[] = [];
  const warnings: string[] = [];
  const normalized = text.replace(/^\uFEFF/, '').trim();
  const lines = normalized.split(/\r?\n/).filter(l => l.trim().length > 0);

  if (lines.length === 0) {
    return {
      preview: {
        detectedColumns: [],
        rowCountRaw: 0,
        rowCountValid: 0,
        rowCountInvalid: 0,
        duplicateDatesRemoved: 0,
        sampleRows: [],
        errors: ['File CSV vuoto o non valido.'],
        warnings: []
      },
      rows: []
    };
  }

  const headerCells = splitCsvLine(lines[0]).map(c => c.toLowerCase());
  const detectedColumns = headerCells;

  REQUIRED_COLUMNS.forEach(col => {
    if (!detectedColumns.includes(col)) {
      errors.push(`Colonna obbligatoria mancante: ${col}`);
    }
  });

  const dateIdx = detectedColumns.indexOf('date');
  const closeIdx = detectedColumns.indexOf('close');
  const tickerIdx = detectedColumns.indexOf('ticker');
  const currencyIdx = detectedColumns.indexOf('currency');
  const nameIdx = detectedColumns.indexOf('name');

  const rowsMap = new Map<string, BacktestCsvParsedRow>();
  let invalidRows = 0;
  let duplicateDates = 0;
  let inferredTicker: string | undefined;
  let inferredCurrency: string | undefined;
  let inferredName: string | undefined;

  lines.slice(1).forEach(line => {
    const cells = splitCsvLine(line);
    const dateRaw = cells[dateIdx] || '';
    const closeRaw = cells[closeIdx] || '';
    const date = dateRaw.trim();
    const close = parseNumber(closeRaw);

    if (tickerIdx >= 0) {
      const t = (cells[tickerIdx] || '').trim();
      if (t && !inferredTicker) inferredTicker = t;
    }
    if (currencyIdx >= 0) {
      const c = (cells[currencyIdx] || '').trim();
      if (c && !inferredCurrency) inferredCurrency = c.toUpperCase();
    }
    if (nameIdx >= 0) {
      const n = (cells[nameIdx] || '').trim();
      if (n && !inferredName) inferredName = n;
    }

    if (!date || !isYmd(date) || close === null || close <= 0) {
      invalidRows += 1;
      return;
    }
    if (rowsMap.has(date)) {
      duplicateDates += 1;
    }
    rowsMap.set(date, { date, close });
  });

  const rows = Array.from(rowsMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  const rowCountRaw = Math.max(lines.length - 1, 0);
  const rowCountValid = rows.length;
  const rowCountInvalid = invalidRows;
  const firstDate = rows[0]?.date;
  const lastDate = rows[rows.length - 1]?.date;

  if (duplicateDates > 0) warnings.push(`Date duplicate rimosse: ${duplicateDates}`);
  if (rowCountInvalid > 0) warnings.push(`Righe invalide scartate: ${rowCountInvalid}`);

  const preview: BacktestCsvPreview = {
    detectedColumns,
    rowCountRaw,
    rowCountValid,
    rowCountInvalid,
    duplicateDatesRemoved: duplicateDates,
    firstDate,
    lastDate,
    inferredTicker,
    inferredCurrency,
    inferredName,
    sampleRows: rows.slice(0, 5),
    errors,
    warnings
  };

  return { preview, rows };
};

export const getBacktestAssetClassOptions = (): BacktestAssetClass[] => [
  'Equity',
  'Bond',
  'Gold',
  'Crypto',
  'Cash',
  'Other'
];
