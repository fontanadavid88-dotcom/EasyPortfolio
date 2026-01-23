const proc = (globalThis as any).process;
const isDev = proc?.env?.NODE_ENV !== 'production';
const devLog = (...args: unknown[]) => {
  if (!isDev) return;
  console.log('[eodhd-proxy]', ...args);
};

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

const buildJsonResponse = (payload: unknown, status = 200): Response => {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
};

const getRequestUrl = (req: any): URL => {
  const raw = req?.url || '';
  const full = raw.startsWith('http') ? raw : `http://localhost${raw}`;
  return new URL(full);
};

export default async function handler(req?: unknown, res?: any): Promise<Response | void> {
  const requestUrl = getRequestUrl(req);
  const path = requestUrl.searchParams.get('path') || '';
  if (!path || !path.startsWith('/')) {
    const body = JSON.stringify({ error: 'Missing or invalid path' });
    if (res && typeof res.status === 'function' && typeof res.send === 'function') {
      res.status(400).setHeader('content-type', 'application/json; charset=utf-8');
      res.send(body);
      return;
    }
    if (res && typeof res.setHeader === 'function' && typeof res.end === 'function') {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(body);
      return;
    }
    return buildJsonResponse({ error: 'Missing or invalid path' }, 400);
  }

  const headerKey = readHeader(req, 'x-eodhd-key') || readHeader(req, 'x-eodhd-api-key');
  const envKey = proc?.env?.EODHD_API_KEY as string | undefined;
  const apiKey = (headerKey || envKey || '').trim();
  if (!apiKey) {
    const body = JSON.stringify({ error: 'Missing EODHD key' });
    if (res && typeof res.status === 'function' && typeof res.send === 'function') {
      res.status(400).setHeader('content-type', 'application/json; charset=utf-8');
      res.send(body);
      return;
    }
    if (res && typeof res.setHeader === 'function' && typeof res.end === 'function') {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(body);
      return;
    }
    return buildJsonResponse({ error: 'Missing EODHD key' }, 400);
  }

  const upstreamUrl = new URL(`https://eodhd.com${path}`);
  requestUrl.searchParams.forEach((value, key) => {
    if (key === 'path') return;
    if (key === 'api_token') return;
    upstreamUrl.searchParams.append(key, value);
  });
  upstreamUrl.searchParams.set('api_token', apiKey);

  devLog('upstream', upstreamUrl.toString());
  const upstream = await fetch(upstreamUrl.toString(), {
    method: 'GET'
  });
  devLog('status', upstream.status);
  const upstreamType = upstream.headers.get('content-type') || '';
  const contentType = upstreamType.includes('application/json')
    ? 'application/json; charset=utf-8'
    : upstreamType || 'application/json; charset=utf-8';
  const buffer = await upstream.arrayBuffer();
  const body = new Uint8Array(buffer);

  if (res && typeof res.status === 'function' && typeof res.send === 'function') {
    res.status(upstream.status);
    res.setHeader('content-type', contentType);
    res.send(body);
    return;
  }

  if (res && typeof res.setHeader === 'function' && typeof res.end === 'function') {
    res.statusCode = upstream.status;
    res.setHeader('content-type', contentType);
    res.end(body);
    return;
  }

  return new Response(buffer, {
    status: upstream.status,
    headers: {
      'content-type': contentType
    }
  });
}
