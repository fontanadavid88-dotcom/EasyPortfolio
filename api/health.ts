const proc = (globalThis as any).process;

const readHeader = (req: any, name: string): string => {
  if (!req) return '';
  const headers = req.headers;
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    return headers.get(name) || '';
  }
  const direct = headers[name];
  if (direct) return String(direct);
  const lower = headers[name.toLowerCase()];
  return lower ? String(lower) : '';
};

export default function handler(req?: unknown, res?: any): Response | void {
  const envNames = ['EODHD_API_KEY', 'VITE_EODHD_API_KEY'] as const;
  const envKey = envNames.map(name => proc?.env?.[name] as string | undefined).find(Boolean) || '';
  const clientKey = readHeader(req, 'x-eodhd-key') || readHeader(req, 'x-eodhd-api-key');
  const hasEodhdKey = Boolean((envKey || clientKey).trim());
  const body = JSON.stringify({ ok: true, hasEodhdKey });

  if (res && typeof res.status === 'function' && typeof res.send === 'function') {
    res.status(200).setHeader('content-type', 'application/json; charset=utf-8');
    res.send(body);
    return;
  }

  if (res && typeof res.setHeader === 'function' && typeof res.end === 'function') {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(body);
    return;
  }

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}
