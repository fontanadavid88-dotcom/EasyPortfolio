export type FetchJsonDiagnostics = {
  httpStatus: number;
  ok: boolean;
  contentType?: string;
  rawPreview: string;
  parseError?: string;
  json?: unknown;
};

export const toNum = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let normalized = trimmed.replace(/\s+/g, '');
  if (normalized.includes(',') && !normalized.includes('.')) {
    normalized = normalized.replace(',', '.');
  } else {
    normalized = normalized.replace(/,/g, '');
  }
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

export const fetchJsonWithDiagnostics = async (
  url: string,
  options?: RequestInit
): Promise<FetchJsonDiagnostics> => {
  const res = await fetch(url, options);
  const raw = await res.text();
  const rawPreview = raw.slice(0, 500);
  let json: unknown = undefined;
  let parseError: string | undefined;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }
  return {
    httpStatus: res.status,
    ok: res.ok,
    contentType: res.headers.get('content-type') || undefined,
    rawPreview,
    parseError,
    json
  };
};
