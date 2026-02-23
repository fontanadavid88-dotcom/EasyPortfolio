import { fetchJsonWithDiagnostics, FetchJsonDiagnostics } from './diagnostics';

export type ProxyHealthMode = 'vercel-proxy' | 'direct-local-key' | 'no-key' | 'unknown';

export type ProxyHealth = {
  ok: boolean;
  tested: boolean;
  hasEodhdKey: boolean;
  usingLocalKey: boolean;
  mode: ProxyHealthMode;
  message?: string;
  diag?: FetchJsonDiagnostics;
};

type CheckProxyHealthOptions = {
  eodhdApiKey?: string;
  timeoutMs?: number;
  force?: boolean;
};

const HEALTH_ENDPOINT = '/api/health';
const DEFAULT_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 30_000;

let cached: { health: ProxyHealth; at: number; usingLocalKey: boolean } | null = null;

export const clearProxyHealthCache = () => {
  cached = null;
};

const isHtmlResponse = (diag?: FetchJsonDiagnostics): boolean => {
  if (!diag) return false;
  const ct = (diag.contentType || '').toLowerCase();
  if (ct.includes('text/html')) return true;
  const preview = (diag.rawPreview || '').trim().toLowerCase();
  return preview.startsWith('<!doctype html') || preview.startsWith('<html');
};

const proxyHelp = 'Avvia `npm run dev:vercel` oppure verifica il deploy del proxy /api.';

const buildFailureMessage = (diag?: FetchJsonDiagnostics, reason?: 'timeout' | 'network'): string => {
  if (reason === 'timeout') return `Timeout nel test del proxy /api. ${proxyHelp}`;
  if (diag?.httpStatus) {
    if (diag.httpStatus === 404 || isHtmlResponse(diag)) {
      return `Proxy /api non raggiungibile (404). ${proxyHelp}`;
    }
    return `Proxy /api non raggiungibile (HTTP ${diag.httpStatus}). ${proxyHelp}`;
  }
  return `Proxy /api non raggiungibile. ${proxyHelp}`;
};

export const checkProxyHealth = async (opts?: CheckProxyHealthOptions): Promise<ProxyHealth> => {
  const usingLocalKey = Boolean(opts?.eodhdApiKey?.trim());
  const now = Date.now();
  if (!opts?.force && cached && now - cached.at < CACHE_TTL_MS && cached.usingLocalKey === usingLocalKey) {
    return cached.health;
  }

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let diag: FetchJsonDiagnostics | undefined;
  let ok = false;
  let hasEodhdKey = false;
  let message: string | undefined;

  try {
    const headers = usingLocalKey ? { 'x-eodhd-key': opts?.eodhdApiKey?.trim() || '' } : undefined;
    diag = await fetchJsonWithDiagnostics(
      HEALTH_ENDPOINT,
      headers ? { headers, signal: controller.signal } : { signal: controller.signal }
    );
    const jsonOk = diag.ok && diag.json && typeof diag.json === 'object';
    ok = Boolean(jsonOk);
    if (jsonOk) {
      const obj = diag.json as Record<string, unknown>;
      hasEodhdKey = Boolean(obj.hasEodhdKey);
    } else {
      message = buildFailureMessage(diag);
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      message = buildFailureMessage(diag, 'timeout');
    } else {
      message = buildFailureMessage(diag, 'network');
    }
  } finally {
    clearTimeout(timeoutId);
  }

  let mode: ProxyHealthMode = 'unknown';
  if (ok) {
    mode = (hasEodhdKey || usingLocalKey) ? 'vercel-proxy' : 'no-key';
  } else {
    mode = usingLocalKey ? 'direct-local-key' : 'no-key';
  }

  if (ok && !hasEodhdKey && !usingLocalKey) {
    message = 'Chiave EODHD mancante. Inseriscila in Settings o in `.env.local` e riavvia il dev server.';
  }

  const health: ProxyHealth = {
    ok,
    tested: true,
    hasEodhdKey,
    usingLocalKey,
    mode,
    message,
    diag
  };

  cached = { health, at: now, usingLocalKey };

  if (import.meta.env?.DEV) {
    console.log('[API][Health]', {
      ok,
      mode,
      usingLocalKey,
      hasEodhdKey,
      httpStatus: diag?.httpStatus,
      contentType: diag?.contentType
    });
  }

  return health;
};
